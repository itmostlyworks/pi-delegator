import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PENDING_JSONL_BYTES,
  ProtocolLineTooLargeError,
  ProtocolParser,
} from "../src/protocol.ts";

test("parses split chunks and several events in one chunk", () => {
  const updates = [];
  const parser = new ProtocolParser({ onAssistantMessage: (text) => updates.push(text) });
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

test("reports tool starts and aggregates assistant usage", () => {
  const toolStarts = [];
  const assistantMessages = [];
  const parser = new ProtocolParser({
    onToolStart: (toolName) => toolStarts.push(toolName),
    onAssistantMessage: (text) => assistantMessages.push(text),
  });
  parser.push(Buffer.from([
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "checking" }],
        stopReason: "toolUse",
        usage: {
          input: 3,
          output: 2,
          cacheRead: 1,
          cacheWrite: 4,
          totalTokens: 6,
          cost: { total: 0.01 },
        },
      },
    }),
    JSON.stringify({ type: "tool_execution_start", toolCallId: "one", toolName: "read" }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: {
          input: 5,
          output: 7,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 13,
          cost: { total: 0.02 },
        },
      },
    }),
    "",
  ].join("\n")));

  assert.deepEqual(toolStarts, ["read"]);
  assert.deepEqual(assistantMessages, ["checking", "done"]);
  assert.deepEqual(parser.state.usage, {
    input: 8,
    output: 9,
    cacheRead: 3,
    cacheWrite: 5,
    cost: 0.03,
    contextTokens: 13,
    turns: 2,
  });
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

test("discards oversized tool-result events and continues with later lines", () => {
  const parser = new ProtocolParser({ maxPendingBytes: 256 });
  const toolResult = `${JSON.stringify({
    sessionId: "fixture",
    type: "message_end",
    message: {
      toolCallId: "large-result",
      toolName: "browser",
      content: [{ type: "text", text: "small prefix" }],
      role: "toolResult",
      details: "x".repeat(500),
    },
  })}\n`;
  const final = `${JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "work preserved" }], stopReason: "stop" },
  })}\n`;
  const output = Buffer.from(`${toolResult}${final}`);

  parser.push(output.subarray(0, 200));
  parser.push(output.subarray(200));

  assert.equal(parser.state.finalText, "work preserved");
});

test("rejects oversized assistant and unclassifiable JSONL lines", () => {
  const oversizedAssistant = Buffer.from(`${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        arguments: { message: { role: "toolResult" }, padding: "x".repeat(500) },
      }],
      stopReason: "error",
    },
  })}\n`);
  assert.throws(
    () => new ProtocolParser({ maxPendingBytes: 256 }).push(oversizedAssistant),
    ProtocolLineTooLargeError,
  );

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
