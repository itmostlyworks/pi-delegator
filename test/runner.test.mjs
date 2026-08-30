import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ORACLE_PROFILE,
  REVIEWER_PROFILE,
  SCOUT_PROFILE,
  TESTER_PROFILE,
  WORKER_PROFILE,
} from "../src/agents.ts";
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

async function waitForFile(path, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
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
      onProgress: (progress) => {
        if (progress.type === "assistant_message" && progress.text !== undefined) updates.push(progress.text);
      },
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
    assert.deepEqual(result.cleanup, {
      forced: false,
      termSent: false,
      killSent: false,
      processExited: true,
      pipesClosed: true,
    });

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

test("launches every fixed profile with isolated CLI contracts and outputs", async () => {
  await withTempDir(async (cwd) => {
    const cases = [
      { profile: SCOUT_PROFILE, output: "scout output" },
      { profile: REVIEWER_PROFILE, output: "reviewer output" },
      { profile: ORACLE_PROFILE, output: "oracle output" },
      { profile: TESTER_PROFILE, output: "tester output" },
      { profile: WORKER_PROFILE, output: "worker output" },
    ];

    const results = await Promise.all(cases.map(async ({ profile, output }) => {
      const recordPath = join(cwd, `${profile.name}-args.json`);
      const promptContentPath = join(cwd, `${profile.name}-prompt.md`);
      const result = await runDelegate({
        profile,
        task: `Run ${profile.name}`,
        cwd,
        model: "example/model",
        env: fixtureEnv("clean", {
          FAKE_PI_OUTPUT: output,
          FAKE_PI_RECORD_PATH: recordPath,
          FAKE_PI_PROMPT_CONTENT_PATH: promptContentPath,
        }),
        cleanupGraceMs: 50,
        exitDrainMs: 20,
      });
      return { profile, output, result, recordPath, promptContentPath };
    }));

    for (const { profile, output, result, recordPath, promptContentPath } of results) {
      assert.equal(result.ok, true);
      assert.equal(result.text, output);
      const args = JSON.parse(await readFile(recordPath, "utf8"));
      assert.equal(args[args.indexOf("--model") + 1], "example/model");
      assert.equal(args[args.indexOf("--thinking") + 1], profile.thinking);
      assert.equal(args[args.indexOf("--tools") + 1], profile.tools.join(","));
      assert.equal(await readFile(promptContentPath, "utf8"), profile.systemPrompt);
    }
  });
});

test("loads only each concurrent profile's explicit capabilities and tool allowlist", async () => {
  await withTempDir(async (cwd) => {
    const skillA = join(cwd, "skill-a.md");
    const skillB = join(cwd, "skill-b");
    const extensionA = join(cwd, "extension-a.ts");
    const extensionB = join(cwd, "extension-b.mjs");
    const profiles = [
      {
        ...SCOUT_PROFILE,
        name: "alpha",
        tools: ["read", "alpha_tool"],
        skills: [skillA],
        extensions: [extensionA],
      },
      {
        ...SCOUT_PROFILE,
        name: "beta",
        tools: ["find", "beta_tool"],
        skills: [skillB],
        extensions: [extensionB],
      },
    ];

    const runs = await Promise.all(profiles.map(async (profile) => {
      const recordPath = join(cwd, `${profile.name}-capabilities.json`);
      const result = await runDelegate({
        profile,
        task: `Run ${profile.name}`,
        cwd,
        env: fixtureEnv("clean", {
          FAKE_PI_OUTPUT: `${profile.name} output`,
          FAKE_PI_RECORD_PATH: recordPath,
        }),
        cleanupGraceMs: 50,
        exitDrainMs: 20,
      });
      return { profile, result, args: JSON.parse(await readFile(recordPath, "utf8")) };
    }));

    for (const { profile, result, args } of runs) {
      assert.equal(result.ok, true);
      assert.ok(args.includes("--no-skills"));
      assert.ok(args.includes("--no-extensions"));
      assert.equal(args[args.indexOf("--tools") + 1], profile.tools.join(","));
      assert.deepEqual(
        args.flatMap((argument, index) => argument === "--skill" ? [args[index + 1]] : []),
        profile.skills,
      );
      assert.deepEqual(
        args.flatMap((argument, index) => argument === "--extension" ? [args[index + 1]] : []),
        profile.extensions,
      );
      const sibling = profiles.find((candidate) => candidate.name !== profile.name);
      assert.equal(args.includes(sibling.skills[0]), false);
      assert.equal(args.includes(sibling.extensions[0]), false);
      assert.equal(args[args.indexOf("--tools") + 1].includes(sibling.tools[1]), false);
    }
  });
});

test("streams compact protocol progress data and aggregates usage", async () => {
  await withTempDir(async (cwd) => {
    const progress = [];
    const result = await runDelegate({
      profile: REVIEWER_PROFILE,
      task: "Review",
      cwd,
      onProgress: (update) => progress.push(update),
      env: fixtureEnv("progress-usage"),
      cleanupGraceMs: 50,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, "Review complete");
    assert.deepEqual(progress.map((update) => update.type), [
      "assistant_message",
      "tool_start",
      "tool_start",
      "tool_start",
      "tool_start",
      "tool_start",
      "tool_start",
      "tool_start",
      "tool_start",
      "assistant_message",
    ]);
    assert.deepEqual(
      progress.filter((update) => update.type === "tool_start").map((update) => update.toolName),
      ["read", "grep", "read", "read", "bash", "find", "ls", "工具工具工具工具工具工具工具"],
    );
    assert.deepEqual(result.usage, {
      input: 8,
      output: 9,
      cacheRead: 3,
      cacheWrite: 5,
      cost: 0.03,
      contextTokens: 13,
      turns: 2,
    });
  });
});

test("progress callback failures do not decide lifecycle", async () => {
  await withTempDir(async (cwd) => {
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "Ignore renderer failure",
      cwd,
      onProgress: () => {
        throw new Error("renderer failed");
      },
      env: fixtureEnv("progress-usage"),
      cleanupGraceMs: 50,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, "Review complete");
  });
});

test("private test timeout can shorten but cannot lengthen the profile deadline", async () => {
  await withTempDir(async (cwd) => {
    const shortened = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 1_000 },
      timeoutMs: 30,
      task: "Short deadline",
      cwd,
      env: fixtureEnv("hang"),
      cleanupGraceMs: 20,
      exitDrainMs: 10,
    });
    assert.equal(shortened.ok, false);
    assert.equal(shortened.code, "run_timeout");
    assert.match(shortened.message, /30 ms/);

    const notLengthened = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 40 },
      timeoutMs: 1_000,
      task: "Profile deadline",
      cwd,
      env: fixtureEnv("hang"),
      cleanupGraceMs: 20,
      exitDrainMs: 10,
    });
    assert.equal(notLengthened.ok, false);
    assert.equal(notLengthened.code, "run_timeout");
    assert.match(notLengthened.message, /40 ms/);
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
    assert.equal(result.cleanup.termSent, true);
    assert.equal(result.cleanup.killSent, false);
    assert.equal(result.cleanup.processExited, true);
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
    assert.equal(result.cleanup.termSent, true);
    assert.equal(result.cleanup.processExited, true);
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
    assert.match(
      result.text,
      /\[Delegate output truncated; original response was 60000 bytes\.\]$/,
    );
    assert.doesNotMatch(result.text, /�/u);
  });
});

