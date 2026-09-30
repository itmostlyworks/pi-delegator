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

test("renders readable safe tasks and unclipped live activity with model and thinking", () => {
  const tool = registeredTool();
  const call = renderText(tool.renderCall({ agent: "worker", task: "Inspect\n source\x1b[31m now\x1b[0m\u202e", model: "private", cwd: "/private" }, plainTheme, {}));
  assert.equal(call, "Delegate\nInspect source now\n");
  assert.doesNotMatch(call, /private|task:|cwd:/);
  const longCall = renderText(tool.renderCall({ task: "😀".repeat(500) }, plainTheme, {}), 80);
  assert.equal(Array.from(longCall.replace(/\n/g, "").slice("Delegate".length)).length, 241);
  const expandedTask = "Inspect\n source\x1b[31m now\x1b[0m\u202e\n" + "😀".repeat(500) + "END";
  const expandedCall = renderText(tool.renderCall({ task: expandedTask }, plainTheme, { expanded: true }), 80);
  assert.equal(expandedCall.replace(/\n/g, ""), "DelegateInspect source now" + "😀".repeat(500) + "END");
  assert.match(expandedCall, /^Delegate\nInspect\n source now\n/);
  assert.equal(renderText(tool.renderCall({}, plainTheme, { expanded: true })), "Delegate\n…\n");
  const output = `Recent tool starts · 4 total\n${Array.from({ length: 4 }, (_, i) => `${i === 3 ? "→" : "·"} read ${"x".repeat(160)}${i}:9007199254740991`).join("\n")}\n\nLatest commentary: ${"c".repeat(240)}END`;
  const content = [{ type: "text", text: output }];
  const details = { agent: "worker", model: "provider/model", thinking: "high", durationMs: 10 };
  for (const expanded of [false, true]) {
    const partial = renderText(tool.renderResult({ content, details }, { expanded, isPartial: true }, plainTheme, {}), 40);
    assert.match(partial.replace(/\n/g, " "), new RegExp(`^Worker · ${expanded ? "provider/" : ""}model · high · 10ms · Running`));
    assert.match(partial, /END$/);
    assert.doesNotMatch(partial, /preview truncated|expand to view/);
  }
  const final = renderText(tool.renderResult({ content, details }, { expanded: false, isPartial: false }, plainTheme, {}));
  assert.doesNotMatch(final, /Running/);
  assert.match(final, /preview truncated/);
  assert.equal(content[0].text, output);
});

test("live activity uses four collapsed entries and eight expanded entries", () => {
  const tool = registeredTool();
  const collapsedProgress = "Recent tool starts · 9 total · 5 earlier\n· read file5\n· read file6\n· read file7\n→ read file8";
  const expandedProgress = "Recent tool starts · 9 total · 1 earlier\n" +
    Array.from({ length: 8 }, (_, i) => `${i === 7 ? "→" : "·"} read file${i + 1}`).join("\n");
  const result = {
    content: [{ type: "text", text: collapsedProgress }],
    details: { agent: "worker", thinking: "high", durationMs: 10, expandedProgress },
  };
  for (const expanded of [false, true]) {
    const text = renderText(tool.renderResult(result, { expanded, isPartial: true }, plainTheme, {}));
    assert.equal(text.split("\n").slice(1).join("\n"), expanded ? expandedProgress : collapsedProgress);
  }
  const final = renderText(tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, {}));
  assert.equal(final.split("\n").slice(1).join("\n"), collapsedProgress);
});

