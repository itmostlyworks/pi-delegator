#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

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
  : `${scenario === "timeout-under-parent-interruption" ? 'trap "" TERM; ' : ""}sleep 30 & echo $! > "$REAL_PI_BASH_DESCENDANT_PID_PATH"; wait`;

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

if (scenario === "background-then-timeout" || scenario === "background-then-timeout-cancel") {
  await bashTool.execute("start-service", {
    command: 'sleep 30 & echo $! > "$REAL_PI_BASH_RESULT_PATH"',
  });
}

const controller = scenario === "own-abort" ? new AbortController() : undefined;
if (controller) setTimeout(() => controller.abort(), 75);
const timeout = scenario === "own-timeout" ||
  scenario === "background-then-timeout" || scenario === "background-then-timeout-cancel" ||
  scenario === "timeout-under-parent-interruption" ? 0.075 : undefined;
try {
  const result = await bashTool.execute(
    "integration-bash",
    { command, ...(timeout === undefined ? {} : { timeout }) },
    controller?.signal,
    undefined,
  );
  if (scenario === "background-complete") {
    writeFileSync(process.env.REAL_PI_BASH_RESULT_PATH, result.content[0]?.text ?? "");
    emitTerminal("real Bash completed");
  } else {
    throw new Error(`expected Bash interruption in ${scenario}`);
  }
} catch (error) {
  if (scenario === "own-abort" || scenario === "background-complete") throw error;
  if (!/timed out|timeout/i.test(String(error))) throw error;
  // A real Pi tool failure rejects; recovery must happen in this same child.
  if (scenario === "background-then-timeout" || scenario === "background-then-timeout-cancel") {
    const servicePid = Number(readFileSync(process.env.REAL_PI_BASH_RESULT_PATH, "utf8"));
    process.kill(servicePid, 0);
  }
  const next = await bashTool.execute("after-timeout", { command: "printf 'second command succeeded'" });
  if (!next.content[0]?.text?.includes("second command succeeded")) {
    throw new Error("second Bash command did not succeed");
  }
  if (scenario === "background-then-timeout-cancel") {
    writeFileSync(`${process.env.REAL_PI_BASH_RESULT_PATH}.ready`, "service survived timeout and retry");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  emitTerminal("recovered after Bash timeout");
}
