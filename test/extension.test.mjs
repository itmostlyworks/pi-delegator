import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";

import {
  ORACLE_PROFILE,
  REVIEWER_PROFILE,
  SCOUT_PROFILE,
  TESTER_PROFILE,
  WORKER_PROFILE,
} from "../src/agents.ts";
import { DELEGATE_CONFIG_FILENAME } from "../src/config.ts";
import { compactDisplayText, renderProgress, terminalSafe } from "../src/display.ts";
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
        session.tool = definition;
      },
      registerMessageRenderer(customType, renderer) {
        (session.messageRenderers ??= new Map()).set(customType, renderer);
      },
      sendMessage(message, options) {
        session.messages?.push({ message, options });
      },
      on(eventName, handler) {
        session.eventHandlers?.set(eventName, handler);
        if (eventName === "session_start") sessionStart = handler;
      },
    });
    assert.ok(sessionStart);
    session.ready = Promise.resolve(sessionStart({}, {
      ...context(session.cwd ?? agentDirectory, session.trusted ?? false),
      hasUI: session.hasUI ?? false,
    }));
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

test("background cards preserve foreground gaps and output whitespace", () => {
  const tool = registeredTool({ background: true });
  const task = "Inspect\n\n  authentication";
  const output = " first line\n\n  second line\n";
  const details = { agent: "scout", model: "provider/model", thinking: "low", durationMs: 1_000 };
  const width = 100;
  const paddedLines = (text) => text.split("\n").map((line) => line.padEnd(width));
  // Pi adds call and result directly to one container, without a spacer.
  // Check raw rendered lines, including whitespace and blank-line padding.
  const cardLines = (call, result) => {
    const card = new Container();
    card.addChild(call);
    card.addChild(result);
    return card.render(width);
  };

  for (const expanded of [false, true]) {
    const model = expanded ? "provider/model" : "model";
    for (const action of [undefined, "run", "start"]) {
      const call = tool.renderCall({ agent: "scout", task, ...(action ? { action } : {}) }, plainTheme, { expanded });
      const callText = `Delegate · Scout${action === "start" ? " · Start" : ""}\n${expanded ? task : "Inspect authentication"}\n`;
      assert.equal(call.text, callText);
      const result = tool.renderResult({
        content: [{ type: "text", text: output }],
        details: { ...details, ...(action === "start" ? { backgroundStatus: "started", runId: "run-1" } : {}) },
      }, { expanded, isPartial: false }, plainTheme, {});
      const resultText = action === "start"
        ? `Scout · ${model} · low · Started (inactive)`
        : `Scout · ${model} · low · 1s\n${output}`;
      assert.equal(result.text, resultText);
      assert.deepEqual(cardLines(call, result), [...paddedLines(callText), ...paddedLines(resultText)]);
    }

    for (const [isPartial, backgroundStatus, status] of [
      [true, undefined, "Running"],
      [false, "completed", "Completed"],
      [false, "failed", "Failed"],
    ]) {
      const call = tool.renderCall({ action: "wait", runId: "run-1" }, plainTheme, { expanded });
      const callText = "Delegate · Wait · run-1\n";
      assert.equal(call.text, callText);
      const result = tool.renderResult({ content: [{ type: "text", text: output }],
        details: { ...details, runId: "run-1", backgroundStatus } },
      { expanded, isPartial }, plainTheme, {});
      const resultText = `Scout · ${model} · low · 1s · ${status}\n${output}`;
      assert.equal(result.text, resultText);
      assert.deepEqual(cardLines(call, result), [...paddedLines(callText), ...paddedLines(resultText)]);
      const foreground = tool.renderResult({ content: [{ type: "text", text: output }], details },
        { expanded, isPartial }, plainTheme, {});
      assert.deepEqual(result.render(width).slice(1), foreground.render(width).slice(1), "wait preserves foreground output whitespace");
    }
  }
});

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

test("renders profile display names in calls and stored results without registry lookup", () => {
  const tool = registeredTool({ profiles: {
    "interaction-designer": configuredProfile({ displayName: "UX Specialist" }),
  } });
  assert.equal(tool.parameters.properties.agent.enum.includes("interaction-designer"), true);
  assert.equal(tool.parameters.properties.agent.enum.includes("UX Specialist"), false);
  assert.match(renderText(tool.renderCall({ agent: "interaction-designer", task: "Inspect" }, plainTheme, {})), /^Delegate · UX Specialist\n/);
  const unrelatedTool = registeredTool();
  const content = [{ type: "text", text: "Answer" }];
  for (const isPartial of [false, true]) {
    for (const expanded of [false, true]) {
      const details = { agent: "interaction-designer", displayName: "UX Specialist", thinking: "high", durationMs: 1 };
      assert.match(renderText(unrelatedTool.renderResult({ content, details }, { expanded, isPartial }, plainTheme, {})), /^UX Specialist · /);
      delete details.displayName;
      assert.match(renderText(unrelatedTool.renderResult({ content, details }, { expanded, isPartial }, plainTheme, {})), /^Interaction Designer · /);
      details.displayName = "Custom\x1b[31m name\x1b[0m\u202e";
      assert.match(renderText(unrelatedTool.renderResult({ content, details }, { expanded, isPartial }, plainTheme, {})), /^Custom name · /);
    }
  }
});

