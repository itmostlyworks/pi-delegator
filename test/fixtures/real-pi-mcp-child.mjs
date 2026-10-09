#!/usr/bin/env node
// A real Pi SDK session driven by a two-turn, zero-cost in-process provider.
// Consume runDelegate's actual CLI loadout, rather than hard-coding adapter paths.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  createAgentSession, createCodemodeExtension, createToolSearchExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";

const args = process.argv.slice(2);
const extensions = args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1]] : []);
assert(extensions.includes("builtin:codemode"));
assert(extensions.includes("builtin:tool-search"));
assert(!extensions.includes("builtin:mcp"), "runner must substitute the safe MCP adapter");
assert(extensions.some((path) => path.endsWith("delegate-mcp-extension.ts")));
assert(extensions[0].endsWith("delegate-bash-extension.ts"));
assert(args.includes("--no-extensions") && args.includes("--no-skills") && args.includes("--no-session"));
const tools = args[args.indexOf("--tools") + 1].split(",");
assert.deepEqual(tools, ["read", "bash", "codemode", "tool_search"]);
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
assert(agentDir, "tests must isolate Pi's settings, config and auth");
const evidencePath = process.env.REAL_PI_MCP_EVIDENCE;
const scenario = process.env.REAL_PI_MCP_SCENARIO;
const [pid, pgid, sid] = execFileSync("ps", ["-o", "pid=,pgid=,sess=", "-p", String(process.pid)], { encoding: "utf8", timeout: 1_000 }).trim().split(/\s+/).map(Number);
writeFileSync(`${evidencePath}.child`, JSON.stringify({ pid, pgid, sid, args }));
const settingsManager = SettingsManager.inMemory({ autoCompaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: false });
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: extensions,
  extensionFactories: [
    { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
    { name: "tool-search", builtin: true, factory: createToolSearchExtension() },
  ],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);

const code = `
const read = await tools.read({ path: "allowed.txt" });
if (!read.includes("allowed-read")) throw new Error("read did not run");
const bash = await tools.bash({ command: "printf overridden-bash" });
if (!bash.output.includes("overridden-bash")) throw new Error("bash did not run");
const writeAvailable = ALL_TOOLS.some(t => t.name === "write");
if (writeAvailable || "write" in tools) throw new Error("disallowed write exposed");
let writeRejected = false;
try { await tools.write({ path: "forbidden.txt", content: "bad" }); } catch (e) { writeRejected = true; }
if (!writeRejected) throw new Error("disallowed write callable");
const discovered = await searchTools("tiny deterministic echo", { namespace: "tiny" });
if (!discovered.some(t => t.name === "mcp__tiny__echo")) throw new Error("MCP discovery failed");
const mcp = await tools.mcp__tiny__echo({ value: "from-codemode" });
if (mcp.content[0].text !== "mcp:from-codemode") throw new Error("MCP call failed");
return { read, bash: bash.output, writeAvailable, writeRejected, discovered, mcp };
`;
let requests = 0;
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
modelRuntime.registerProvider("deterministic", {
  api: "deterministic-mcp", apiKey: "not-a-network-credential", baseUrl: "https://invalid.invalid",
  models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 }],
  streamSimple(model, context, options) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        requests++;
        assert(requests <= 2, "unexpected provider retry");
        const message = {
          role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [], stopReason: "stop",
        };
        stream.push({ type: "start", partial: message });
        if (requests === 1) {
          message.stopReason = "toolUse";
          const toolCall = { type: "toolCall", id: "real-codemode", name: "codemode", arguments: { code } };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          const searchCall = { type: "toolCall", id: "real-tool-search", name: "tool_search", arguments: { query: "tiny deterministic echo" } };
          message.content.push(searchCall);
          stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: searchCall, partial: message });
        } else {
          const result = context.messages.findLast(m => m.role === "toolResult" && m.toolName === "codemode");
          assert(result && !result.isError, JSON.stringify(result));
          const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
          assert.match(text, /Script completed/);
          assert.match(text, /mcp:from-codemode/);
          const searchResult = context.messages.findLast(m => m.role === "toolResult" && m.toolName === "tool_search");
          assert(searchResult && !searchResult.isError, JSON.stringify(searchResult));
          assert.match(JSON.stringify(searchResult.content), /mcp__tiny__echo/);
          writeFileSync(evidencePath, JSON.stringify({ piVersion: VERSION, requests, result, searchResult, bashDescription: session.getAllTools().find(t => t.name === "bash")?.description }));
          if (scenario !== "answer") {
            // Wait in real provider activity until the parent cancels/deadlines.
            await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
            message.stopReason = "aborted";
            message.errorMessage = "Mock provider aborted";
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
            return;
          }
          message.content.push({ type: "text", text: "real Pi codemode MCP completed" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      } catch (error) {
        // Fixture failures must not masquerade as a successful terminal answer.
        process.stderr.write(`${error.stack}\n`);
        process.exit(1);
      }
    });
    return stream;
  },
});
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, modelRuntime,
  model: modelRuntime.getModel("deterministic", "mock"), thinkingLevel: "off", tools,
  settingsManager, sessionManager: SessionManager.inMemory(),
});
await session.bindExtensions({});
assert(session.getAllTools().some(t => t.name === "codemode"), JSON.stringify({ loaded: resourceLoader.getExtensions().extensions.map(e => e.path), tools: session.getAllTools() }));
assert(session.getActiveToolNames().includes("codemode"), JSON.stringify({ active: session.getActiveToolNames(), loaded: resourceLoader.getExtensions().extensions.map(e => e.path) }));
// Serialize actual Pi events, including its authoritative terminal message.
session.subscribe(event => process.stdout.write(`${JSON.stringify(event)}\n`));
await session.prompt("Run the deterministic codemode integration script.");
// Let runDelegate own session-wide cleanup, including live MCP descendants.
setInterval(() => {}, 1_000);
