import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { SCOUT_PROFILE } from "../src/agents.ts";
import { isSupportedPlatform, runDelegate } from "../src/runner.ts";

const fixture = resolve("test/fixtures/fake-pi.mjs");
await chmod(fixture, 0o755);

async function withTempDir(fn) {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-test-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fixtureEnv(scenario, extra = {}) {
  return {
    ...process.env,
    PI_DELEGATOR_PI_BINARY: fixture,
    FAKE_PI_SCENARIO: scenario,
    ...extra,
  };
}

test("returns a clean terminal answer and launches Scout with isolated arguments", async () => {
  await withTempDir(async (cwd) => {
    const recordPath = join(cwd, "args.json");
    const promptModePath = join(cwd, "prompt-mode.txt");
    const childCwdPath = join(cwd, "child-cwd.txt");
    const updates = [];
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "Inspect auth",
      cwd,
      model: "example/model",
      onAssistantText: (text) => updates.push(text),
      env: fixtureEnv("clean", {
        FAKE_PI_RECORD_PATH: recordPath,
        FAKE_PI_PROMPT_MODE_PATH: promptModePath,
        FAKE_PI_CWD_PATH: childCwdPath,
      }),
      cleanupGraceMs: 50,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, "Scout result");
    assert.deepEqual(updates, ["Scout result"]);

    const args = JSON.parse(await readFile(recordPath, "utf8"));
    assert.deepEqual(args.slice(0, 6), ["--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills"]);
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("example/model"));
    assert.ok(args.includes("--thinking"));
    assert.ok(args.includes("low"));
    assert.ok(args.includes("read,grep,find,ls"));
    assert.equal(args.at(-1), "Task: Inspect auth");
    assert.equal(await readFile(promptModePath, "utf8"), String(0o600));
    assert.equal(await readFile(childCwdPath, "utf8"), await realpath(cwd));

    const promptIndex = args.indexOf("--append-system-prompt");
    assert.notEqual(promptIndex, -1);
    await assert.rejects(readFile(args[promptIndex + 1], "utf8"));
  });
});

test("parses split UTF-8 JSONL output", async () => {
  await withTempDir(async (cwd) => {
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "Split output",
      cwd,
      env: fixtureEnv("split"),
      cleanupGraceMs: 50,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, "split ✓");
  });
});

test("reports exit before a terminal answer", async () => {
  await withTempDir(async (cwd) => {
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "No answer",
      cwd,
      env: fixtureEnv("no-answer"),
      cleanupGraceMs: 50,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "missing_terminal_answer");
  });
});

test("reports assistant/model errors", async () => {
  await withTempDir(async (cwd) => {
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "Model error",
      cwd,
      env: fixtureEnv("assistant-error"),
      cleanupGraceMs: 50,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "child_error");
    assert.match(result.message, /fixture model error/);
  });
});

test("wall-clock timeout signals the child and settles within cleanup grace", async () => {
  await withTempDir(async (cwd) => {
    const signalPath = join(cwd, "signals.txt");
    const profile = { ...SCOUT_PROFILE, timeoutMs: 250 };
    const started = Date.now();
    const result = await runDelegate({
      profile,
      task: "Hang",
      cwd,
      env: fixtureEnv("hang", { FAKE_PI_SIGNAL_PATH: signalPath }),
      cleanupGraceMs: 100,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "run_timeout");
    assert.ok(Date.now() - started < 1_000, "timeout must remain bounded");
    assert.match(await readFile(signalPath, "utf8"), /SIGTERM/);
  });
});

test("wall-clock deadline includes startup and can prevent launch", async () => {
  await withTempDir(async (cwd) => {
    const recordPath = join(cwd, "args.json");
    const result = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 0 },
      task: "Do not launch",
      cwd,
      env: fixtureEnv("clean", { FAKE_PI_RECORD_PATH: recordPath }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "run_timeout");
    await assert.rejects(readFile(recordPath, "utf8"));
  });
});

test("already-aborted parent signal prevents launch", async () => {
  await withTempDir(async (cwd) => {
    const recordPath = join(cwd, "args.json");
    const controller = new AbortController();
    controller.abort();
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "Do not launch",
      cwd,
      signal: controller.signal,
      env: fixtureEnv("clean", { FAKE_PI_RECORD_PATH: recordPath }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "cancelled");
    await assert.rejects(readFile(recordPath, "utf8"));
  });
});

test("parent cancellation signals an active child and settles once", async () => {
  await withTempDir(async (cwd) => {
    const signalPath = join(cwd, "signals.txt");
    const controller = new AbortController();
    const run = runDelegate({
      profile: SCOUT_PROFILE,
      task: "Cancel",
      cwd,
      signal: controller.signal,
      env: fixtureEnv("hang", { FAKE_PI_SIGNAL_PATH: signalPath }),
      cleanupGraceMs: 100,
      exitDrainMs: 20,
    });
    setTimeout(() => controller.abort(), 150);

    const result = await run;
    assert.equal(result.ok, false);
    assert.equal(result.code, "cancelled");
    assert.match(await readFile(signalPath, "utf8"), /SIGTERM/);
  });
});

test("platform policy supports only Linux and macOS", () => {
  assert.equal(isSupportedPlatform("darwin"), true);
  assert.equal(isSupportedPlatform("linux"), true);
  assert.equal(isSupportedPlatform("win32"), false);
  assert.equal(isSupportedPlatform("aix"), false);
});

test("spawn errors are classified and bounded", async () => {
  await withTempDir(async (cwd) => {
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "Spawn",
      cwd,
      env: { ...process.env, PI_DELEGATOR_PI_BINARY: join(cwd, "missing-pi") },
      cleanupGraceMs: 50,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "spawn_failed");
    assert.match(result.message, /Could not launch Pi/);
  });
});

test("oversized pending protocol output fails without hanging", async () => {
  await withTempDir(async (cwd) => {
    const profile = { ...SCOUT_PROFILE, timeoutMs: 1_000 };
    const result = await runDelegate({
      profile,
      task: "Oversized",
      cwd,
      env: fixtureEnv("oversized"),
      cleanupGraceMs: 100,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "protocol_error");
    assert.match(result.message, /exceeded/);
  });
});

test("truncates returned terminal text at 50 KiB with metadata", async () => {
  await withTempDir(async (cwd) => {
    const output = "é".repeat(30_000);
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "Large answer",
      cwd,
      env: fixtureEnv("clean", { FAKE_PI_OUTPUT: output }),
      cleanupGraceMs: 50,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.originalBytes, Buffer.byteLength(output));
    assert.ok(Buffer.byteLength(result.text) <= 50 * 1024);
  });
});