test("renders readable safe tasks and unclipped live activity with model and thinking", () => {
  const tool = registeredTool();
  const call = renderText(tool.renderCall({ agent: "worker", task: "Inspect\n source\x1b[31m now\x1b[0m\u202e", model: "private", cwd: "/private" }, plainTheme, {}));
  assert.equal(call, "Delegate · Worker\nInspect source now\n");
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
      reviewer: configuredProfile({ description: "Replacement reviewer", displayName: "Code Auditor" }),
      custom: configuredProfile({ description: "Custom verifier", model: null, thinking: "medium", tools: ["read"] }),
      short: configuredProfile({ description: "Short deadline", deadlineMs: 40, displayName: "Quick Check" }),
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
    const updates = [];
    const configured = await tool.execute(
      "configured",
      { agent: "reviewer", task: "Review" },
      undefined,
      (update) => updates.push(update),
      context(directory),
    );
    assert.equal(configured.details.agent, "reviewer");
    assert.equal(configured.details.displayName, "Code Auditor");
    assert.equal(updates[0].details.agent, "reviewer");
    assert.equal(updates[0].details.displayName, "Code Auditor");
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
      /\[run_timeout\].*Quick Check exceeded its 40 ms/,
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
    { label: "active", finishMs: 4_350 },
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
    // Launch sampling may span the first tick; assert observed phases rather
    // than assuming the fixture started immediately when execute was called.
    const first = active.findIndex((entry) => text(entry) === "Recent tool starts · 1 total\n→ read active.ts\n\nLatest commentary: active");
    const second = active.findIndex((entry) => text(entry) === "Recent tool starts · 2 total\n· read active.ts\n→ grep\n\nLatest commentary: active follow-up");
    assert.ok(first > 0 && second > first, "both activity phases must be rendered in order");
    assert.equal(active[first].update.details.usage.input, 7);
    assert.equal(active[first].update.details.usage.turns, 1);
    assert.equal(active[first].update.details.usage.cost, 0.02);
    assert.equal(active[second].update.details.usage.input, 12);
    assert.equal(active[second].update.details.usage.turns, 2);
    assert.equal(active[second].update.details.usage.cost, 0.03);
    assert.ok(active[second + 1], "quiet time after activity must reach another tick");
    assert.equal(text(active[second + 1]), text(active[second]));
    assert.deepEqual(active[second + 1].update.details.usage, active[second].update.details.usage);
    assert.equal(results[0].details.usage.input, 12);
    assert.equal(results[0].details.usage.turns, 3);
    assert.equal(results[0].usage.cost.total, 0.03);
    const quiet = updates[1];
    assert.ok(quiet.length >= 4);
    assert.ok(quiet.every((entry) => /^No tool starts yet(?:\n\nLatest commentary: quiet complete)?$/.test(text(entry))),
      "quiet runs may render their terminal commentary during cleanup but never tool activity");
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

async function withBackgroundFixture(scenario, run, extraEnv = {}, sessionOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-background-"));
  const env = {
    PI_DELEGATOR_PI_BINARY: resolve("test/fixtures/fake-pi.mjs"),
    FAKE_PI_SCENARIO: scenario,
    FAKE_PI_RECORD_PATH: join(directory, "args.json"),
    FAKE_PI_SIGNAL_PATH: join(directory, "signals"),
    FAKE_PI_DESCENDANT_PID_PATH: join(directory, "descendant.pid"),
    ...extraEnv,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const session = { eventHandlers: new Map(), messages: [], hasUI: false, ...sessionOptions };
  try {
    Object.assign(process.env, env);
    const tool = registeredTool(session.config ?? { background: true }, session);
    await session.ready;
    await run({ tool, session, directory });
  } finally {
    await session.eventHandlers.get("session_shutdown")?.({}, context(process.cwd()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function eventually(check, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("condition did not become true before bounded timeout");
}

async function fileAppears(path) {
  await eventually(async () => {
    try { await readFile(path); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
}

async function startBackground(tool, signal) {
  const result = await tool.execute("start", { action: "start", agent: "scout", task: "Inspect" },
    signal, undefined, context(process.cwd()));
  assert.equal(result.usage, undefined, "start must not charge usage before collection");
  const runId = result.content[0].text.match(/Started background delegate ([\w-]+)/)?.[1];
  assert.ok(runId);
  assert.match(runId, /^run-[1-9][0-9]*$/);
  assert.equal(result.details.runId, runId);
  assert.equal(result.details.agent, "scout");
  assert.equal(result.details.backgroundStatus, "started");
  assert.equal(result.details.taskPreview, "Inspect");
  assert.equal(result.content[0].text, `Started background delegate ${runId}. Collect with delegate({action: "wait", runId: "${runId}"}).`);
  for (const expanded of [false, true]) {
    assert.equal(renderText(tool.renderCall({ action: "start", agent: "scout", task: "Inspect" }, plainTheme, { expanded })), "Delegate · Scout · Start\nInspect\n");
    const rendered = renderText(tool.renderResult(result, { expanded, isPartial: false }, plainTheme, {}));
    assert.equal(rendered, `Scout · ${expanded ? "example/model" : "model"} · low · Started (inactive)`);
    assert.doesNotMatch(rendered, /Collect with|Usage:|Cleanup:|Running|#\d|run-\d|Inspect/);
  }
  return runId;
}

const waitBackground = (tool, runId, id = "wait", signal) => tool.execute(id,
  { action: "wait", runId }, signal, undefined, context(process.cwd()));

test("footer counts parallel foreground/background runs but not waits, and clears on settlement", async () => {
  await withBackgroundFixture("delayed-clean", async ({ tool }) => {
    const values = [];
    const ctx = { ...context(process.cwd()), mode: "tui", ui: { theme: plainTheme, setStatus: (key, text) => {
      assert.equal(key, "pi-delegator");
      values.push(text);
    } } };
    const foreground = tool.execute("footer-foreground", { agent: "worker", task: "Inspect" }, undefined, undefined, ctx);
    const starts = await Promise.all(["worker", "scout", "tester", "tester"].map((agent, i) =>
      tool.execute(`footer-start-${i}`, { action: "start", agent, task: "Inspect" }, undefined, undefined, ctx)));
    assert.equal(values.at(-1), "delegates: worker ×2 · scout · tester ×2");
    const count = values.length;
    const controller = new AbortController();
    const waiting = tool.execute("footer-wait", { action: "wait", runId: starts[0].details.runId }, controller.signal, undefined, ctx);
    controller.abort();
    await assert.rejects(waiting, /Stopped waiting/);
    assert.equal(values.length, count, "wait cancellation must not change active counts");
    await assert.rejects(tool.execute("invalid", { agent: "scout", task: " " }, undefined, undefined, ctx), /blank/);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(tool.execute("aborted", { action: "start", agent: "scout", task: "Inspect" }, aborted.signal, undefined, ctx), /cancelled/);
    assert.equal(values.length, count, "rejections must not publish phantom runs");
    await foreground;
    await eventually(() => values.at(-1) === undefined);
    const settledCount = values.length;
    for (const start of starts) await waitBackground(tool, start.details.runId);
    assert.equal(values.length, settledCount, "settled uncollected runs and collection are not active");
  }, { FAKE_PI_DELAY_MS: "500" });
});

test("footer old foreground completion cannot overwrite a new session", async () => {
  await withBackgroundFixture("delayed-clean", async ({ tool, session }) => {
    const values = [];
    const ctx = { ...context(process.cwd()), mode: "tui", ui: { theme: plainTheme, setStatus: (_key, text) => values.push(text) } };
    const controller = new AbortController();
    const oldRun = tool.execute("old-footer", { agent: "worker", task: "Inspect" }, controller.signal, undefined, ctx);
    const rejected = assert.rejects(oldRun, /cancelled/);
    await eventually(() => values.at(-1) === "delegates: worker");
    await session.eventHandlers.get("session_start")({}, ctx);
    const started = await session.tool.execute("new-footer", { action: "start", agent: "scout", task: "Inspect" }, undefined, undefined, ctx);
    assert.equal(values.at(-1), "delegates: scout");
    const count = values.length;
    controller.abort();
    await rejected;
    assert.equal(values.length, count, "old runner finally must not publish to the new session");
    await waitBackground(session.tool, started.details.runId);
    assert.equal(values.at(-1), undefined);
  }, { FAKE_PI_DELAY_MS: "1000" });
});

for (const scenario of ["assistant-error", "oversized-assistant"]) {
  test(`footer clears after ${scenario} failure even when UI throws`, async () => {
    await withBackgroundFixture(scenario, async ({ tool }) => {
      const values = [];
      const ctx = { ...context(process.cwd()), mode: "tui", ui: { theme: plainTheme, setStatus(_key, text) {
        values.push(text);
        throw new Error("footer unavailable");
      } } };
      await assert.rejects(tool.execute("footer-failure", { agent: "scout", task: "Inspect" }, undefined, undefined, ctx));
      assert.deepEqual(values, ["delegates: scout", undefined]);
    });
  });
}

test("background is opt-in and the default closed schema is unchanged", async () => {
  const implicit = registeredTool();
  const disabled = registeredTool({ background: false });
  assert.deepEqual(disabled.parameters, implicit.parameters);
  for (const tool of [implicit, disabled]) {
    assert.deepEqual(Object.keys(tool.parameters.properties), ["agent", "task", "model", "cwd"]);
    await assert.rejects(startBackground(tool), /Background delegation is disabled/);
  }
  const enabled = registeredTool({ background: true });
  assert.equal(enabled.parameters.type, "object", "providers require a root object schema");
  assert.equal(enabled.parameters.additionalProperties, false);
  assert.equal(enabled.parameters.anyOf, undefined);
  assert.deepEqual(Object.keys(enabled.parameters.properties), ["agent", "task", "model", "cwd", "action", "runId"]);
  assert.deepEqual(enabled.parameters.required ?? [], [], "action-dependent requirements are checked by execute");
  for (const field of ["agent", "task", "model", "cwd"]) {
    assert.deepEqual(enabled.parameters.properties[field], implicit.parameters.properties[field]);
  }
  assert.deepEqual(enabled.parameters.properties.action.enum, ["run", "start", "wait"]);
  assert.equal(enabled.parameters.properties.runId.type, "string");
  assert.equal(enabled.parameters.properties.runId.minLength, 1);
  assert.equal(enabled.parameters.properties.runId.maxLength, 64);
});

test("only trusted parent project config may enable or disable background delegation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-background-trust-"));
  try {
    await mkdir(join(directory, ".pi"));
    const configPath = join(directory, ".pi", DELEGATE_CONFIG_FILENAME);
    await writeFile(configPath, JSON.stringify({ background: true }));
    const untrusted = registeredTool(undefined, { cwd: directory, trusted: false });
    assert.equal(untrusted.parameters.properties.action, undefined);
    const trusted = registeredTool(undefined, { cwd: directory, trusted: true });
    assert.deepEqual(trusted.parameters.properties.action.enum, ["run", "start", "wait"]);
    await writeFile(configPath, JSON.stringify({ background: false }));
    const disabled = registeredTool({ background: true }, { cwd: directory, trusted: true });
    assert.equal(disabled.parameters.properties.action, undefined);
    const ignored = registeredTool({ background: true }, { cwd: directory, trusted: false });
    assert.deepEqual(ignored.parameters.properties.action.enum, ["run", "start", "wait"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("background execute validates action-dependent fields before launching or collecting", async () => {
  const tool = registeredTool({ background: true });
  const execute = (params) => tool.execute("invalid", params, undefined, undefined, context(process.cwd()));
  for (const runId of [undefined, "", "   ", 42, null]) {
    await assert.rejects(execute({ action: "wait", ...(runId === undefined ? {} : { runId }) }), /wait requires runId/);
  }
  for (const [field, value] of Object.entries({ agent: "scout", task: "Inspect", model: "provider/model", cwd: process.cwd() })) {
    await assert.rejects(execute({ action: "wait", runId: "unknown", [field]: value }), /wait accepts only action and runId/);
  }
  await assert.rejects(execute({ action: "wait", runId: "unknown" }), /Unknown or already collected/);
  for (const action of [undefined, "run", "start"]) {
    const base = action === undefined ? {} : { action };
    for (const fields of [{}, { agent: "scout" }, { task: "Inspect" }, { agent: 42, task: "Inspect" }, { agent: "scout", task: null }]) {
      await assert.rejects(execute({ ...base, ...fields }), /run\/start requires agent and task/);
    }
    for (const runId of ["unknown", ""]) {
      await assert.rejects(execute({ ...base, agent: "scout", task: "Inspect", runId }), /runId is only valid for delegate wait/);
    }
  }
  await assert.rejects(execute({ action: "invalid", agent: "scout", task: "Inspect" }), /Unknown delegate action/);
});

test("background start saves a bounded safe task preview for history without changing foreground cards", async () => {
  await withBackgroundFixture("clean", async ({ tool, session }) => {
    const task = "Inspect\n source\x1b[31m now\x1b[0m\u202e " + "😀".repeat(500);
    const args = { action: "start", agent: "scout", task };
    const started = await tool.execute("preview-start", args, undefined, undefined, context(process.cwd()));
    const saved = JSON.parse(JSON.stringify(started));
    assert.ok(Array.from(saved.details.taskPreview).length <= 241);
    assert.doesNotMatch(saved.details.taskPreview, /[\x1b\u202e]/);
    assert.ok(saved.details.taskPreview.startsWith("Inspect\n source now"));
    const historyTool = registeredTool();
    const renderSaved = () => {
      for (const expanded of [false, true]) {
        assert.equal(tool.renderCall(args, plainTheme, { expanded }).text, `Delegate · Scout · Start\n${expanded ? terminalSafe(task) : compactDisplayText(task, 240)}\n`);
        const rendered = renderText(historyTool.renderResult({ ...saved, content: [{ type: "text", text: "unrelated fallback" }] },
          { expanded, isPartial: false }, plainTheme, {}), 1000);
        assert.match(rendered, /^Scout · (?:example\/)?model · low · Started \(inactive\)$/);
        assert.doesNotMatch(rendered, /Collect with|Usage:|Cleanup:/);
        assert.ok(!rendered.includes(saved.details.taskPreview));
        assert.doesNotMatch(rendered, /unrelated fallback/);
        assert.doesNotMatch(rendered, /#1|Collect with/);
      }
    };
    renderSaved();
    await waitBackground(tool, saved.details.runId);
    await session.eventHandlers.get("session_before_switch")({}, context(process.cwd()));
    renderSaved();
    for (const action of [undefined, "run"]) {
      for (const expanded of [false, true]) {
        assert.equal(renderText(tool.renderCall({ agent: "scout", task: "Inspect", ...(action ? { action } : {}) }, plainTheme, { expanded })),
          "Delegate · Scout\nInspect\n");
      }
    }
  });
});

test("background start abbreviates collapsed tasks and preserves expanded spacing throughout collection and history", async () => {
  await withBackgroundFixture("delayed-clean", async ({ tool }) => {
    const task = "Inspect  source\tfiles\x1b[31m\u202e\x1b[0m\n\n" +
      Array.from({ length: 12 }, (_, i) => `Line ${i}:  ${"😀".repeat(30)}`).join("\n");
    const args = { action: "start", agent: "scout", task };
    const result = await tool.execute("uncompressed", args, undefined, undefined, context(process.cwd()));
    const safeTask = terminalSafe(task);
    assert.ok(Array.from(safeTask).length > 240);
    assert.equal(result.details.taskPreview, Array.from(safeTask).slice(0, 240).join("") + "…");
    const card = liveStartCard(tool, result, "uncompressed", false, args);
    const history = registeredTool();
    for (const expanded of [false, true]) {
      const running = tool.renderResult(result, { expanded, isPartial: false }, plainTheme,
        { toolCallId: "uncompressed", args });
      // Text expands tabs for terminal display; renderer input itself must preserve them.
      assert.equal(tool.renderCall(args, plainTheme, { expanded }).text, `Delegate · Scout · Start\n${expanded ? safeTask : compactDisplayText(task, 240)}\n`);
      assert.doesNotMatch(running.text, /\x1b|\u202e|preview truncated|more lines/);
      for (const savedArgs of [args, undefined]) {
        const inactive = history.renderResult(result, { expanded, isPartial: false }, plainTheme, { args: savedArgs });
        assert.equal(inactive.text, `Scout · ${expanded ? "example/model" : "model"} · low · Started (inactive)`);
        assert.doesNotMatch(inactive.text, /Running|Collect with|preview truncated|more lines/);
      }
      const fallback = tool.renderResult(result, { expanded, isPartial: false }, plainTheme, { toolCallId: "uncompressed" });
      assert.doesNotMatch(fallback.text, /Inspect|Collect with/);
      assert.ok(!fallback.text.includes("Line 11:"));
    }
    await waitBackground(tool, result.details.runId);
    const terminal = card.draw();
    assert.match(terminal.collapsed, /^Scout · model · low · Completed · /);
    for (const expanded of [false, true]) {
      const collected = tool.renderResult(result, { expanded, isPartial: false }, plainTheme,
        { toolCallId: "uncompressed", args, state: card.state });
      assert.doesNotMatch(collected.text, /Inspect|delayed result|Collect with/);
    }
    assert.doesNotMatch(terminal.expanded, /Collect with/);
  });
});

test("background start returns before a real child's delayed completion", async () => {
  await withBackgroundFixture("delayed-clean", async ({ tool, directory }) => {
    const before = Date.now();
    const runId = await startBackground(tool);
    assert.ok(Date.now() - before < 1_500, "start should not await the 2-second delegate");
    await fileAppears(join(directory, "args.json"));
    const args = JSON.parse(await readFile(join(directory, "args.json"), "utf8"));
    assert.ok(args.includes("--no-session"));
    assert.ok(args.includes("--no-extensions"));
    assert.equal((await waitBackground(tool, runId)).content[0].text, "delayed result");
    await assert.rejects(waitBackground(tool, runId), /Unknown or already collected/);
  }, { FAKE_PI_DELAY_MS: "2000" });
});

test("background success usage is collected once and foreground remains available", async () => {
  await withBackgroundFixture("progress-usage", async ({ tool, session }) => {
    const runId = await startBackground(tool);
    const result = await waitBackground(tool, runId);
    assert.equal(runId, "run-1");
    assert.equal(result.content[0].text, "Review complete");
    assert.equal(result.details.runId, runId);
    assert.equal(result.details.agent, "scout");
    assert.equal(result.details.backgroundStatus, "completed");
    const call = renderText(tool.renderCall({ action: "wait", runId }, plainTheme, {}));
    assert.equal(call, `Delegate · Wait · ${runId}\n`);
    for (const expanded of [false, true]) {
      const rendered = renderText(tool.renderResult(result, { expanded, isPartial: false }, plainTheme, {}));
      assert.equal(renderText(tool.renderCall({ action: "wait", runId }, plainTheme, { expanded })), `Delegate · Wait · ${runId}\n`);
      assert.doesNotMatch(rendered, /#1|run-1/);
    }
    const collapsed = renderText(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, {}));
    assert.match(collapsed, /^Scout · model · low · \d+(?:\.\d+)?(?:ms|s) · Completed\nReview complete$/);
    assert.doesNotMatch(collapsed, /Usage:|Cleanup:|run-1|#1/);
    const expanded = renderText(tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, {}));
    assert.match(expanded, /example\/model · low · /);
    assert.doesNotMatch(expanded, /Usage:|Cleanup:/);
    assert.doesNotMatch(expanded, /run-1/);
    assert.equal(result.usage.input, 8);
    assert.equal(result.usage.output, 9);
    assert.equal(result.usage.cost.total, 0.03);
    await assert.rejects(waitBackground(tool, runId, "second-wait"), /Unknown or already collected/);
    const toolResult = session.eventHandlers.get("tool_result");
    assert.equal(await toolResult({ toolName: "delegate", toolCallId: "wait" }), undefined);
    for (const action of [undefined, "run"]) {
      const foreground = await tool.execute("foreground", { agent: "scout", task: "Inspect", ...(action ? { action } : {}) },
        undefined, undefined, context(process.cwd()));
      assert.equal(foreground.content[0].text, "Review complete");
      assert.deepEqual(foreground.usage, result.usage);
    }
    assert.deepEqual(session.messages, []);
  });
});

test("waiting failure throws a Pi error and bills collected usage exactly once", async () => {
  await withBackgroundFixture("assistant-error-after-usage", async ({ tool, session }) => {
    const runId = await startBackground(tool);
    let failureText;
    await assert.rejects(waitBackground(tool, runId, "failed-wait"), (error) => {
      failureText = error.message;
      assert.match(failureText, /^Scout · #1 · Delegate failed \[child_error\].*fixture model error/);
      return true;
    });
    assert.deepEqual(session.messages, [], "an active waiter owns failure reporting");
    const toolResult = session.eventHandlers.get("tool_result");
    assert.equal(await toolResult({ toolName: "delegate", toolCallId: "start" }), undefined);
    const patch = await toolResult({ toolName: "delegate", toolCallId: "failed-wait", isError: true });
    assert.equal(patch.usage.input, 3);
    assert.equal(patch.usage.output, 2);
    assert.equal(patch.usage.cost.total, 0.01);
    assert.equal(patch.details.runId, runId);
    assert.equal(patch.details.agent, "scout");
    assert.equal(patch.details.model, "example/model");
    assert.equal(patch.details.thinking, "low");
    assert.equal(patch.details.backgroundStatus, "failed");
    assert.equal(patch.details.usage.input, 3);
    assert.ok(patch.details.cleanup);
    for (const expanded of [false, true]) {
      const content = [{ type: "text", text: failureText }];
      const rendered = renderText(tool.renderResult({ content, details: patch.details },
        { expanded, isPartial: false }, plainTheme, {}));
      assert.equal(content[0].text, failureText, "rendering preserves model-facing diagnostics");
      assert.ok(rendered.endsWith(failureText.slice("Scout · #1 · ".length)));
      const call = renderText(tool.renderCall({ action: "wait", runId }, plainTheme, { expanded }));
      assert.equal(call, `Delegate · Wait · ${runId}\n`);
      assert.doesNotMatch(rendered, /#1/);
      const unprefixed = renderText(tool.renderResult({ content: [{ type: "text", text: "Original Scout · #1 · diagnostic" }], details: patch.details },
        { expanded, isPartial: false }, plainTheme, {}));
      assert.ok(unprefixed.endsWith("Original Scout · #1 · diagnostic"), "only the generated leading prefix is stripped");
      assert.match(rendered, /^Scout · (?:example\/)?model · low · .* · Failed\n/);
      assert.match(rendered, /fixture model error/);
      assert.doesNotMatch(rendered, /run-1/);
      if (expanded) {
        assert.match(rendered, /example\/model · low/);
        assert.doesNotMatch(rendered, /Usage:|Cleanup:/);
      }
    }
    assert.equal(await toolResult({ toolName: "delegate", toolCallId: "failed-wait" }), undefined);
    await assert.rejects(waitBackground(tool, runId, "duplicate-failure"), /Unknown or already collected/);
    assert.equal(await toolResult({ toolName: "delegate", toolCallId: "duplicate-failure" }), undefined);
  });
});

for (const hasUI of [false, true]) {
  test(`uncollected failure sends one visible non-turn-triggering message (hasUI=${hasUI})`, async () => {
    await withBackgroundFixture("assistant-error", async ({ tool, session }) => {
      const runId = await startBackground(tool);
      await eventually(() => session.messages.length > 0);
      assert.equal(session.messages.length, 1);
      const { message, options } = session.messages[0];
      assert.equal(message.customType, "pi-delegator-failure");
      assert.equal(message.display, true);
      assert.deepEqual(message.details, { runId, agent: "scout", diagnostic: "[child_error] fixture model error" });
      const renderer = session.messageRenderers.get(message.customType);
      assert.ok(renderer);
      const savedMessage = JSON.parse(JSON.stringify(message));
      for (const expanded of [false, true]) {
        const rendered = renderText(renderer(savedMessage, { expanded }, plainTheme));
        assert.equal(rendered, "Scout · run-1 · Failed\n[child_error] fixture model error");
        assert.doesNotMatch(rendered, /Collect with|#1/);
      }
      assert.match(message.content, /fixture model error/);
      assert.deepEqual(options, { triggerTurn: false });
      await assert.rejects(waitBackground(tool, runId), /\[child_error\]/);
      await delay(50);
      assert.equal(session.messages.length, 1);
    }, {}, { hasUI });
  });
}

test("custom failure renderer uses saved profile details after collection and navigation", async () => {
  await withBackgroundFixture("assistant-error", async ({ tool, session }) => {
    const started = await tool.execute("custom-start", { action: "start", agent: "auditor", task: "Inspect" },
      undefined, undefined, context(process.cwd()));
    const runId = started.content[0].text.match(/Started background delegate ([\w-]+)/)?.[1];
    assert.equal(runId, "run-1");
    await eventually(() => session.messages.length === 1);
    const saved = JSON.parse(JSON.stringify(session.messages[0].message));
    assert.deepEqual(saved.details, {
      runId, agent: "auditor", displayName: "Code Auditor", diagnostic: "[child_error] fixture model error",
    });
    const renderer = session.messageRenderers.get(saved.customType);
    const renderSaved = () => {
      for (const expanded of [false, true]) {
        // Rendering must rely on persisted details, not message text or a live run.
        const rendered = renderText(renderer({ ...saved, content: "unrelated fallback content" }, { expanded }, plainTheme));
        assert.equal(rendered, "Code Auditor · run-1 · Failed\n[child_error] fixture model error");
        assert.doesNotMatch(rendered, /Collect with|#1/);
        assert.doesNotMatch(rendered, /unrelated fallback content/);
      }
    };
    renderSaved();
    const retained = renderer(saved, { expanded: true }, plainTheme);
    assert.doesNotMatch(renderText(retained), /Collect with/);
    await assert.rejects(waitBackground(tool, runId), /\[child_error\]/);
    assert.doesNotMatch(renderText(retained), /Collect with/);
    renderSaved();
    await session.eventHandlers.get("session_before_switch")({}, context(process.cwd()));
    renderSaved();
    await assert.rejects(waitBackground(tool, runId), /Unknown or already collected/);
    assert.equal(session.messages.length, 1);
  }, {}, { config: { background: true, profiles: {
    auditor: configuredProfile({ displayName: "Code Auditor", deadlineMs: null }),
  } } });
});

async function trackWaitIntervals(run) {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const active = new Set();
  let created = 0;
  const periods = [];
  globalThis.setInterval = (...args) => {
    periods.push(args[1]);
    const timer = originalSet(...args);
    active.add(timer);
    created++;
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    active.delete(timer);
    return originalClear(timer);
  };
  try {
    await run({ active, created: () => created, periods });
    assert.equal(active.size, 0, "all observation timers must be cleared");
  } finally {
    for (const timer of active) originalClear(timer);
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
}

// Pi re-invokes renderResult on invalidation with the same per-card state.
function liveStartCard(tool, result, toolCallId, throwOnInvalidate = false, args) {
  const frames = [];
  const renderContext = {
    toolCallId,
    args,
    state: {},
    invalidate() {
      if (throwOnInvalidate) throw new Error("UI invalidation failed");
      draw();
    },
  };
  const draw = () => {
    const frame = { at: Date.now() };
    for (const expanded of [false, true]) {
      frame[expanded ? "expanded" : "collapsed"] = renderText(tool.renderResult(result,
        { expanded, isPartial: false }, plainTheme, renderContext));
    }
    frames.push(frame);
    return frame;
  };
  draw();
  return { frames, draw, state: renderContext.state };
}

for (const exportFirst of [false, true]) {
  test(`HTML-export-style rendering preserves live start observation (export first=${exportFirst})`, async () => {
    await withBackgroundFixture("clean", async ({ tool }) => {
      const args = { action: "start", agent: "scout",
        task: JSON.stringify({ label: "exported", activity: false, finishMs: 650 }) };
      const start = await tool.execute("exported-start", args,
        undefined, undefined, context(process.cwd()));
      // Pi's HTML exporter supplies independent state and a no-op invalidation.
      const exportContexts = [];
      const exportCard = () => {
        const exportContext = { toolCallId: "exported-start", args, state: {}, invalidate() {} };
        exportContexts.push(exportContext);
        for (const expanded of [false, true]) {
          const exported = renderText(tool.renderResult(start,
            { expanded, isPartial: false }, plainTheme, exportContext));
          assert.match(exported, / · Started$/);
        }
      };
      if (exportFirst) exportCard();
      const card = liveStartCard(tool, start, "exported-start", false, args);
      for (let i = 0; i < 10; i++) exportCard();
      const result = await tool.execute("exported-wait", { action: "wait", runId: start.details.runId },
        undefined, undefined, context(process.cwd()));
      assert.equal(result.content[0].text, "exported complete");
      assert.equal(card.frames.length, 2, "interactive card receives settlement despite exports");
      assert.equal(card.state.summary.status, "Completed");
      assert.equal(card.state.observer, undefined);
      for (const exportContext of exportContexts) {
        assert.equal(exportContext.state.summary.status, "Completed");
        assert.equal(exportContext.state.observer, undefined);
      }
      const retained = card.draw();
      assert.match(retained.collapsed, / · Completed · \d+(?:\.\d+)?(?:ms|s)$/);
      assert.doesNotMatch(retained.collapsed, /inactive/);
    }, { PI_DELEGATOR_PI_BINARY: resolve("test/fixtures/heartbeat-pi.mjs") });
  });
}

test("static starts redraw only on settlement while parallel active and silent waits own foreground progress", async () => {
  await withBackgroundFixture("clean", async ({ tool }) => {
    await trackWaitIntervals(async ({ active, created, periods }) => {
      const starts = await Promise.all([true, false].map((activity, i) => tool.execute(`live-${i}`,
        { action: "start", agent: i === 0 ? "auditor" : "tester",
          task: JSON.stringify({ label: `live-${i}`, activity, finishMs: 3_350 }), model: `provider/live-${i}` },
        undefined, undefined, context(process.cwd()))));
      const cards = starts.map((start, i) => liveStartCard(tool, start, `live-${i}`));
      assert.equal(active.size, 0, "start cards never arm timers");
      assert.deepEqual(periods, []);
      await delay(1_100);
      assert.ok(cards.every((card) => card.frames.length === 1), "neither activity nor elapsed time redraws starts");
      for (const [i, card] of cards.entries()) {
        for (const expanded of [false, true]) {
          const text = card.frames[0][expanded ? "expanded" : "collapsed"];
          assert.match(text.split("\n")[0], new RegExp(`^${i === 0 ? "Code Auditor" : "Tester"} · ${expanded ? "provider/" : ""}live-${i} · ${starts[i].details.thinking} · Started$`));
          assert.ok(!text.includes(starts[i].details.taskPreview));
          assert.doesNotMatch(text, /Running|Usage:|Latest commentary|Recent tool starts|No tool starts yet/);
        }
      }
      const mismatch = liveStartCard(tool, starts[0], "unrelated-call");
      assert.match(mismatch.frames[0].collapsed, /^Code Auditor · live-0 · minimal · Started \(inactive\)$/);
      assert.doesNotMatch(mismatch.frames[0].expanded, /Collect with|Usage:|Running/);
      assert.equal(created(), 0, "mismatched history cannot observe a same-ID run");
      const updates = [[], []];
      const waits = starts.map((start, i) => tool.execute(`live-wait-${i}`,
        { action: "wait", runId: start.details.runId }, undefined, (update) => updates[i].push(update), context(process.cwd())));
      assert.equal(created(), 2, "only admitted waits with observers arm timers");
      assert.equal(active.size, 2);
      assert.deepEqual(periods, [1_000, 1_000]);
      for (const list of updates) {
        assert.equal(list.length, 1, "admission publishes before yielding");
        assert.ok(list[0].details.durationMs >= 1_100, "duration starts at launch, not wait admission");
      }
      const results = await Promise.all(waits);
      assert.equal(active.size, 0, "settlement clears registry heartbeats before collection returns");
      for (const [i, card] of cards.entries()) {
        assert.equal(card.frames.length, 2, "only settlement redraws, no progress or collection redraws");
        const running = updates[i].map((update) => ({
          update,
          collapsed: renderText(tool.renderResult(update, { expanded: false, isPartial: true }, plainTheme, {})),
          expanded: renderText(tool.renderResult(update, { expanded: true, isPartial: true }, plainTheme, {})),
        }));
        assert.ok(running.length >= 3, "silent and active waits both receive heartbeat updates");
        assert.match(running[0].collapsed, / · \d+(?:\.\d+)?(?:ms|s) · Running\n/);
        for (const frame of running) {
          const recentTools = frame.collapsed.includes("→ grep") ? ["read live-0.ts", "grep"]
            : frame.collapsed.includes("read live-0.ts") ? ["read live-0.ts"] : [];
          const progress = { totalCalls: recentTools.length, recentTools,
            ...(frame.collapsed.includes("Latest commentary:") ? {
              latestAssistantText: frame.collapsed.includes("live-0 follow-up") ? "live-0 follow-up" : "live-0",
            } : {}) };
          for (const expanded of [false, true]) {
            const text = frame[expanded ? "expanded" : "collapsed"];
            const [, elapsed, unit] = text.match(/ · (\d+(?:\.\d+)?)(ms|s) · Running\n/);
            assert.ok(!text.includes(starts[i].details.taskPreview), "wait never duplicates the task");
            assert.doesNotMatch(text, /Usage:/, "live usage is not an extra background-only row");
            assert.match(text.split("\n")[0], new RegExp(` · ${expanded ? "provider/" : ""}live-${i} · ${starts[i].details.thinking} · `));
            const foreground = renderText(tool.renderResult({
              content: [{ type: "text", text: renderProgress(progress) }],
              details: { ...frame.update.details, runId: undefined, backgroundStatus: undefined,
                durationMs: Number(elapsed) * (unit === "s" ? 1_000 : 1),
                expandedProgress: renderProgress(progress, true) },
            }, { expanded, isPartial: true }, plainTheme, {}));
            assert.equal(text, foreground, "pending wait exactly matches foreground");
          }
        }
        assert.notEqual(running[0].collapsed.split("\n")[0], running[1].collapsed.split("\n")[0], "elapsed advances");
        assert.ok(running.every((frame) => frame.expanded.includes(`provider/live-${i}`)));
        assert.ok(running.every((frame) => !frame.collapsed.includes(`live-${1 - i}.ts`)), "activity is per run");
        if (i === 0) {
          assert.ok(running.some((frame) => frame.collapsed.includes("read live-0.ts")));
          assert.ok(running.some((frame) => frame.expanded.includes("Latest commentary: live-0")));
          assert.ok(running.some((frame) => frame.expanded.includes("→ grep")));
        } else {
          assert.ok(running.every((frame) => frame.collapsed.endsWith("No tool starts yet")));
          assert.ok(running.every((frame) => !/Recent tool starts|read live-0/.test(frame.expanded)));
        }
        const terminal = card.frames.at(-1);
        assert.match(terminal.collapsed, / · Completed · \d+(?:\.\d+)?(?:ms|s)$/);
        assert.ok(!terminal.collapsed.includes(starts[i].details.taskPreview));
        assert.doesNotMatch(terminal.expanded, /complete|Usage:|Latest commentary|Recent tool starts/);
        assert.equal(card.state.summary.status, "Completed");
        assert.equal(results[i].content[0].text, `live-${i} complete`, "answer belongs only to collection");
        assert.ok(updates[i].every((update) => update.details.runId === starts[i].details.runId));
        const afterCollection = card.draw();
        assert.equal(afterCollection.collapsed, terminal.collapsed, "per-card summary survives registry removal");
        assert.equal(afterCollection.expanded, terminal.expanded, "collected start stays unchanged");
      }
      const counts = cards.map((card) => card.frames.length);
      const updateCounts = updates.map((list) => list.length);
      await delay(1_100);
      assert.deepEqual(cards.map((card) => card.frames.length), counts, "no late redraw after collection");
      assert.deepEqual(updates.map((list) => list.length), updateCounts, "no late wait update after collection");
    });
  }, { PI_DELEGATOR_PI_BINARY: resolve("test/fixtures/heartbeat-pi.mjs") }, { config: { background: true, profiles: {
    auditor: configuredProfile({ displayName: "Code Auditor", deadlineMs: null }),
  } } });
});

for (const throwing of [false, true]) {
  test(`static failed starts settle once and collect diagnostics despite throwing invalidate=${throwing}`, async () => {
    await withBackgroundFixture("assistant-error-after-usage", async ({ tool, session }) => {
      await trackWaitIntervals(async ({ active }) => {
        const start = await tool.execute("live-failure", { action: "start", agent: "scout", task: "Inspect" },
          undefined, undefined, context(process.cwd()));
        const card = liveStartCard(tool, start, "live-failure", throwing);
        assert.equal(active.size, 0, "starts have no heartbeat");
        await eventually(() => session.messages.length === 1);
        assert.equal(card.frames.length, throwing ? 1 : 2, "one settlement invalidation attempt");
        assert.equal(active.size, 0);
        const failed = card.draw();
        assert.match(failed.collapsed, /^Scout · model · low · Failed · \d+(?:\.\d+)?(?:ms|s)$/);
        assert.doesNotMatch(failed.expanded, /Collect with/);
        assert.doesNotMatch(failed.expanded, /fixture model error|Usage:|Cleanup:/);
        assert.equal(card.state.summary.status, "Failed");
        assert.match(session.messages[0].message.content, /fixture model error/);
        assert.deepEqual(session.messages[0].options, { triggerTurn: false });
        await assert.rejects(waitBackground(tool, start.details.runId, "collect-live-failure"), /fixture model error/);
        const patch = await session.eventHandlers.get("tool_result")({ toolName: "delegate", toolCallId: "collect-live-failure", isError: true });
        assert.equal(patch.usage.input, 3);
        const diagnostics = renderText(tool.renderResult({ content: [{ type: "text", text: "fixture model error" }], details: patch.details },
          { expanded: true, isPartial: false }, plainTheme, {}));
        assert.match(diagnostics, /fixture model error/);
        assert.doesNotMatch(diagnostics, /Cleanup:/);
        assert.equal(card.draw().expanded, failed.expanded, "failure summary stays unchanged on collection");
        const count = card.frames.length;
        await delay(1_100);
        assert.equal(card.frames.length, count);
      });
    });
  });
}

for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
  test(`pending wait heartbeat and start observation stop on ${event}`, async () => {
    await withBackgroundFixture("clean", async ({ tool, session }) => {
      await trackWaitIntervals(async ({ active }) => {
        const start = await tool.execute("live-navigation", { action: "start", agent: "scout",
          task: JSON.stringify({ label: "navigation", activity: false, finishMs: 10_000 }) },
          undefined, undefined, context(process.cwd()));
        const card = liveStartCard(tool, start, "live-navigation");
        assert.equal(active.size, 0);
        const updates = [];
        const waiting = tool.execute("navigation-wait", { action: "wait", runId: start.details.runId },
          undefined, (update) => updates.push(update), context(process.cwd()));
        const rejected = assert.rejects(waiting, /cancelled|Unknown|closed/);
        assert.equal(active.size, 1);
        await session.eventHandlers.get(event)({}, context(process.cwd()));
        await rejected;
        const updateCount = updates.length;
        assert.equal(active.size, 0);
        const count = card.frames.length;
        await delay(1_100);
        assert.equal(card.frames.length, count, "navigation/shutdown cannot invalidate removed cards");
        assert.equal(updates.length, updateCount, "navigation/shutdown stops wait updates");
        assert.match(card.frames.at(-1).collapsed, /^Scout · model · low · Started \(inactive\)$/,  "closure automatically redraws retained cards even if navigation is cancelled");
        assert.doesNotMatch(card.frames.at(-1).expanded, /Collect with|Running/);
        assert.deepEqual(session.messages, []);
      });
    }, { PI_DELEGATOR_PI_BINARY: resolve("test/fixtures/heartbeat-pi.mjs") });
  });
}

test("pending silent waits publish immediate elapsed progress and one-second heartbeats", async () => {
  await withBackgroundFixture("clean", async ({ tool }) => {
    await trackWaitIntervals(async ({ active }) => {
      const starts = await Promise.all(["auditor", "tester"].map((agent, i) => tool.execute(`start-${i}`,
        { action: "start", agent, task: JSON.stringify({ label: agent, activity: false, finishMs: 3_350 }), model: `provider/model-${i}` },
        undefined, undefined, context(process.cwd()))));
      await delay(1_100);
      const updates = [[], []];
      const waits = starts.map((start, i) => tool.execute(`wait-${i}`,
        { action: "wait", runId: start.details.runId }, undefined, (update) => updates[i].push(update), context(process.cwd())));
      assert.equal(active.size, 2, "each observed pending wait owns a timer");
      for (const [i, list] of updates.entries()) {
        assert.equal(list.length, 1, "update precedes yielding the wait");
        assert.ok(list[0].details.durationMs >= 1_100, "elapsed includes time before admission");
        assert.equal(list[0].content[0].text, renderProgress({ totalCalls: 0, recentTools: [] }));
        const rendered = renderText(tool.renderResult(list[0], { expanded: false, isPartial: true }, plainTheme, {}));
        assert.match(rendered, new RegExp(`^${i === 0 ? "Code Auditor" : "Tester"} · model-${i} · ${starts[i].details.thinking} · \\d+(?:\\.\\d+)?s · Running\\nNo tool starts yet$`));
        assert.equal(renderText(tool.renderCall({ action: "wait", runId: starts[i].details.runId }, plainTheme, {})), `Delegate · Wait · ${starts[i].details.runId}\n`);
        const expanded = renderText(tool.renderResult(list[0], { expanded: true, isPartial: true }, plainTheme, {}));
        assert.equal(expanded, rendered.replace(` · model-${i}`, ` · provider/model-${i}`), "silent expanded wait uses full model");
      }
      const results = await Promise.all(waits);
      assert.equal(active.size, 0);
      for (const [i, list] of updates.entries()) {
        assert.ok(list.length >= 3, "pending waits receive elapsed heartbeats");
        assert.ok(list.at(-1).details.durationMs > list[0].details.durationMs);
        assert.ok(list.every((update) => update.details.runId === starts[i].details.runId && update.details.model === `provider/model-${i}`));
        assert.equal(results[i].details.backgroundStatus, "completed");
        assert.doesNotMatch(renderText(tool.renderResult(results[i], { expanded: false, isPartial: false }, plainTheme, {})), /Waiting/);
      }
      const counts = updates.map((list) => list.length);
      await delay(1_100);
      assert.deepEqual(updates.map((list) => list.length), counts, "no late updates");
    });
  }, { PI_DELEGATOR_PI_BINARY: resolve("test/fixtures/heartbeat-pi.mjs") }, { config: { background: true, profiles: {
    auditor: configuredProfile({ displayName: "Code Auditor", deadlineMs: null }),
  } } });
});

test("wait observers tolerate errors and invalid waits add no timers", async () => {
  await withBackgroundFixture("delayed-clean", async ({ tool }) => {
    await trackWaitIntervals(async ({ active, created }) => {
      const id = await startBackground(tool);
      const controller = new AbortController();
      let observed = 0;
      const observer = () => { observed++; throw new Error("observer failure"); };
      const wait = tool.execute("aborted", { action: "wait", runId: id }, controller.signal, observer, context(process.cwd()));
      assert.equal(observed, 1);
      assert.equal(active.size, 1);
      await assert.rejects(tool.execute("duplicate", { action: "wait", runId: id }, undefined, observer, context(process.cwd())), /already has a waiter/);
      await assert.rejects(tool.execute("unknown", { action: "wait", runId: "run-999" }, undefined, observer, context(process.cwd())), /Unknown/);
      assert.equal(created(), 1, "invalid waits add no timers");
      controller.abort();
      await assert.rejects(wait, /Stopped waiting for delegate run-1; delegate not cancelled\. Wait again to get the result\./);
      assert.equal(active.size, 0);
      await assert.rejects(tool.execute("already-aborted", { action: "wait", runId: id }, controller.signal, observer, context(process.cwd())), /Stopped waiting for delegate/);
      assert.equal(created(), 1, "already-aborted wait adds no timer");
      assert.equal((await waitBackground(tool, id)).content[0].text, "delayed result");
      assert.equal(created(), 1, "no observer means no additional timer");
      const next = await startBackground(tool);
      assert.equal((await tool.execute("throwing-success", { action: "wait", runId: next }, undefined, observer, context(process.cwd()))).details.backgroundStatus, "completed");
      assert.ok(observed >= 4, "throwing observers still receive admitted progress and heartbeat updates");
      assert.equal(created(), 2);
      assert.equal(active.size, 0);
      const count = observed;
      await delay(1_100);
      assert.equal(observed, count);
    });
  }, { FAKE_PI_DELAY_MS: "2200" });
  await withBackgroundFixture("assistant-error", async ({ tool }) => {
    await trackWaitIntervals(async ({ active }) => {
      const id = await startBackground(tool);
      const updates = [];
      await assert.rejects(tool.execute("failure", { action: "wait", runId: id }, undefined,
        (update) => updates.push(update), context(process.cwd())), /child_error/);
      assert.equal(updates.length, 1);
      assert.equal(active.size, 0);
      await delay(1_100);
      assert.equal(updates.length, 1);
    });
  });
});

test("cancelling and retrying observed waits retains the start settlement observer", async () => {
  await withBackgroundFixture("clean", async ({ tool }) => {
    await trackWaitIntervals(async ({ active, created }) => {
      const start = await tool.execute("retry-start", { action: "start", agent: "scout",
        task: JSON.stringify({ label: "retry", activity: true, finishMs: 2_400 }) },
        undefined, undefined, context(process.cwd()));
      const card = liveStartCard(tool, start, "retry-start");
      const controller = new AbortController();
      const first = [];
      const waiting = tool.execute("first-wait", { action: "wait", runId: start.details.runId },
        controller.signal, (update) => first.push(update), context(process.cwd()));
      assert.equal(first.length, 1);
      assert.equal(active.size, 1);
      controller.abort();
      await assert.rejects(waiting, /Stopped waiting for delegate run-1; delegate not cancelled\. Wait again to get the result\./);
      assert.equal(active.size, 0);
      assert.equal(card.frames.length, 1, "cancelling wait does not redraw or remove start observation");
      const retry = [];
      const result = await tool.execute("retry-wait", { action: "wait", runId: start.details.runId },
        undefined, (update) => retry.push(update), context(process.cwd()));
      assert.equal(result.content[0].text, "retry complete");
      assert.equal(created(), 2);
      assert.equal(active.size, 0);
      assert.ok(retry.length >= 3);
      assert.equal(first.length, 1, "cancelled subscription receives no later progress");
      assert.equal(card.frames.length, 2, "retained start receives only settlement invalidation");
      assert.match(card.frames.at(-1).collapsed, / · Completed · /);
      const count = retry.length;
      await delay(1_100);
      assert.equal(retry.length, count);
      assert.equal(card.frames.length, 2);
    });
  }, { PI_DELEGATOR_PI_BINARY: resolve("test/fixtures/heartbeat-pi.mjs") });
});

test("cancelling wait leaves the real background child available for later collection", async () => {
  await withBackgroundFixture("delayed-clean", async ({ tool, session, directory }) => {
    const runId = await startBackground(tool);
    await fileAppears(join(directory, "args.json"));
    const controller = new AbortController();
    const waiting = waitBackground(tool, runId, "cancelled-wait", controller.signal);
    controller.abort();
    await assert.rejects(waiting, /Stopped waiting for delegate run-1; delegate not cancelled\. Wait again to get the result\./);
    assert.equal((await waitBackground(tool, runId, "retry-wait")).content[0].text, "delayed result");
    assert.deepEqual(session.messages, []);
    const toolResult = session.eventHandlers.get("tool_result");
    assert.equal(await toolResult({ toolName: "delegate", toolCallId: "cancelled-wait" }), undefined);
  }, { FAKE_PI_DELAY_MS: "1000" });
});

for (const event of ["session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree"]) {
  test(`${event} aborts background children and cleans TERM-resistant descendants`, { timeout: 12_000 }, async () => {
    await withBackgroundFixture("term-resistant-descendant", async ({ tool, session, directory }) => {
      const values = [];
      const ctx = { ...context(process.cwd()), mode: "tui", ui: { theme: plainTheme, setStatus: (_key, value) => values.push(value) } };
      const start = await tool.execute("navigation-start", { action: "start", agent: "scout", task: "Inspect" }, undefined, undefined, ctx);
      const runId = start.details.runId;
      assert.equal(values.at(-1), "delegates: scout");
      const pidPath = join(directory, "descendant.pid");
      await fileAppears(pidPath);
      const pid = Number(await readFile(pidPath, "utf8"));
      // Give the descendant time to install its TERM handler before exercising escalation.
      await delay(100);
      const before = Date.now();
      await session.eventHandlers.get(event)({}, context(process.cwd()));
      assert.ok(Date.now() - before < 8_000, "session cleanup must be bounded");
      assert.equal(values.at(-1), undefined, "cleanup clears the active delegate footer");
      assert.match(await readFile(join(directory, "signals"), "utf8"), /SIGTERM/);
      let status = "";
      try { status = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim(); }
      catch (error) { if (error.status !== 1) throw error; }
      assert.ok(status === "" || status.startsWith("Z"), `descendant ${pid} still live: ${status}`);
      assert.deepEqual(session.messages, [], "session cleanup should not announce cancellation as uncollected failure");
      await assert.rejects(waitBackground(tool, runId), /Unknown or already collected/);
      if (event === "session_shutdown") {
        await session.eventHandlers.get(event)({}, context(process.cwd()));
        await assert.rejects(startBackground(tool), /session is closing/);
      } else {
        // Another extension may cancel navigation: no session_start follows the pre-event.
        process.env.FAKE_PI_SCENARIO = "clean";
        const restarted = await tool.execute("navigation-restart", { action: "start", agent: "scout", task: "Inspect" }, undefined, undefined, ctx);
        const replacement = restarted.details.runId;
        assert.equal(values.at(-1), "delegates: scout", "cancelled navigation keeps status usable");
        assert.equal(runId, "run-1");
        assert.equal(replacement, "run-2");
        assert.equal((await waitBackground(tool, replacement)).content[0].text, "Scout result");
        assert.equal(values.at(-1), undefined);
      }
      assert.deepEqual(session.messages, []);
    });
  });
}