test("preserves the exact final-text boundary and safely truncates four-byte UTF-8", async () => {
  await withTempDir(async (cwd) => {
    for (const [output, expectedTruncated] of [
      ["x".repeat(50 * 1024), false],
      ["😀".repeat(13_000), true],
    ]) {
      const result = await runDelegate({
        profile: SCOUT_PROFILE,
        task: "Boundary answer",
        cwd,
        env: fixtureEnv("clean", { FAKE_PI_OUTPUT: output }),
        cleanupGraceMs: 50,
        exitDrainMs: 20,
      });

      assert.equal(result.ok, true);
      assert.equal(result.truncated, expectedTruncated);
      assert.ok(Buffer.byteLength(result.text) <= 50 * 1024);
      assert.doesNotMatch(result.text, /�/u);
      if (expectedTruncated) {
        assert.equal(result.originalBytes, Buffer.byteLength(output));
        assert.match(result.text, /\[Delegate output truncated; original response was 52000 bytes\.\]$/);
      } else {
        assert.equal(result.text, output);
        assert.equal(result.originalBytes, undefined);
      }
    }
  });
});

test("post-exit guard settles when a descendant inherits stdout", async () => {
  await withTempDir(async (cwd) => {
    const descendantPidPath = join(cwd, "descendant.pid");
    const started = Date.now();
    const result = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 1_000 },
      task: "Leaked pipe",
      cwd,
      env: fixtureEnv("descendant-holds-stdout", {
        FAKE_PI_DESCENDANT_PID_PATH: descendantPidPath,
      }),
      cleanupGraceMs: 100,
      cleanupVerifyMs: 100,
      exitDrainMs: 30,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "missing_terminal_answer");
    assert.ok(Date.now() - started < 750, "post-exit drainage must remain bounded");
    assert.ok(Number(await waitForFile(descendantPidPath)) > 0);
    assert.equal(result.cleanup.forced, true);
    assert.equal(result.cleanup.termSent, true);
    assert.equal(result.cleanup.processExited, true);
    assert.equal(result.cleanup.pipesClosed, true);
  });
});

test("semantic completion preserves a valid answer while forcing leaked-watcher cleanup", async () => {
  await withTempDir(async (cwd) => {
    const signalPath = join(cwd, "signals.txt");
    const result = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 1_000 },
      task: "Answer then leak",
      cwd,
      env: fixtureEnv("leaked-watcher", { FAKE_PI_SIGNAL_PATH: signalPath }),
      cleanupGraceMs: 100,
      cleanupVerifyMs: 100,
      semanticDrainMs: 30,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, "answer before cleanup");
    assert.match(await waitForFile(signalPath), /SIGTERM/);
    assert.equal(result.cleanup.forced, true);
    assert.equal(result.cleanup.termSent, true);
    assert.equal(result.cleanup.killSent, false);
    assert.equal(result.cleanup.processExited, true);
  });
});

