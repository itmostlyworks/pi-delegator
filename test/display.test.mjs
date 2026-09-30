import assert from "node:assert/strict";
import test from "node:test";
import { compactDisplayText, formatProgress, terminalSafe, toolStartLabel } from "../src/display.ts";

const start = (toolName, args = {}) => ({ type: "tool_start", toolName, args });
const message = (text) => ({ type: "assistant_message", text });
const state = () => ({ totalCalls: 0, recentTools: [] });

test("labels expose only bounded path targets and safe bash categories", () => {
  for (const name of ["read", "grep", "find", "ls", "edit", "write"]) {
    assert.equal(toolStartLabel(name, { path: "/repo/src/file.ts", pattern: "secret", command: "secret", content: "secret" }, "/repo"), `${name} src/file.ts`);
  }
  assert.equal(toolStartLabel("read", { path: "src/file.ts", offset: 20 }, "/repo"), "read src/file.ts:20");
  assert.equal(toolStartLabel("read", { path: ".", offset: -1 }, "/repo"), "read .");
  assert.equal(toolStartLabel("grep", { pattern: "secret" }, "/repo"), "grep");
  assert.equal(toolStartLabel("unknown", { path: "secret", command: "secret" }, "/repo"), "unknown");
  assert.equal(toolStartLabel("bash", { command: "npm test -- --runInBand" }, "/repo"), "bash(npm test)");
  assert.equal(toolStartLabel("bash", { command: "curl -H 'Authorization: secret'" }, "/repo"), "bash");
  for (const args of [null, [], "secret", { path: 10 }]) assert.equal(toolStartLabel("read", args, "/repo"), "read");
  assert.equal(Array.from(toolStartLabel("write", { path: "😀".repeat(500) }, "/repo")).length, 167);
});

test("all display inputs remove terminal commands, controls, bidi and normalize whitespace", () => {
  const hostile = "\x1b[31mred\x1b[0m\x1b]8;;https://secret\x07link\x1b]8;;\x07\x00\x08\u202e\n next";
  assert.equal(compactDisplayText(hostile, 100), "redlink next");
  assert.equal(terminalSafe(hostile), "redlink\n next");
  assert.equal(toolStartLabel("\x1b[31munknown\x1b[0m", {}, "/repo"), "unknown");
  assert.equal(toolStartLabel("read", { path: "src/\x1b[31mfile\x1b[0m\u202e" }, "/repo"), "read src/file");
  assert.equal(compactDisplayText("😀".repeat(300), 240), `${"😀".repeat(240)}…`);
});

test("recent starts are not compressed or completion claims; commentary persists and states isolate", () => {
  const a = state();
  const b = state();
  formatProgress(message("Inspecting\n files"), a, "/repo");
  for (let i = 0; i < 9; i++) formatProgress(start("read", { path: `file${i}` }), a, "/repo");
  const text = formatProgress(message(" \n "), a, "/repo");
  assert.equal(text, "Recent tool starts · 9 total · 5 earlier\n· read file5\n· read file6\n· read file7\n→ read file8\n\nLatest commentary: Inspecting files");
  assert.equal(a.recentTools.length, 4);
  assert.equal(formatProgress(start("ls", { path: "." }), b, "/other"), "Recent tool starts · 1 total\n→ ls .");
  assert.equal(formatProgress(message(undefined), b, "/other"), "Recent tool starts · 1 total\n→ ls .");
  assert.equal(a.totalCalls, 9);
});
