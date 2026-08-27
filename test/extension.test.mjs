import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ORACLE_PROFILE,
  REVIEWER_PROFILE,
  SCOUT_PROFILE,
  WORKER_PROFILE,
} from "../src/agents.ts";
import { DELEGATE_CONFIG_FILENAME } from "../src/config.ts";
import piDelegator, { MAX_MODEL_BYTES, MAX_TASK_BYTES } from "../src/index.ts";

function registeredTool(config) {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-delegator-agent-dir-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tool;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    if (config !== undefined) {
      writeFileSync(join(agentDirectory, DELEGATE_CONFIG_FILENAME), JSON.stringify(config));
    }
    piDelegator({
      registerTool(definition) {
        tool = definition;
      },
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDirectory, { recursive: true, force: true });
  }
  assert.ok(tool);
  return tool;
}

const context = (cwd) => ({
  cwd,
  model: { provider: "example", id: "model" },
});

test("registers exactly the delegate tool with a closed four-profile schema", () => {
  const tool = registeredTool();
  assert.equal(tool.name, "delegate");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["agent", "task", "model", "thinking", "cwd", "timeoutMs"]);
  assert.deepEqual(tool.parameters.properties.agent.enum, ["scout", "reviewer", "oracle", "worker"]);
  assert.deepEqual(tool.parameters.properties.thinking.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(tool.parameters.properties.model.maxLength, MAX_MODEL_BYTES);
  assert.match(tool.parameters.properties.model.description, /user's profile default.*parent session model/);
  assert.match(tool.parameters.properties.thinking.description, /user's profile default.*built-in profile level/);
  assert.equal(tool.parameters.properties.timeoutMs.minimum, 1);
});

test("fixed profiles expose their documented thinking, deadlines, and tools", () => {
  assert.deepEqual(
    [SCOUT_PROFILE, REVIEWER_PROFILE, ORACLE_PROFILE, WORKER_PROFILE].map((profile) => ({
      name: profile.name,
      thinking: profile.thinking,
      timeoutMs: profile.timeoutMs,
      tools: [...profile.tools],
    })),
    [
      { name: "scout", thinking: "low", timeoutMs: 180_000, tools: ["read", "grep", "find", "ls"] },
      { name: "reviewer", thinking: "high", timeoutMs: 600_000, tools: ["read", "grep", "find", "ls", "bash"] },
      { name: "oracle", thinking: "high", timeoutMs: 600_000, tools: ["read", "grep", "find", "ls"] },
      { name: "worker", thinking: "high", timeoutMs: 1_200_000, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
    ],
  );
  assert.equal(REVIEWER_PROFILE.tools.includes("edit"), false);
  assert.equal(REVIEWER_PROFILE.tools.includes("write"), false);
  assert.equal(ORACLE_PROFILE.tools.includes("bash"), false);
  assert.equal(ORACLE_PROFILE.tools.includes("edit"), false);
  assert.equal(ORACLE_PROFILE.tools.includes("write"), false);
  assert.equal(WORKER_PROFILE.tools.includes("bash"), true);
  assert.equal(WORKER_PROFILE.tools.includes("edit"), true);
  assert.equal(WORKER_PROFILE.tools.includes("write"), true);
  assert.match(REVIEWER_PROFILE.systemPrompt, /Do not modify files/);
  assert.match(ORACLE_PROFILE.systemPrompt, /do not modify files/);
  assert.match(WORKER_PROFILE.systemPrompt, /Implement one clearly bounded coding task/);
});

test("rejects blank and oversized UTF-8 tasks and invalid deadlines before launch", async () => {
  const tool = registeredTool();
  await assert.rejects(tool.execute("id", { agent: "scout", task: "   " }, undefined, undefined, context(process.cwd())), /must not be blank/);
  await assert.rejects(
    tool.execute("id", { agent: "scout", task: "é".repeat(MAX_TASK_BYTES) }, undefined, undefined, context(process.cwd())),
    /UTF-8 limit/,
  );
  await assert.rejects(
    tool.execute("id", { agent: "scout", task: "Inspect", timeoutMs: 0 }, undefined, undefined, context(process.cwd())),
    /positive integer/,
  );
  await assert.rejects(
    tool.execute("id", { agent: "toString", task: "Inspect" }, undefined, undefined, context(process.cwd())),
    /Unknown delegate agent/,
  );
  await assert.rejects(
    tool.execute("id", { agent: "scout", task: "Inspect", model: "   " }, undefined, undefined, context(process.cwd())),
    /model must not be blank/,
  );
  await assert.rejects(
    tool.execute("id", { agent: "scout", task: "Inspect", model: "é".repeat(MAX_MODEL_BYTES) }, undefined, undefined, context(process.cwd())),
    /model exceeds.*UTF-8 limit/,
  );
  await assert.rejects(
    tool.execute("id", { agent: "scout", task: "Inspect", thinking: "extreme" }, undefined, undefined, context(process.cwd())),
    /Unknown delegate thinking level/,
  );
});

test("rejects invalid user configuration during extension startup", () => {
  assert.throws(
    () => registeredTool({ scout: { tools: ["bash"] } }),
    /Invalid pi-delegator config.*unknown field "tools".*profile "scout"/,
  );
});

test("rejects nonexistent and non-directory cwd values", async () => {
  const tool = registeredTool();
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-extension-"));
  try {
    const file = join(directory, "file.txt");
    await writeFile(file, "x");
    await assert.rejects(
      tool.execute("id", { agent: "scout", task: "Inspect", cwd: join(directory, "missing") }, undefined, undefined, context(directory)),
      /does not exist/,
    );
    await assert.rejects(
      tool.execute("id", { agent: "scout", task: "Inspect", cwd: file }, undefined, undefined, context(directory)),
      /not a directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies model/thinking overrides and streams compact progress with usage", async () => {
  const tool = registeredTool();
  const fixture = resolve("test/fixtures/fake-pi.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-overrides-"));
  const recordPath = join(directory, "override-args.json");
  const defaultRecordPath = join(directory, "default-args.json");
  await chmod(fixture, 0o755);
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const previousScenario = process.env.FAKE_PI_SCENARIO;
  const previousRecordPath = process.env.FAKE_PI_RECORD_PATH;
  process.env.PI_DELEGATOR_PI_BINARY = fixture;
  process.env.FAKE_PI_SCENARIO = "progress-usage";
  process.env.FAKE_PI_RECORD_PATH = recordPath;
  const updates = [];
  try {
    const result = await tool.execute(
      "id",
      { agent: "reviewer", task: "Review", model: " override/model ", thinking: "medium" },
      undefined,
      (update) => updates.push(update),
      context(directory),
    );
    assert.equal(result.details.agent, "reviewer");
    assert.equal(result.details.model, "override/model");
    assert.equal(result.details.thinking, "medium");
    assert.deepEqual(updates.map((update) => update.content[0].text), [
      "Reviewer: Inspecting code",
      "Reviewer started read",
      "Reviewer: Review complete",
    ]);
    assert.equal(updates.at(-1).details.usage.turns, 2);
    assert.equal(result.details.usage.input, 8);
    const args = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(args[args.indexOf("--model") + 1], "override/model");
    assert.equal(args[args.indexOf("--thinking") + 1], "medium");

    process.env.FAKE_PI_RECORD_PATH = defaultRecordPath;
    const inherited = await tool.execute(
      "id-2",
      { agent: "scout", task: "Inspect" },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(inherited.details.model, "example/model");
    assert.equal(inherited.details.thinking, "low");
    const defaultArgs = JSON.parse(await readFile(defaultRecordPath, "utf8"));
    assert.equal(defaultArgs[defaultArgs.indexOf("--model") + 1], "example/model");
    assert.equal(defaultArgs[defaultArgs.indexOf("--thinking") + 1], "low");
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
    if (previousScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = previousScenario;
    if (previousRecordPath === undefined) delete process.env.FAKE_PI_RECORD_PATH;
    else process.env.FAKE_PI_RECORD_PATH = previousRecordPath;
  }
});

test("applies immutable user defaults with call-first precedence", async () => {
  const tool = registeredTool({
    scout: { model: "configured/scout" },
    reviewer: { model: "configured/reviewer", thinking: "minimal" },
    oracle: { thinking: "medium" },
  });
  const fixture = resolve("test/fixtures/fake-pi.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-user-defaults-"));
  await chmod(fixture, 0o755);
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const previousScenario = process.env.FAKE_PI_SCENARIO;
  const previousRecordPath = process.env.FAKE_PI_RECORD_PATH;
  process.env.PI_DELEGATOR_PI_BINARY = fixture;
  process.env.FAKE_PI_SCENARIO = "clean";
  try {
    const configuredPath = join(directory, "configured.json");
    process.env.FAKE_PI_RECORD_PATH = configuredPath;
    const configured = await tool.execute(
      "configured",
      { agent: "reviewer", task: "Review" },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(configured.details.model, "configured/reviewer");
    assert.equal(configured.details.thinking, "minimal");
    const configuredArgs = JSON.parse(await readFile(configuredPath, "utf8"));
    assert.equal(configuredArgs[configuredArgs.indexOf("--model") + 1], "configured/reviewer");
    assert.equal(configuredArgs[configuredArgs.indexOf("--thinking") + 1], "minimal");
    assert.equal(configuredArgs[configuredArgs.indexOf("--tools") + 1], REVIEWER_PROFILE.tools.join(","));

    const overridePath = join(directory, "override.json");
    process.env.FAKE_PI_RECORD_PATH = overridePath;
    const overridden = await tool.execute(
      "overridden",
      { agent: "reviewer", task: "Review", model: "call/model", thinking: "xhigh" },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(overridden.details.model, "call/model");
    assert.equal(overridden.details.thinking, "xhigh");

    const unchangedPath = join(directory, "unchanged.json");
    process.env.FAKE_PI_RECORD_PATH = unchangedPath;
    const unchanged = await tool.execute(
      "unchanged",
      { agent: "reviewer", task: "Review again" },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(unchanged.details.model, "configured/reviewer");
    assert.equal(unchanged.details.thinking, "minimal");

    const modelOnly = await tool.execute(
      "model-only",
      { agent: "scout", task: "Inspect" },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(modelOnly.details.model, "configured/scout");
    assert.equal(modelOnly.details.thinking, "low");

    const thinkingOnly = await tool.execute(
      "thinking-only",
      { agent: "oracle", task: "Advise" },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(thinkingOnly.details.model, "example/model");
    assert.equal(thinkingOnly.details.thinking, "medium");

    const inherited = await tool.execute(
      "inherited",
      { agent: "worker", task: "Implement" },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(inherited.details.model, "example/model");
    assert.equal(inherited.details.thinking, "high");
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
    if (previousScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = previousScenario;
    if (previousRecordPath === undefined) delete process.env.FAKE_PI_RECORD_PATH;
    else process.env.FAKE_PI_RECORD_PATH = previousRecordPath;
  }
});

test("does not discover project-local delegator config", async () => {
  const tool = registeredTool();
  const fixture = resolve("test/fixtures/fake-pi.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-project-config-"));
  const projectConfigDirectory = join(directory, ".pi");
  await mkdir(projectConfigDirectory);
  await writeFile(
    join(projectConfigDirectory, DELEGATE_CONFIG_FILENAME),
    JSON.stringify({ scout: { tools: ["bash"] } }),
  );
  await chmod(fixture, 0o755);
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const previousScenario = process.env.FAKE_PI_SCENARIO;
  process.env.PI_DELEGATOR_PI_BINARY = fixture;
  process.env.FAKE_PI_SCENARIO = "clean";
  try {
    const result = await tool.execute(
      "id",
      { agent: "scout", task: "Inspect", cwd: directory },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(result.details.model, "example/model");
    assert.equal(result.details.thinking, "low");
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
    if (previousScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = previousScenario;
  }
});

test("tool throws runner failures using Pi error semantics", async () => {
  const tool = registeredTool();
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  process.env.PI_DELEGATOR_PI_BINARY = resolve("test/fixtures/does-not-exist");
  try {
    await assert.rejects(
      tool.execute("id", { agent: "scout", task: "Inspect" }, undefined, undefined, context(process.cwd())),
      /\[spawn_failed\]/,
    );
  } finally {
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
  }
});