test("a terminal answer observed before the deadline wins during semantic drainage", async () => {
  await withTempDir(async (cwd) => {
    const signalPath = join(cwd, "signals.txt");
    const result = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 180 },
      task: "Late answer then leak",
      cwd,
      env: fixtureEnv("delayed-leaked-watcher", {
        FAKE_PI_DELAY_MS: "140",
        FAKE_PI_SIGNAL_PATH: signalPath,
      }),
      cleanupGraceMs: 100,
      cleanupVerifyMs: 100,
      semanticDrainMs: 80,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, "late valid result");
    assert.ok(result.durationMs >= 180, "cleanup should cross the original deadline in this fixture");
    assert.match(await waitForFile(signalPath), /SIGTERM/);
    assert.equal(result.cleanup.forced, true);
    assert.equal(result.cleanup.pipesClosed, true);
  });
});

test("TERM-resistant child is escalated to KILL", async () => {
  await withTempDir(async (cwd) => {
    const signalPath = join(cwd, "signals.txt");
    const started = Date.now();
    const result = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 150 },
      task: "Resist TERM",
      cwd,
      env: fixtureEnv("term-resistant", { FAKE_PI_SIGNAL_PATH: signalPath }),
      cleanupGraceMs: 50,
      cleanupVerifyMs: 150,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "run_timeout");
    assert.ok(Date.now() - started < 750, "TERM-to-KILL escalation must remain bounded");
    assert.equal((await waitForFile(signalPath)).trim(), "SIGTERM");
    assert.equal(result.cleanup.termSent, true);
    assert.equal(result.cleanup.killSent, true);
    assert.equal(result.cleanup.processExited, true);
  });
});

test("TERM-resistant descendant is killed with the full process group", async () => {
  await withTempDir(async (cwd) => {
    const signalPath = join(cwd, "signals.txt");
    const descendantPidPath = join(cwd, "descendant.pid");
    const result = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 180 },
      task: "Resistant descendant",
      cwd,
      env: fixtureEnv("term-resistant-descendant", {
        FAKE_PI_SIGNAL_PATH: signalPath,
        FAKE_PI_DESCENDANT_PID_PATH: descendantPidPath,
      }),
      cleanupGraceMs: 50,
      cleanupVerifyMs: 150,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "run_timeout");
    assert.ok(Number(await waitForFile(descendantPidPath)) > 0);
    assert.match(await waitForFile(signalPath), /SIGTERM/);
    assert.equal(result.cleanup.termSent, true);
    assert.equal(result.cleanup.killSent, true);
    assert.equal(result.cleanup.processExited, true);
  });
});

test("abort racing the deadline starts only one cleanup sequence", async () => {
  await withTempDir(async (cwd) => {
    const signalPath = join(cwd, "signals.txt");
    const controller = new AbortController();
    const run = runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 150 },
      task: "Race abort and timeout",
      cwd,
      signal: controller.signal,
      env: fixtureEnv("term-resistant", { FAKE_PI_SIGNAL_PATH: signalPath }),
      cleanupGraceMs: 50,
      cleanupVerifyMs: 150,
      exitDrainMs: 20,
    });
    setTimeout(() => controller.abort(), 150);

    const result = await run;
    assert.equal(result.ok, false);
    assert.ok(result.code === "cancelled" || result.code === "run_timeout");
    assert.equal((await waitForFile(signalPath)).trim().split("\n").length, 1);
    assert.equal(result.cleanup.termSent, true);
    assert.equal(result.cleanup.killSent, true);
  });
});

test("normal completion racing the deadline resolves once", async () => {
  await withTempDir(async (cwd) => {
    const result = await runDelegate({
      profile: { ...SCOUT_PROFILE, timeoutMs: 100 },
      task: "Race completion and timeout",
      cwd,
      env: fixtureEnv("delayed-clean", { FAKE_PI_DELAY_MS: "100" }),
      cleanupGraceMs: 50,
      cleanupVerifyMs: 100,
      semanticDrainMs: 20,
      exitDrainMs: 20,
    });

    assert.ok(result.ok || result.code === "run_timeout");
    if (result.ok) assert.equal(result.text, "delayed result");
  });
});

test("retains only the final 64 KiB of stderr diagnostics", async () => {
  await withTempDir(async (cwd) => {
    const result = await runDelegate({
      profile: SCOUT_PROFILE,
      task: "Large stderr",
      cwd,
      env: fixtureEnv("stderr-tail"),
      cleanupGraceMs: 50,
      cleanupVerifyMs: 100,
      exitDrainMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "missing_terminal_answer");
    assert.equal(Buffer.byteLength(result.stderr), 64 * 1024);
    assert.match(result.stderr, /END$/);
  });
});
