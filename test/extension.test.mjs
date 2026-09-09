import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { DELEGATE_CONFIG_FILENAME } from "../src/config.ts";
import piDelegator, { MAX_MODEL_BYTES, MAX_TASK_BYTES } from "../src/index.ts";

function registeredTool(config, session = {}) {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-delegator-agent-dir-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tool;
  let sessionStart;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    if (config !== undefined) {
      writeFileSync(join(agentDirectory, "configured.md"), "Configured role prompt\n");
      writeFileSync(join(agentDirectory, DELEGATE_CONFIG_FILENAME), JSON.stringify(config));
    }
    piDelegator({
      registerTool(definition) {
        tool = definition;
      },
      on(eventName, handler) {
        session.eventHandlers?.set(eventName, handler);
        if (eventName === "session_start") sessionStart = handler;
      },
    });
    assert.ok(sessionStart);
    sessionStart({}, context(session.cwd ?? agentDirectory, session.trusted ?? false));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDirectory, { recursive: true, force: true });
  }
  assert.ok(tool);
  return tool;
}

const context = (cwd, trusted = false) => ({
  cwd,
  model: { provider: "example", id: "model" },
  isProjectTrusted: () => trusted,
});

function configuredProfile(overrides = {}) {
  return {
    description: "Configured profile",
    model: "configured/default",
    thinking: "minimal",
    prompt: "configured.md",
    tools: ["read", "custom_tool"],
    skills: [],
    extensions: [],
    deadlineMs: 1_000,
    ...overrides,
  };
}

const plainTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function renderText(component, width = 200) {
  return component.render(width).map((line) => line.trimEnd()).join("\n");
}

test("registers exactly the delegate tool with a closed five-profile schema", () => {
  const tool = registeredTool();
  assert.equal(tool.name, "delegate");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["agent", "task", "model", "cwd"]);
  assert.deepEqual(tool.parameters.properties.agent.enum, ["scout", "reviewer", "oracle", "tester", "worker"]);
  assert.equal(Object.hasOwn(tool.parameters.properties, "thinking"), false);
  assert.equal(Object.hasOwn(tool.parameters.properties, "timeoutMs"), false);
  assert.equal(tool.parameters.properties.model.maxLength, MAX_MODEL_BYTES);
  assert.match(tool.parameters.properties.agent.description, /scout: Fast local codebase reconnaissance/);
  assert.match(tool.parameters.properties.model.description, /selected profile.*parent session model/);
});