test("fixed profiles expose their thinking, no default deadlines, and tools", () => {
  assert.deepEqual(
    [SCOUT_PROFILE, REVIEWER_PROFILE, ORACLE_PROFILE, TESTER_PROFILE, WORKER_PROFILE].map((profile) => ({
      name: profile.name,
      thinking: profile.thinking,
      timeoutMs: profile.timeoutMs,
      tools: [...profile.tools],
    })),
    [
      { name: "scout", thinking: "low", timeoutMs: null, tools: ["read", "grep", "find", "ls"] },
      { name: "reviewer", thinking: "high", timeoutMs: null, tools: ["read", "grep", "find", "ls", "bash"] },
      { name: "oracle", thinking: "high", timeoutMs: null, tools: ["read", "grep", "find", "ls"] },
      { name: "tester", thinking: "high", timeoutMs: null, tools: ["read", "grep", "find", "ls", "bash"] },
      { name: "worker", thinking: "high", timeoutMs: null, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
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
    assert.equal(updates[0].content[0].text, "No tool starts yet");
    assert.ok(updates.length >= 1); // Fast runs need not reach the first display tick.
    assert.ok(updates.every((update) => update.details.model === "override/model"));
    delete process.env.FAKE_PI_RECORD_PATH;
    const siblingUpdates = [[], []];
    const siblings = await Promise.all(["first/model-a", "second/model-b"].map((model, index) =>
      tool.execute(`sibling-${index}`, { agent: "scout", task: "Inspect independently", model }, undefined,
        (update) => siblingUpdates[index].push(update), context(directory)),
    ));
    for (const [index, model] of ["first/model-a", "second/model-b"].entries()) {
      assert.equal(siblings[index].details.model, model);
      assert.ok(siblingUpdates[index].length >= 1);
      assert.ok(siblingUpdates[index].every((update) => update.details.model === model));
      assert.equal(siblingUpdates[index][0].content[0].text, "No tool starts yet");
    }
    assert.notEqual(siblingUpdates[0][0].details, siblingUpdates[1][0].details);
    assert.equal(result.content[0].text, "Review complete");
    assert.equal(result.details.usage.turns, 2);
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

    assert.ok(updates.length >= 1);
    assert.equal(updates[0].content[0].text, "No tool starts yet");
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("does not arm a display interval without an update observer", async () => {
  const tool = registeredTool();
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const originalSetInterval = globalThis.setInterval;
  let intervalCalls = 0;
  process.env.PI_DELEGATOR_PI_BINARY = resolve("test/fixtures/fake-pi.mjs");
  globalThis.setInterval = (...args) => {
    intervalCalls += 1;
    return originalSetInterval(...args);
  };
  try {
    const result = await tool.execute("no-observer", { agent: "scout", task: "Inspect" }, undefined, undefined, context(process.cwd()));
    assert.ok(result.content[0].text.length > 0);
    assert.equal(intervalCalls, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
  }
});

test("one-second ticks coalesce activity and usage, advance quiet elapsed time, and isolate parallel calls", async () => {
  const tool = registeredTool();
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  process.env.PI_DELEGATOR_PI_BINARY = resolve("test/fixtures/heartbeat-pi.mjs");
  const controller = new AbortController();
  const updates = [[], [], []];
  const starts = [0, 0, 0];
  const schedules = [
    { label: "active" },
    { label: "quiet", activity: false, finishMs: 3_350 },
    { label: "cancelled", finishMs: 10_000 },
  ];
  let abortTimer;
  try {
    const runs = schedules.map((schedule, index) => {
      starts[index] = Date.now();
      return tool.execute(`heartbeat-${index}`, { agent: "scout", task: JSON.stringify(schedule), model: `provider/model-${index}` },
        index === 2 ? controller.signal : undefined,
        (update) => updates[index].push({ update, at: Date.now() - starts[index] }), context(process.cwd()));
    });
    // Attach the rejection observer before cancellation.
    const cancelled = assert.rejects(runs[2], /\[cancelled\]/);
    abortTimer = setTimeout(() => controller.abort(), 3_200);
    const results = await Promise.all([runs[0], runs[1], cancelled]);
    assert.equal(results[0].content[0].text, "active complete");
    assert.equal(results[1].content[0].text, "quiet complete");
    const text = (entry) => entry.update.content[0].text;
    const active = updates[0];
    assert.equal(text(active[0]), "No tool starts yet");
    assert.ok(active.length >= 4, "real run must reach at least three display ticks");
    assert.equal(text(active[1]), "Recent tool starts · 1 total\n→ read active.ts\n\nLatest commentary: active");
    assert.equal(active[1].update.details.usage.input, 7);
    assert.equal(active[1].update.details.usage.turns, 1);
    assert.equal(active[1].update.details.usage.cost, 0.02);
    assert.equal(text(active[2]), "Recent tool starts · 2 total\n· read active.ts\n→ grep\n\nLatest commentary: active follow-up");
    assert.equal(active[2].update.details.usage.input, 12);
    assert.equal(active[2].update.details.usage.turns, 2);
    assert.equal(active[2].update.details.usage.cost, 0.03);
    assert.equal(text(active[3]), text(active[2]));
    assert.deepEqual(active[3].update.details.usage, active[2].update.details.usage);
    assert.equal(results[0].details.usage.input, 12);
    assert.equal(results[0].details.usage.turns, 3);
    assert.equal(results[0].usage.cost.total, 0.03);
    const quiet = updates[1];
    assert.ok(quiet.length >= 4);
    assert.ok(quiet.every((entry) => text(entry) === "No tool starts yet"));
    for (const [index, entries] of updates.entries()) {
      assert.ok(entries[0].at < 100, `call ${index} must publish its initial state immediately`);
      // No event-driven renders between ticks, including terminal message events.
      for (const [tick, entry] of entries.entries()) {
        const elapsed = entry.at - entries[0].at;
        assert.ok(Math.abs(elapsed - tick * 1_000) < 400, `call ${index}, tick ${tick}: ${elapsed}ms`);
        assert.doesNotMatch(text(entry), /Last activity|Waiting for first activity/);
        if (tick > 0) assert.ok(entry.update.details.durationMs > entries[tick - 1].update.details.durationMs);
      }
      assert.ok(entries.every((entry) => entry.update.details.model === `provider/model-${index}`));
      for (const [otherIndex, schedule] of schedules.entries()) {
        if (otherIndex === index) continue;
        assert.ok(entries.every((entry) => !text(entry).includes(`${schedule.label}.ts`)
          && !text(entry).includes(`Latest commentary: ${schedule.label}`)));
      }
      const rendered = renderText(tool.renderResult(entries[0].update, { expanded: false, isPartial: true }, plainTheme, {}));
      assert.match(rendered, new RegExp(`Scout · model-${index} · low · .*Running`));
    }
    const counts = updates.map((entries) => entries.length);
    await delay(1_100);
    assert.deepEqual(updates.map((entries) => entries.length), counts);
  } finally {
    clearTimeout(abortTimer);
    controller.abort();
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
  }
});

test("elapsed time advances during silence and throwing display observers cannot fail runs", async () => {
  const tool = registeredTool();
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  process.env.PI_DELEGATOR_PI_BINARY = resolve("test/fixtures/heartbeat-pi.mjs");
  const updates = [];
  try {
    const result = await tool.execute("observer", { agent: "scout", task: JSON.stringify({ label: "observer", finishMs: 3_350 }) },
      undefined, (update) => { updates.push(update); throw new Error("display failed"); }, context(process.cwd()));
    assert.equal(result.content[0].text, "observer complete");
    assert.ok(updates.length >= 4);
    assert.equal(updates[3].content[0].text, updates[2].content[0].text);
    assert.ok(updates[3].details.durationMs > updates[2].details.durationMs);
    assert.ok(updates.every((update) => !/Last activity|Waiting for first activity/.test(update.content[0].text)));
    const count = updates.length;
    await delay(1_100);
    assert.equal(updates.length, count);
  } finally {
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
  }
});

test("heartbeat stops on child, protocol, spawn, and pre-aborted failures", async () => {
  const tool = registeredTool();
  const previousBinary = process.env.PI_DELEGATOR_PI_BINARY;
  const updates = [[], [], [], []];
  try {
    process.env.PI_DELEGATOR_PI_BINARY = resolve("test/fixtures/heartbeat-pi.mjs");
    await Promise.all(["child", "protocol"].map((failure, index) => assert.rejects(
      tool.execute(failure, { agent: "scout", task: JSON.stringify({ label: failure, failure, finishMs: 1_150, activity: false }) },
        undefined, (update) => updates[index].push(update), context(process.cwd())),
      failure === "protocol" ? /\[protocol_error\]/ : /\[missing_terminal_answer\]/,
    )));
    process.env.PI_DELEGATOR_PI_BINARY = "/missing/pi-heartbeat";
    await assert.rejects(tool.execute("spawn", { agent: "scout", task: "fail" }, undefined,
      (update) => updates[2].push(update), context(process.cwd())), /\[spawn_failed\]/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(tool.execute("abort", { agent: "scout", task: "fail" }, controller.signal,
      (update) => updates[3].push(update), context(process.cwd())), /\[cancelled\]/);
    const counts = updates.map((entries) => entries.length);
    assert.ok(counts.every((count) => count >= 1));
    assert.ok(counts[0] >= 2 && counts[1] >= 2, "child and protocol failures must exercise an active timer");
    await delay(1_100);
    assert.deepEqual(updates.map((entries) => entries.length), counts);
  } finally {
    if (previousBinary === undefined) delete process.env.PI_DELEGATOR_PI_BINARY;
    else process.env.PI_DELEGATOR_PI_BINARY = previousBinary;
  }
});
