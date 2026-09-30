#!/usr/bin/env node

// Per-call schedules keep parallel heartbeat tests independent of shared environment state.
const { label, activity = true, finishMs = 3_350, failure } = JSON.parse(process.argv.at(-1).replace(/^Task: /, ""));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (activity) {
  setTimeout(() => emit({
    type: "message_end",
    message: {
      role: "assistant", content: [{ type: "text", text: label }], stopReason: "toolUse",
      usage: { input: 7, output: 3, cost: { total: 0.02 } },
    },
  }), 250);
  setTimeout(() => emit({
    type: "tool_execution_start", toolCallId: label, toolName: "read", args: { path: `${label}.ts` },
  }), 450);
  setTimeout(() => emit({
    type: "message_end",
    message: {
      role: "assistant", content: [{ type: "text", text: `${label} follow-up` }], stopReason: "toolUse",
      usage: { input: 5, output: 2, cost: { total: 0.01 } },
    },
  }), 1_450);
  setTimeout(() => emit({
    type: "tool_execution_start", toolCallId: `${label}-follow-up`, toolName: "grep", args: {},
  }), 1_650);
}
setTimeout(() => {
  if (failure === "protocol") {
    process.stdout.write("x".repeat(1024 * 1024 + 1));
  } else if (failure === "child") {
    emit({ type: "agent_settled" });
  } else {
    emit({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: `${label} complete` }], stopReason: "stop",
    } });
    emit({ type: "agent_settled" });
  }
}, finishMs);
