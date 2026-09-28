#!/usr/bin/env node

import { DELEGATE_BASH_CLEANUP_EXIT_CODE } from "../../src/delegate-child-contract.ts";

process.stdout.write(`${JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "false success" }], stopReason: "stop" },
})}\n`);
process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
// Simulate a Bash containment failure after a candidate answer. Never let the
// candidate mask the private child contract's reserved exit status.
setTimeout(() => process.exit(DELEGATE_BASH_CLEANUP_EXIT_CODE), 30);
