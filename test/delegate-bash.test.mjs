import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { createBashTool } from "@earendil-works/pi-coding-agent";
import { createDelegateBashOperations } from "../src/delegate-bash-extension.ts";

const ops = createDelegateBashOperations((code) => {
  throw new Error(`unexpected delegate exit ${code}`);
});
const cwd = process.cwd();
const options = (onData, timeout) => ({ onData, timeout, env: process.env });

// Exercise the installed adapter as well as the operations: only thrown errors
// (not an isError return field) are surfaced as recoverable tool failures.
test("timeout returns an ordinary Pi tool error and a later command succeeds", async () => {
  const tool = createBashTool(cwd, { operations: ops });
  await assert.rejects(tool.execute("first", { command: "sleep 10", timeout: 0.08 }),
    /Command timed out after 0.08 seconds/);
  const result = await tool.execute("second", { command: "printf recovered" });
  assert.match(result.content[0].text, /recovered/);
});

test("TERM-resistant descendant is killed before timeout is reported", async () => {
  let output = "";
  await assert.rejects(ops.exec("bash -c 'trap \"\" TERM; while :; do sleep 1; done' & echo $!; wait", cwd,
    options((chunk) => { output += chunk.toString(); }, 0.15)), /timeout:0.15/);
  const pid = Number(output.trim().split("\n")[0]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, output);
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  assert.ok(state.status === 0 || state.status === 1);
  assert.ok(!state.stdout.trim() || state.stdout.trim().startsWith("Z"), state.stdout);
});

test("timeout does not terminate a prior command's background job", async () => {
  let output = "";
  await ops.exec("sleep .8 & echo $!", cwd, options((chunk) => { output += chunk.toString(); }));
  const pid = Number(output.trim().split("\n")[0]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, output);
  await assert.rejects(ops.exec("sleep 10", cwd, options(() => {}, 0.08)), /timeout:0.08/);
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  assert.equal(state.status, 0);
  assert.ok(state.stdout.trim() && !state.stdout.trim().startsWith("Z"), state.stdout);
});

test("ordinary nonzero exit remains recoverable", async () => {
  const tool = createBashTool(cwd, { operations: ops });
  await assert.rejects(tool.execute("first", { command: "printf bad; exit 7" }),
    /bad[\s\S]*Command exited with code 7/);
  assert.match((await tool.execute("second", { command: "echo good" })).content[0].text, /good/);
});

test("a command that exits before its timeout can drain trailing pipes normally", async () => {
  const result = await ops.exec("sleep .4 & printf done", cwd, options(() => {}, 0.08));
  assert.equal(result.exitCode, 0);
});

test("supervisor containment ignores inherited functions but the command retains its environment", async () => {
  let output = "";
  const result = await ops.exec("printf '%s' \"$CUSTOM_VALUE\"", cwd, {
    onData: (chunk) => { output += chunk.toString(); },
    env: {
      ...process.env,
      "BASH_FUNC_wait%%": "() { exit 99; }",
      "BASH_FUNC_bash%%": "() { exit 98; }",
      CUSTOM_VALUE: "command environment",
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(output, "command environment");
});

test("post-exit output drainage is fixed even with an inherited pipe", async () => {
  let output = "";
  let callbacks = 0;
  let settled = false;
  const started = Date.now();
  const result = await ops.exec("(sleep .6; echo late) & printf ready", cwd,
    options((chunk) => {
      if (settled) callbacks += 1;
      output += chunk.toString();
    }));
  settled = true;
  assert.equal(result.exitCode, 0);
  assert.match(output, /ready/);
  assert.ok(Date.now() - started < 400, `drain took ${Date.now() - started}ms`);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(callbacks, 0);
});
