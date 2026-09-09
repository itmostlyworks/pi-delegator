#!/usr/bin/env node

import { writeFileSync } from "node:fs";

import delegateBashExtension from "../../src/delegate-bash-extension.ts";

let bashTool;
delegateBashExtension({
  registerTool(tool) {
    if (tool.name === "bash") bashTool = tool;
  },
});
if (!bashTool) throw new Error("delegate Bash override did not register");

const pidPath = process.env.REAL_PI_BASH_DESCENDANT_PID_PATH;
if (!pidPath) throw new Error("REAL_PI_BASH_DESCENDANT_PID_PATH is required");

const scenario = process.env.REAL_PI_BASH_SCENARIO ?? "background-complete";
const command = scenario === "background-complete"
  ? 'sleep 30 & echo $! > "$REAL_PI_BASH_DESCENDANT_PID_PATH"'
  : 'sleep 30 & echo $! > "$REAL_PI_BASH_DESCENDANT_PID_PATH"; wait';

function emitTerminal(text) {
  process.stdout.write(`${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
}

if (scenario === "candidate-then-timeout") emitTerminal("must not survive Bash timeout");

const controller = scenario === "own-abort" ? new AbortController() : undefined;
if (controller) setTimeout(() => controller.abort(), 75);
const timeout = scenario === "own-timeout" || scenario === "candidate-then-timeout" ? 0.075 : undefined;
const result = await bashTool.execute(
  "integration-bash",
  { command, ...(timeout === undefined ? {} : { timeout }) },
  controller?.signal,
  undefined,
);
if (scenario === "background-complete") {
  writeFileSync(process.env.REAL_PI_BASH_RESULT_PATH, result.content[0]?.text ?? "");
  emitTerminal("real Bash completed");
}
