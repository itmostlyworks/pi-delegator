#!/usr/bin/env node

import { appendFileSync, statSync, writeFileSync } from "node:fs";

const scenario = process.env.FAKE_PI_SCENARIO ?? "clean";
const recordPath = process.env.FAKE_PI_RECORD_PATH;
const signalPath = process.env.FAKE_PI_SIGNAL_PATH;
const promptModePath = process.env.FAKE_PI_PROMPT_MODE_PATH;
const cwdPath = process.env.FAKE_PI_CWD_PATH;
const childArgs = process.argv.slice(2);

if (recordPath) writeFileSync(recordPath, JSON.stringify(childArgs));
if (cwdPath) writeFileSync(cwdPath, process.cwd());
if (promptModePath) {
  const promptIndex = childArgs.indexOf("--append-system-prompt");
  const promptPath = childArgs[promptIndex + 1];
  writeFileSync(promptModePath, String(statSync(promptPath).mode & 0o777));
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
} else if (scenario === "no-answer") {
  emit({ type: "agent_settled" });
} else if (scenario === "assistant-error") {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "fixture model error",
    },
  });
} else if (scenario === "oversized") {
  process.stdout.write("x".repeat(1024 * 1024 + 1));
  setInterval(() => {}, 1000);
} else if (scenario === "hang") {
  const timer = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    if (signalPath) appendFileSync(signalPath, "SIGTERM\n");
    process.exit(143);
  });
} else {
  process.stderr.write(`Unknown fixture scenario: ${scenario}\n`);
  process.exitCode = 2;
}
