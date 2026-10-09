import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { REVIEWER_PROFILE } from "../src/agents.ts";
import { runDelegate } from "../src/runner.ts";

const exec = promisify(execFile);
const child = resolve("test/fixtures/real-pi-mcp-child.mjs");
const server = resolve("test/fixtures/real-pi-mcp-server.mjs");
await chmod(child, 0o755);
const pause = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function waitFor(path, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  do {
    try { return await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await pause(20);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${path}`);
}
async function processes() {
  const { stdout } = await exec("ps", ["-eo", "pid=,pgid=,sess=,stat="], { timeout: 1_000, maxBuffer: 1024 * 1024 });
  return stdout.trim().split("\n").map(line => {
    const [pid, pgid, sid, stat] = line.trim().split(/\s+/);
    return { pid: Number(pid), pgid: Number(pgid), sid: Number(sid), stat };
  });
}
async function sessionMembers(sid) {
  return (await processes()).filter(row => row.sid === sid && !row.stat.startsWith("Z"));
}
async function inventory(path) {
  return (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

// Linux ps exposes real numeric SIDs. Native macOS lifecycle checks remain in
// runner.test.mjs; these fixtures deliberately test Linux monitor-mode regrouping.
for (const scenario of ["answer", "cancel", "deadline"]) {
  test(`real Pi 1.1 codemode + contained MCP: ${scenario}, TERM/EOF-resistant regrouped descendants`, {
    skip: process.platform !== "linux", timeout: 20_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegator-real-mcp-"));
    const cwd = join(directory, "workspace");
    const agentDir = join(directory, "agent");
    const evidence = join(directory, "evidence.json");
    const pidLog = join(directory, "pids.jsonl");
    const controller = new AbortController();
    let run;
    let identity;
    // This watchdog is a test safeguard, NOT an implicit production run budget.
    const watchdog = setTimeout(() => controller.abort(), 12_000);
    try {
      await Promise.all([mkdir(cwd), mkdir(agentDir)]);
      await writeFile(join(cwd, "allowed.txt"), "allowed-read\n");
      await mkdir(join(cwd, ".pi"));
      // An untrusted project must not override the isolated user-level server.
      await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { tiny: { command: "/should-not-be-launched" } } }));
      await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
        tiny: { command: process.execPath, args: [server], exposure: "codemode", timeout: 5 },
      } }));
      run = runDelegate({
        profile: { ...REVIEWER_PROFILE, tools: ["read", "bash", "codemode", "tool_search"], extensions: ["builtin:codemode", "builtin:tool-search", "builtin:mcp"],
          // Config's public deadlineMs is normalized to timeoutMs on DelegateProfile.
          ...(scenario === "deadline" ? { timeoutMs: 8_000 } : {}) },
        task: "Exercise real codemode and MCP without a network provider", cwd,
        model: "deterministic/mock", signal: controller.signal,
        cleanupGraceMs: 100, exitDrainMs: 50,
        env: { ...process.env, PI_DELEGATOR_PI_BINARY: child, PI_CODING_AGENT_DIR: agentDir,
          REAL_PI_MCP_SCENARIO: scenario, REAL_PI_MCP_HOSTILE: "1", REAL_PI_MCP_INVENTORY: pidLog,
          REAL_PI_MCP_EVIDENCE: evidence },
      });
      // Racing the run exposes fixture startup errors immediately instead of
      // waiting for a file that a failed child can never write.
      const observed = await Promise.race([
        waitFor(evidence).then(text => ({ evidence: JSON.parse(text) })),
        run.then(result => ({ result })),
      ]);
      if (observed.result) {
        assert.equal(observed.result.ok, true, JSON.stringify(observed.result));
      }
      const proof = observed.evidence ?? JSON.parse(await readFile(evidence, "utf8"));
      identity = JSON.parse(await readFile(`${evidence}.child`, "utf8"));
      assert.equal(proof.piVersion, "1.1.0");
      assert.equal(proof.requests, 2);
      assert.equal(proof.searchResult.isError, false);
      assert.match(JSON.stringify(proof.searchResult.content), /mcp__tiny__echo/);
      assert.match(proof.bashDescription, /timeout stops this command group and returns a recoverable tool error/);
      const scriptOutput = proof.result.content.map(block => block.text ?? "").join("\n");
      assert.match(scriptOutput, /Script completed/);
      assert.match(scriptOutput, /allowed-read/);
      assert.match(scriptOutput, /overridden-bash/);
      assert.match(scriptOutput, /"writeAvailable":false/);
      assert.match(scriptOutput, /"writeRejected":true/);
      assert.match(scriptOutput, /mcp__tiny__echo/);
      assert.match(scriptOutput, /mcp:from-codemode/);
      assert.deepEqual(proof.result.nestedCalls.calls.map(call => [call.name, call.status]), [
        ["read", "ok"], ["bash", "ok"], ["mcp__tiny__echo", "ok"],
      ], "real Pi nested tool pipeline executed all three calls");
      await assert.rejects(readFile(join(cwd, "forbidden.txt")), { code: "ENOENT" });
      // The descendant may be a few scheduler ticks behind initialize/call.
      const end = Date.now() + 1_000;
      let recorded;
      do {
        recorded = await inventory(pidLog);
        if (recorded.some(row => row.kind === "descendant")) break;
        await pause(10);
      } while (Date.now() < end);
      const mcpServer = recorded.find(row => row.kind === "server");
      const descendant = recorded.find(row => row.kind === "descendant");
      assert(mcpServer && descendant, JSON.stringify(recorded));
      assert(recorded.some(row => row.kind === "call" && row.pid === mcpServer.pid));
      const parent = (await processes()).find(row => row.pid === process.pid);
      assert.notEqual(identity.sid, parent.sid);
      assert.equal(mcpServer.sid, identity.sid, "MCP server must not create a detached session");
      assert.equal(descendant.sid, identity.sid, "regrouping must stay in delegate SID");
      assert.notEqual(descendant.pgid, mcpServer.pgid, "descendant really regrouped");
      if (scenario === "cancel") controller.abort();
      const result = observed.result ?? await run;
      if (scenario === "answer") {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.text, "real Pi codemode MCP completed");
      } else {
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(result.code, scenario === "cancel" ? "cancelled" : "run_timeout");
      }
      const finalRecords = await inventory(pidLog);
      assert(finalRecords.some(row => row.kind === "term" && row.pid === mcpServer.pid), "server really ignored TERM");
      assert(finalRecords.some(row => row.kind === "eof" && row.pid === mcpServer.pid), "server really ignored stdin EOF");
      assert.equal(result.cleanup.killSent, true, JSON.stringify(result));
      assert.equal(result.nativeUsage.cost.total, 0, "mock provider made no paid calls");
      assert.equal(result.cleanup.processExited, true);
      assert.equal(result.cleanup.pipesClosed, true);
      assert.deepEqual(await sessionMembers(identity.sid), [], "no live delegate-session survivors");
      const alive = await processes();
      for (const row of [mcpServer, descendant]) {
        assert(!alive.some(p => p.pid === row.pid && !p.stat.startsWith("Z")), `PID ${row.pid} survived`);
      }
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      if (run) await run;
      // Failed assertions must not leak fixture children. Only signal the
      // captured, distinct SID and never arbitrary inherited process groups.
      if (!identity) {
        try { identity = JSON.parse(await readFile(`${evidence}.child`, "utf8")); } catch {}
      }
      if (identity) {
        const parent = (await processes()).find(row => row.pid === process.pid);
        if (identity.sid > 0 && identity.sid !== parent.sid) {
          for (const row of await sessionMembers(identity.sid)) {
            try { process.kill(row.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

// Cancel at request arrival, not after the provider's completed-tool evidence.
for (const stage of ["initialize", "call"]) {
  test(`real Pi contained MCP: cancel while ${stage} is pending`, {
    skip: process.platform !== "linux", timeout: 20_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegator-real-mcp-stall-"));
    const cwd = join(directory, "workspace");
    const agentDir = join(directory, "agent");
    const evidence = join(directory, "evidence.json");
    const pidLog = join(directory, "pids.jsonl");
    const controller = new AbortController();
    let run;
    let identity;
    const watchdog = setTimeout(() => controller.abort(), 12_000);
    try {
      await Promise.all([mkdir(cwd), mkdir(agentDir)]);
      await writeFile(join(cwd, "allowed.txt"), "allowed-read\n");
      await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
        tiny: { command: process.execPath, args: [server], exposure: "codemode", timeout: 30 },
      } }));
      run = runDelegate({
        profile: { ...REVIEWER_PROFILE, tools: ["read", "bash", "codemode", "tool_search"],
          extensions: ["builtin:codemode", "builtin:tool-search", "builtin:mcp"] },
        task: "Exercise real pending MCP cancellation without a network provider", cwd,
        model: "deterministic/mock", signal: controller.signal,
        cleanupGraceMs: 100, exitDrainMs: 50,
        env: { ...process.env, PI_DELEGATOR_PI_BINARY: child, PI_CODING_AGENT_DIR: agentDir,
          REAL_PI_MCP_SCENARIO: "cancel", REAL_PI_MCP_STALL: stage, REAL_PI_MCP_HOSTILE: "1",
          REAL_PI_MCP_INVENTORY: pidLog, REAL_PI_MCP_EVIDENCE: evidence },
      });
      const observed = await Promise.race([
        (async () => {
          identity = JSON.parse(await waitFor(`${evidence}.child`));
          await waitFor(pidLog);
          const end = Date.now() + 8_000;
          do {
            const recorded = await inventory(pidLog);
            if (recorded.some(row => row.kind === stage)) return { recorded };
            await pause(20);
          } while (Date.now() < end);
          throw new Error(`Timed out waiting for MCP ${stage} request`);
        })(),
        run.then(result => ({ result })),
      ]);
      assert(observed.recorded, `delegate settled before pending request: ${JSON.stringify(observed.result)}`);
      assert.equal(controller.signal.aborted, false, "request arrived before watchdog cancellation");
      const mcpServer = observed.recorded.find(row => row.kind === "server");
      const descendant = observed.recorded.find(row => row.kind === "descendant");
      assert(mcpServer && descendant, JSON.stringify(observed.recorded));
      assert(observed.recorded.some(row => row.kind === stage && row.pid === mcpServer.pid));
      const parent = (await processes()).find(row => row.pid === process.pid);
      assert.notEqual(identity.sid, parent.sid);
      assert.equal(mcpServer.sid, identity.sid);
      assert.equal(descendant.sid, identity.sid);
      assert.notEqual(descendant.pgid, mcpServer.pgid, "descendant really regrouped");
      await assert.rejects(readFile(evidence), { code: "ENOENT" });
      controller.abort();
      const result = await run;
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.code, "cancelled");
      assert.equal(result.cleanup.killSent, true, JSON.stringify(result));
      assert.equal(result.cleanup.processExited, true);
      assert.equal(result.cleanup.pipesClosed, true);
      assert.equal(result.nativeUsage.cost.total, 0, "mock provider made no paid calls");
      const finalRecords = await inventory(pidLog);
      assert(finalRecords.some(row => row.kind === "term" && row.pid === mcpServer.pid), "server really ignored TERM");
      assert(finalRecords.some(row => row.kind === "eof" && row.pid === mcpServer.pid), "server really ignored stdin EOF");
      assert.deepEqual(await sessionMembers(identity.sid), [], "no live delegate-session survivors");
      const alive = await processes();
      for (const row of [mcpServer, descendant]) {
        assert(!alive.some(p => p.pid === row.pid && !p.stat.startsWith("Z")), `PID ${row.pid} survived`);
      }
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      if (run) await run;
      if (!identity) {
        try { identity = JSON.parse(await readFile(`${evidence}.child`, "utf8")); } catch {}
      }
      if (identity) {
        const parent = (await processes()).find(row => row.pid === process.pid);
        if (identity.sid > 0 && identity.sid !== parent.sid) {
          for (const row of await sessionMembers(identity.sid)) {
            try { process.kill(row.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
