import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PENDING_JSONL_BYTES,
  ProtocolLineTooLargeError,
  ProtocolParser,
} from "../src/protocol.ts";

test("parses split chunks and several events in one chunk", () => {
  const updates = [];
  const parser = new ProtocolParser({ onAssistantText: (text) => updates.push(text) });
  const output = [
    JSON.stringify({ type: "unknown" }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done ✓" }],
        stopReason: "stop",
      },
    }),
    JSON.stringify({ type: "agent_settled" }),
    "",
  ].join("\n");
  const bytes = Buffer.from(output);

  parser.push(bytes.subarray(0, 7));
  parser.push(bytes.subarray(7, 31));
  parser.push(bytes.subarray(31));

  assert.equal(parser.state.finalText, "done ✓");
  assert.equal(parser.state.agentSettled, true);
  assert.deepEqual(updates, ["done ✓"]);
});

test("retains malformed lines only as a bounded diagnostic count", () => {
  const parser = new ProtocolParser();
  parser.push(Buffer.from("not-json\n"));
  parser.push(Buffer.from(`${JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "valid" }], stopReason: "stop" },
  })}\n`));

  assert.equal(parser.state.malformedLineCount, 1);
  assert.equal(parser.state.finalText, "valid");
});

test("rejects an oversized pending JSONL line", () => {
  const parser = new ProtocolParser();
  assert.throws(
    () => parser.push(Buffer.alloc(MAX_PENDING_JSONL_BYTES + 1, 0x78)),
    ProtocolLineTooLargeError,
  );
});

test("does not trust assistant text without a terminal stop reason", () => {
  const parser = new ProtocolParser();
  parser.push(Buffer.from(`${JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "ambiguous" }] },
  })}\n`));

  assert.equal(parser.state.finalText, undefined);
});

test("captures assistant errors instead of terminal text", () => {
  const parser = new ProtocolParser();
  parser.push(Buffer.from(`${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "not a success" }],
      stopReason: "error",
      errorMessage: "provider failed",
    },
  })}\n`));

  assert.equal(parser.state.assistantError, "provider failed");
  assert.equal(parser.state.finalText, undefined);
});