test("renders selected delegate model and thinking metadata without changing result content", () => {
  const tool = registeredTool();
  const content = [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") }];
  const details = {
    agent: "worker",
    model: "openai-codex/gpt-5.6-luna",
    thinking: "high",
    durationMs: 12_345,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    truncated: false,
    malformedLineCount: 0,
    exitCode: 0,
    cleanup: { forced: false, termSent: false, killSent: false, processExited: true, pipesClosed: true },
  };

  const collapsed = renderText(
    tool.renderResult({ content, details }, { expanded: false, isPartial: false }, plainTheme, {}),
  );
  assert.match(collapsed, /^Worker · gpt-5\.6-luna · high · 12\.3s\nline 1/m);
  assert.match(collapsed, /line 10\n… \(2 more lines; expand to view\)/);
  assert.doesNotMatch(collapsed, /line 11/);

  const carriageReturnContent = [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `row ${index + 1}`).join("\r") }];
  const carriageReturnCollapsed = renderText(
    tool.renderResult(
      { content: carriageReturnContent, details },
      { expanded: false, isPartial: false },
      plainTheme,
      {},
    ),
  );
  assert.match(carriageReturnCollapsed, /row 10\n… \(2 more lines; expand to view\)/);
  assert.doesNotMatch(carriageReturnCollapsed, /row 11/);

  const expanded = renderText(
    tool.renderResult({ content, details }, { expanded: true, isPartial: false }, plainTheme, {}),
  );
  assert.match(expanded, /^Worker · openai-codex\/gpt-5\.6-luna · high · 12\.3s\nline 1/m);
  assert.match(expanded, /line 12/);
  assert.doesNotMatch(expanded, /more lines/);

  const longContent = [{ type: "text", text: `${"x".repeat(1_200)}END` }];
  const longCollapsed = renderText(
    tool.renderResult({ content: longContent, details }, { expanded: false, isPartial: false }, plainTheme, {}),
    80,
  );
  assert.match(longCollapsed, /preview truncated; expand to view/);
  assert.doesNotMatch(longCollapsed, /END/);
  const longExpanded = renderText(
    tool.renderResult({ content: longContent, details }, { expanded: true, isPartial: false }, plainTheme, {}),
    80,
  );
  assert.match(longExpanded, /END/);

  const missingDetailsCollapsed = renderText(
    tool.renderResult({ content: longContent }, { expanded: false, isPartial: false }, plainTheme, {}),
    80,
  );
  assert.match(missingDetailsCollapsed, /preview truncated; expand to view/);
  assert.doesNotMatch(missingDetailsCollapsed, /END/);

  assert.deepEqual(content, [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") }]);
});

test("fixed profiles expose their documented thinking, deadlines, and tools", () => {
  assert.deepEqual(
    [SCOUT_PROFILE, REVIEWER_PROFILE, ORACLE_PROFILE, TESTER_PROFILE, WORKER_PROFILE].map((profile) => ({
      name: profile.name,
      thinking: profile.thinking,
      timeoutMs: profile.timeoutMs,
      tools: [...profile.tools],
    })),
    [
      { name: "scout", thinking: "low", timeoutMs: 180_000, tools: ["read", "grep", "find", "ls"] },
      { name: "reviewer", thinking: "high", timeoutMs: 600_000, tools: ["read", "grep", "find", "ls", "bash"] },
      { name: "oracle", thinking: "high", timeoutMs: 600_000, tools: ["read", "grep", "find", "ls"] },
      { name: "tester", thinking: "high", timeoutMs: 1_200_000, tools: ["read", "grep", "find", "ls", "bash"] },
      { name: "worker", thinking: "high", timeoutMs: 1_200_000, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
    ],
  );
  assert.equal(REVIEWER_PROFILE.tools.includes("edit"), false);
  assert.equal(REVIEWER_PROFILE.tools.includes("write"), false);
  assert.equal(ORACLE_PROFILE.tools.includes("bash"), false);
  assert.equal(ORACLE_PROFILE.tools.includes("edit"), false);
  assert.equal(ORACLE_PROFILE.tools.includes("write"), false);
  assert.equal(TESTER_PROFILE.tools.includes("bash"), true);
  assert.equal(TESTER_PROFILE.tools.includes("edit"), false);
  assert.equal(TESTER_PROFILE.tools.includes("write"), false);
  assert.equal(WORKER_PROFILE.tools.includes("bash"), true);
  assert.equal(WORKER_PROFILE.tools.includes("edit"), true);
  assert.equal(WORKER_PROFILE.tools.includes("write"), true);
  assert.match(REVIEWER_PROFILE.systemPrompt, /Do not modify files/);
  assert.match(ORACLE_PROFILE.systemPrompt, /do not modify files/);
  assert.match(TESTER_PROFILE.systemPrompt, /exercising its real behavior/);
  assert.match(TESTER_PROFILE.systemPrompt, /Do not edit source or configuration files/);
  assert.match(TESTER_PROFILE.systemPrompt, /clean up processes and test state/);
  assert.match(WORKER_PROFILE.systemPrompt, /Implement one clearly bounded coding task/);
});

test("rejects blank and oversized UTF-8 tasks before launch", async () => {
  const tool = registeredTool();
  await assert.rejects(tool.execute("id", { agent: "scout", task: "   " }, undefined, undefined, context(process.cwd())), /must not be blank/);
  await assert.rejects(
    tool.execute("id", { agent: "scout", task: "é".repeat(MAX_TASK_BYTES) }, undefined, undefined, context(process.cwd())),
    /UTF-8 limit/,
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
});

test("rejects legacy user configuration during extension startup with corrective action", () => {
  assert.throws(
    () => registeredTool({ scout: { model: "old/model" } }),
    /Invalid pi-delegator config.*legacy or incomplete format.*Corrective action/,
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

test("applies a model override while preserving profile thinking and streams compact progress with usage", async () => {
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
      { agent: "reviewer", task: "Review", model: " override/model " },
      undefined,
      (update) => updates.push(update),
      context(directory),
    );
    assert.equal(result.details.agent, "reviewer");
    assert.equal(result.details.model, "override/model");
    assert.equal(result.details.thinking, "high");
    assert.deepEqual(updates.map((update) => update.content[0].text), [
      "Working · no tool calls yet\nLatest: Inspecting code",
      "1 tool call: read\nLatest: Inspecting code",
      "2 tool calls: read → grep\nLatest: Inspecting code",
      "3 tool calls: read → grep → read\nLatest: Inspecting code",
      "4 tool calls: read → grep → read ×2\nLatest: Inspecting code",
      "5 tool calls: read → grep → read ×2 → bash(pnpm test)\nLatest: Inspecting code",
      "6 tool calls: read → grep → read ×2 → bash(pnpm test) → find\nLatest: Inspecting code",
      "7 tool calls: … 1 earlier → grep → read ×2 → bash(pnpm test) → find → ls\nLatest: Inspecting code",
      "8 tool calls: … 2 earlier → read ×2 → bash(pnpm test) → find → ls → 工具工具工具工具工具工具…\nLatest: Inspecting code",
      "8 tool calls: … 2 earlier → read ×2 → bash(pnpm test) → find → ls → 工具工具工具工具工具工具…\nLatest: Review complete",
    ]);
    assert.equal(updates.at(-1).details.usage.turns, 2);
    assert.equal(result.details.usage.input, 8);
    assert.equal(result.details.usage.cost, 0.03);
    assert.deepEqual(result.usage, {
      input: 8,
      output: 9,
      cacheRead: 3,
      cacheWrite: 5,
      cacheWrite1h: 4,
      reasoning: 5,
      totalTokens: 19,
      cost: { input: 0.008, output: 0.014, cacheRead: 0.003, cacheWrite: 0.005, total: 0.03 },
    });
    const args = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(args[args.indexOf("--model") + 1], "override/model");
    assert.equal(args[args.indexOf("--thinking") + 1], "high");

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

test("returns an explicit truncation marker in model-facing tool content", async () => {
  const tool = registeredTool();
  const fixture = resolve("test/fixtures/fake-pi.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-model-visible-truncation-"));
  await chmod(fixture, 0o755);
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const previousScenario = process.env.FAKE_PI_SCENARIO;
  const previousOutput = process.env.FAKE_PI_OUTPUT;
  process.env.PI_DELEGATOR_PI_BINARY = fixture;
  process.env.FAKE_PI_SCENARIO = "clean";
  process.env.FAKE_PI_OUTPUT = "😀".repeat(13_000);
  try {
    const updates = [];
    const result = await tool.execute(
      "truncated",
      { agent: "scout", task: "Return a large answer" },
      undefined,
      (update) => updates.push(update),
      context(directory),
    );

    assert.equal(updates.length, 1);
    const preview = updates[0].content[0].text.replace("Working · no tool calls yet\nLatest: ", "");
    assert.equal(Array.from(preview).length, 241);
    assert.equal(preview, `${"😀".repeat(240)}…`);
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.originalBytes, 52_000);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
    assert.match(
      result.content[0].text,
      /\[Delegate output truncated; original response was 52000 bytes\.\]$/,
    );
    assert.doesNotMatch(result.content[0].text, /�/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
    if (previousScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = previousScenario;
    if (previousOutput === undefined) delete process.env.FAKE_PI_OUTPUT;
    else process.env.FAKE_PI_OUTPUT = previousOutput;
  }
});

test("advertises and launches the immutable effective registry with isolated model overrides", async () => {
  const tool = registeredTool({
    profiles: {
      scout: null,
      reviewer: configuredProfile({ description: "Replacement reviewer" }),
      custom: configuredProfile({ description: "Custom verifier", model: null, thinking: "medium", tools: ["read"] }),
      short: configuredProfile({ description: "Short deadline", deadlineMs: 40 }),
    },
  });
  assert.deepEqual(tool.parameters.properties.agent.enum, ["reviewer", "oracle", "tester", "worker", "custom", "short"]);
  assert.match(tool.parameters.properties.agent.description, /reviewer: Replacement reviewer/);
  assert.match(tool.parameters.properties.agent.description, /custom: Custom verifier/);
  assert.doesNotMatch(tool.parameters.properties.agent.description, /scout:/);

  const fixture = resolve("test/fixtures/fake-pi.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-effective-profiles-"));
  await chmod(fixture, 0o755);
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const previousScenario = process.env.FAKE_PI_SCENARIO;
  const previousRecordPath = process.env.FAKE_PI_RECORD_PATH;
  const previousOutput = process.env.FAKE_PI_OUTPUT;
  const previousPromptContentPath = process.env.FAKE_PI_PROMPT_CONTENT_PATH;
  const previousDelayMs = process.env.FAKE_PI_DELAY_MS;
  process.env.PI_DELEGATOR_PI_BINARY = fixture;
  process.env.FAKE_PI_SCENARIO = "clean";
  try {
    const configuredPath = join(directory, "configured.json");
    const promptPath = join(directory, "prompt.md");
    process.env.FAKE_PI_RECORD_PATH = configuredPath;
    process.env.FAKE_PI_PROMPT_CONTENT_PATH = promptPath;
    const configured = await tool.execute(
      "configured",
      { agent: "reviewer", task: "Review" },
      undefined,
      undefined,
      context(directory),
    );
    assert.equal(configured.details.model, "configured/default");
    assert.equal(configured.details.thinking, "minimal");
    const configuredArgs = JSON.parse(await readFile(configuredPath, "utf8"));
    assert.equal(configuredArgs[configuredArgs.indexOf("--model") + 1], "configured/default");
    assert.equal(configuredArgs[configuredArgs.indexOf("--thinking") + 1], "minimal");
    assert.equal(configuredArgs[configuredArgs.indexOf("--tools") + 1], "read,custom_tool");
    assert.equal(await readFile(promptPath, "utf8"), "Configured role prompt\n");

    delete process.env.FAKE_PI_RECORD_PATH;
    delete process.env.FAKE_PI_PROMPT_CONTENT_PATH;
    const [overridden, concurrentDefault] = await Promise.all([
      tool.execute("override", { agent: "reviewer", task: "Review", model: "call/model" }, undefined, undefined, context(directory)),
      tool.execute("default", { agent: "reviewer", task: "Review" }, undefined, undefined, context(directory)),
    ]);
    assert.equal(overridden.details.model, "call/model");
    assert.equal(concurrentDefault.details.model, "configured/default");
    const later = await tool.execute("later", { agent: "reviewer", task: "Review" }, undefined, undefined, context(directory));
    assert.equal(later.details.model, "configured/default");

    const inherited = await tool.execute("custom", { agent: "custom", task: "Verify" }, undefined, undefined, context(directory));
    assert.equal(inherited.details.model, "example/model");
    assert.equal(inherited.details.thinking, "medium");

    process.env.FAKE_PI_SCENARIO = "delayed-clean";
    process.env.FAKE_PI_DELAY_MS = "100";
    await assert.rejects(
      tool.execute("short", { agent: "short", task: "Wait" }, undefined, undefined, context(directory)),
      /\[run_timeout\].*40 ms/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
    if (previousScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = previousScenario;
    if (previousRecordPath === undefined) delete process.env.FAKE_PI_RECORD_PATH;
    else process.env.FAKE_PI_RECORD_PATH = previousRecordPath;
    if (previousOutput === undefined) delete process.env.FAKE_PI_OUTPUT;
    else process.env.FAKE_PI_OUTPUT = previousOutput;
    if (previousPromptContentPath === undefined) delete process.env.FAKE_PI_PROMPT_CONTENT_PATH;
    else process.env.FAKE_PI_PROMPT_CONTENT_PATH = previousPromptContentPath;
    if (previousDelayMs === undefined) delete process.env.FAKE_PI_DELAY_MS;
    else process.env.FAKE_PI_DELAY_MS = previousDelayMs;
  }
});

test("trusted parent project profiles add, replace, disable, and launch explicit capabilities over user and bundled profiles", async () => {
  const fixture = resolve("test/fixtures/fake-pi.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-trusted-project-"));
  const projectConfigDirectory = join(directory, ".pi");
  const skillPath = join(projectConfigDirectory, "project-skill.md");
  const extensionPath = join(projectConfigDirectory, "project-extension.mjs");
  const recordPath = join(directory, "project-args.json");
  const promptContentPath = join(directory, "project-prompt.md");
  await chmod(fixture, 0o755);
  await mkdir(projectConfigDirectory);
  await writeFile(join(projectConfigDirectory, "configured.md"), "Project role prompt\n");
  await writeFile(skillPath, "# Project skill\n");
  await writeFile(extensionPath, "export default function projectExtension() {}\n");
  await writeFile(
    join(projectConfigDirectory, DELEGATE_CONFIG_FILENAME),
    JSON.stringify({
      profiles: {
        scout: null,
        reviewer: configuredProfile({
          description: "Project reviewer",
          model: null,
          thinking: "high",
          tools: ["bash", "project_tool"],
          skills: ["project-skill.md"],
          extensions: ["project-extension.mjs"],
        }),
        project_only: configuredProfile({ description: "Project only", tools: ["read"] }),
      },
    }),
  );
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const previousScenario = process.env.FAKE_PI_SCENARIO;
  const previousRecordPath = process.env.FAKE_PI_RECORD_PATH;
  const previousPromptContentPath = process.env.FAKE_PI_PROMPT_CONTENT_PATH;
  process.env.PI_DELEGATOR_PI_BINARY = fixture;
  process.env.FAKE_PI_SCENARIO = "clean";
  process.env.FAKE_PI_RECORD_PATH = recordPath;
  process.env.FAKE_PI_PROMPT_CONTENT_PATH = promptContentPath;
  try {
    const tool = registeredTool(
      { profiles: { reviewer: configuredProfile({ description: "User reviewer" }), user_only: configuredProfile() } },
      { cwd: directory, trusted: true },
    );
    assert.deepEqual(tool.parameters.properties.agent.enum, ["reviewer", "oracle", "tester", "worker", "user_only", "project_only"]);
    assert.match(tool.parameters.properties.agent.description, /reviewer: Project reviewer/);
    assert.match(tool.parameters.properties.agent.description, /project_only: Project only/);
    assert.doesNotMatch(tool.parameters.properties.agent.description, /scout:/);

    const result = await tool.execute("project", { agent: "reviewer", task: "Review" }, undefined, undefined, context(directory, true));
    assert.equal(result.details.model, "example/model");
    assert.equal(result.details.thinking, "high");
    const args = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(args[args.indexOf("--model") + 1], "example/model");
    assert.equal(args[args.indexOf("--thinking") + 1], "high");
    assert.equal(args[args.indexOf("--tools") + 1], "bash,project_tool");
    assert.equal(args[args.indexOf("--skill") + 1], await realpath(skillPath));
    const extensions = args.flatMap((argument, index) =>
      argument === "--extension" ? [args[index + 1]] : []
    );
    assert.match(extensions[0], /delegate-bash-extension\.ts$/);
    assert.equal(extensions[1], await realpath(extensionPath));
    assert.equal(await readFile(promptContentPath, "utf8"), "Project role prompt\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
    if (previousScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = previousScenario;
    if (previousRecordPath === undefined) delete process.env.FAKE_PI_RECORD_PATH;
    else process.env.FAKE_PI_RECORD_PATH = previousRecordPath;
    if (previousPromptContentPath === undefined) delete process.env.FAKE_PI_PROMPT_CONTENT_PATH;
    else process.env.FAKE_PI_PROMPT_CONTENT_PATH = previousPromptContentPath;
  }
});

test("untrusted project config cannot influence the schema or delegated child behavior", async () => {
  const fixture = resolve("test/fixtures/fake-pi.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-untrusted-project-"));
  const projectConfigDirectory = join(directory, ".pi");
  const recordPath = join(directory, "args.json");
  await mkdir(projectConfigDirectory);
  await writeFile(
    join(projectConfigDirectory, DELEGATE_CONFIG_FILENAME),
    JSON.stringify({ profiles: { scout: null, hostile: configuredProfile({ tools: ["bash"] }) } }),
  );
  await chmod(fixture, 0o755);
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const previousScenario = process.env.FAKE_PI_SCENARIO;
  const previousRecordPath = process.env.FAKE_PI_RECORD_PATH;
  process.env.PI_DELEGATOR_PI_BINARY = fixture;
  process.env.FAKE_PI_SCENARIO = "clean";
  process.env.FAKE_PI_RECORD_PATH = recordPath;
  try {
    const tool = registeredTool(undefined, { cwd: directory, trusted: false });
    assert.deepEqual(tool.parameters.properties.agent.enum, ["scout", "reviewer", "oracle", "tester", "worker"]);
    const result = await tool.execute("id", { agent: "scout", task: "Inspect" }, undefined, undefined, context(directory));
    assert.equal(result.details.thinking, "low");
    const args = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
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

test("delegate cwd cannot select profiles outside the trusted parent session", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-delegator-parent-project-"));
  const child = await mkdtemp(join(tmpdir(), "pi-delegator-child-cwd-"));
  for (const [directory, profileName] of [[parent, "parent_only"], [child, "cwd_only"]]) {
    const configDirectory = join(directory, ".pi");
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, "configured.md"), `${profileName} prompt\n`);
    await writeFile(
      join(configDirectory, DELEGATE_CONFIG_FILENAME),
      JSON.stringify({ profiles: { [profileName]: configuredProfile({ description: profileName, tools: ["read"] }) } }),
    );
  }
  try {
    const tool = registeredTool(undefined, { cwd: parent, trusted: true });
    assert.equal(tool.parameters.properties.agent.enum.includes("parent_only"), true);
    assert.equal(tool.parameters.properties.agent.enum.includes("cwd_only"), false);
    await assert.rejects(
      tool.execute("id", { agent: "cwd_only", task: "Inspect", cwd: child }, undefined, undefined, context(parent, true)),
      /Unknown delegate agent/,
    );
    assert.equal(tool.parameters.properties.agent.enum.includes("cwd_only"), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(child, { recursive: true, force: true });
  }
});

test("different trusted project sessions keep independent effective profile registries", async () => {
  const projectA = await mkdtemp(join(tmpdir(), "pi-delegator-project-a-"));
  const projectB = await mkdtemp(join(tmpdir(), "pi-delegator-project-b-"));
  for (const [directory, profileName] of [[projectA, "project_a"], [projectB, "project_b"]]) {
    const configDirectory = join(directory, ".pi");
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, "configured.md"), `${profileName} prompt\n`);
    await writeFile(
      join(configDirectory, DELEGATE_CONFIG_FILENAME),
      JSON.stringify({ profiles: { [profileName]: configuredProfile({ description: profileName }) } }),
    );
  }
  try {
    const toolA = registeredTool(undefined, { cwd: projectA, trusted: true });
    const toolB = registeredTool(undefined, { cwd: projectB, trusted: true });
    assert.equal(toolA.parameters.properties.agent.enum.includes("project_a"), true);
    assert.equal(toolA.parameters.properties.agent.enum.includes("project_b"), false);
    assert.equal(toolB.parameters.properties.agent.enum.includes("project_b"), true);
    assert.equal(toolB.parameters.properties.agent.enum.includes("project_a"), false);
    assert.equal(toolA.parameters.properties.agent.enum.includes("project_a"), true);
  } finally {
    await rm(projectA, { recursive: true, force: true });
    await rm(projectB, { recursive: true, force: true });
  }
});

test("tool_result accounts for billable child usage while runner failures still throw", async () => {
  const eventHandlers = new Map();
  const tool = registeredTool(undefined, { eventHandlers });
  const fixture = resolve("test/fixtures/fake-pi.mjs");
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const previousScenario = process.env.FAKE_PI_SCENARIO;
  process.env.PI_DELEGATOR_PI_BINARY = fixture;
  process.env.FAKE_PI_SCENARIO = "assistant-error-after-usage";
  try {
    await assert.rejects(
      tool.execute("billed-failure", { agent: "scout", task: "Fail after usage" }, undefined, undefined, context(process.cwd())),
      /\[child_error\].*fixture model error/,
    );

    const toolResult = eventHandlers.get("tool_result");
    assert.ok(toolResult);
    const patch = await toolResult({
      type: "tool_result",
      toolName: "delegate",
      toolCallId: "billed-failure",
      input: { agent: "scout", task: "Fail after usage" },
      content: [{ type: "text", text: "failure" }],
      details: undefined,
      isError: true,
    });
    assert.deepEqual(patch, {
      usage: {
        input: 3,
        output: 2,
        cacheRead: 1,
        cacheWrite: 4,
        cacheWrite1h: 3,
        reasoning: 1,
        totalTokens: 6,
        cost: { input: 0.003, output: 0.004, cacheRead: 0.001, cacheWrite: 0.002, total: 0.01 },
      },
    });
    assert.equal(await toolResult({ type: "tool_result", toolName: "delegate", toolCallId: "billed-failure" }), undefined);
  } finally {
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
