#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

const scenario = process.env.FAKE_PI_SCENARIO ?? "clean";
const recordPath = process.env.FAKE_PI_RECORD_PATH;
const signalPath = process.env.FAKE_PI_SIGNAL_PATH;
const promptModePath = process.env.FAKE_PI_PROMPT_MODE_PATH;
const promptContentPath = process.env.FAKE_PI_PROMPT_CONTENT_PATH;
const cwdPath = process.env.FAKE_PI_CWD_PATH;
const descendantPidPath = process.env.FAKE_PI_DESCENDANT_PID_PATH;
const childArgs = process.argv.slice(2);

if (recordPath) writeFileSync(recordPath, JSON.stringify(childArgs));
if (cwdPath) writeFileSync(cwdPath, process.cwd());
if (promptModePath || promptContentPath) {
  const promptIndex = childArgs.indexOf("--append-system-prompt");
  const promptPath = childArgs[promptIndex + 1];
  if (promptModePath) writeFileSync(promptModePath, String(statSync(promptPath).mode & 0o777));
  if (promptContentPath) writeFileSync(promptContentPath, readFileSync(promptPath, "utf8"));
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finalMessage(text = "Scout result") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  };
}

function spawnPipeHoldingDescendant(ignoreTerm) {
  const script = ignoreTerm
    ? "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
    : "setInterval(()=>{},1000)";
  const descendant = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  descendant.unref();
  if (descendantPidPath) writeFileSync(descendantPidPath, String(descendant.pid));
}

if (scenario === "clean") {
  emit({ type: "session", id: "fixture" });
  emit(finalMessage(process.env.FAKE_PI_OUTPUT ?? "Scout result"));
  emit({ type: "agent_settled" });
} else if (scenario === "split") {
  const first = `${JSON.stringify({ type: "unknown" })}\n${JSON.stringify(finalMessage("split ✓"))}\n`;
  const bytes = Buffer.from(first);
  process.stdout.write(bytes.subarray(0, 9));
  setTimeout(() => process.stdout.write(bytes.subarray(9)), 5);
} else if (scenario === "malformed-then-clean") {
  process.stdout.write("not-json\n");
  emit(finalMessage("valid after diagnostic"));
} else if (scenario === "progress-usage") {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Inspecting\ncode" }],
      stopReason: "toolUse",
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
    },
  });
  emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "src" } });
  emit({ type: "tool_execution_start", toolCallId: "tool-2", toolName: "grep", args: { pattern: "TODO" } });
  emit({ type: "tool_execution_start", toolCallId: "tool-3", toolName: "read", args: { path: "test" } });
  emit({ type: "tool_execution_start", toolCallId: "tool-4", toolName: "read", args: { path: "docs" } });
  emit({ type: "tool_execution_start", toolCallId: "tool-5", toolName: "bash", args: { command: "pnpm test -- --runInBand" } });
  emit({ type: "tool_execution_start", toolCallId: "tool-6", toolName: "find", args: { pattern: "*.ts" } });
  emit({ type: "tool_execution_start", toolCallId: "tool-7", toolName: "ls", args: { path: "." } });
  emit({ type: "tool_execution_start", toolCallId: "tool-8", toolName: "工具工具工具工具工具工具工具", args: {} });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Review complete" }],
      stopReason: "stop",
      usage: {
        input: 5,
        output: 7,
        cacheRead: 2,
        cacheWrite: 1,
        cacheWrite1h: 1,
        reasoning: 4,
        totalTokens: 13,
        cost: { input: 0.005, output: 0.01, cacheRead: 0.002, cacheWrite: 0.003, total: 0.02 },
      },
    },
  });
  emit({ type: "agent_settled" });
} else if (scenario === "no-answer") {
  emit({ type: "agent_settled" });
} else if (scenario === "assistant-error" || scenario === "assistant-error-after-usage") {
  if (scenario === "assistant-error-after-usage") {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Billable work" }],
        stopReason: "toolUse",
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
      },
    });
  }
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "fixture model error",
    },
  });
} else if (scenario === "assistant-error-then-success") {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "websocket error",
    },
  });
  emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 80 });
  setTimeout(() => {
    emit(finalMessage("recovered after retry"));
    emit({ type: "auto_retry_end", success: true, attempt: 1 });
    emit({ type: "agent_settled" });
  }, 80);
} else if (scenario === "answer-then-error-then-success") {
  emit(finalMessage("intermediate answer"));
  setTimeout(() => {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "websocket error",
      },
    });
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 120 });
  }, 30);
  setTimeout(() => {
    emit(finalMessage("recovered continuation"));
    emit({ type: "auto_retry_end", success: true, attempt: 1 });
    emit({ type: "agent_settled" });
  }, 150);
} else if (scenario === "answer-then-continuation") {
  emit(finalMessage("stale answer"));
  setTimeout(() => emit({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }), 30);
  setTimeout(() => {
    emit(finalMessage("completed continuation"));
    emit({ type: "agent_settled" });
  }, 150);
} else if (scenario === "oversized") {
  process.stdout.write("x".repeat(1024 * 1024 + 1));
  setInterval(() => {}, 1000);
} else if (scenario === "oversized-tool-result") {
  emit({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "large-result",
      toolName: "browser",
      content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }],
    },
  });
  emit(finalMessage("answer after large tool result"));
  emit({ type: "agent_settled" });
} else if (scenario === "hang") {
  const timer = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    if (signalPath) appendFileSync(signalPath, "SIGTERM\n");
    process.exit(143);
  });
} else if (scenario === "leaked-watcher") {
  emit(finalMessage("answer before cleanup"));
  emit({ type: "agent_settled" });
  const timer = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    if (signalPath) appendFileSync(signalPath, "SIGTERM\n");
    process.exit(143);
  });
} else if (scenario === "term-resistant") {
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    if (signalPath) appendFileSync(signalPath, "SIGTERM\n");
  });
} else if (scenario === "descendant-holds-stdout") {
  spawnPipeHoldingDescendant(false);
} else if (scenario === "term-resistant-descendant") {
  spawnPipeHoldingDescendant(true);
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    if (signalPath) appendFileSync(signalPath, "SIGTERM\n");
    process.exit(143);
  });
} else if (scenario === "delayed-clean") {
  setTimeout(() => {
    emit(finalMessage("delayed result"));
    emit({ type: "agent_settled" });
  }, Number(process.env.FAKE_PI_DELAY_MS ?? 100));
} else if (scenario === "delayed-leaked-watcher") {
  const timer = setInterval(() => {}, 1000);
  setTimeout(() => {
    emit(finalMessage("late valid result"));
    emit({ type: "agent_settled" });
  }, Number(process.env.FAKE_PI_DELAY_MS ?? 100));
  process.on("SIGTERM", () => {
    clearInterval(timer);
    if (signalPath) appendFileSync(signalPath, "SIGTERM\n");
    process.exit(143);
  });
} else if (scenario === "stderr-tail") {
  process.stderr.write(`${"x".repeat(70 * 1024)}END`);
} else {
  process.stderr.write(`Unknown fixture scenario: ${scenario}\n`);
  process.exitCode = 2;
}
