import assert from "node:assert/strict";
import test from "node:test";

import { classifyBashTool } from "../src/bash-classification.ts";

test("classifies only short, known Bash commands", () => {
  assert.equal(classifyBashTool({ command: "agent-browser open https://example.com" }), "bash(agent-browser)");
  assert.equal(classifyBashTool({ command: "pnpm test -- --runInBand" }), "bash(pnpm test)");
  assert.equal(classifyBashTool({ command: "curl https://example.com/status" }), "bash(curl)");
  assert.equal(classifyBashTool({ command: "unknown-command do-something" }), "bash");
});

test("falls back instead of rendering oversized or unclear commands", () => {
  assert.equal(classifyBashTool({ command: `curl ${"x".repeat(1_025)}` }), "bash");
  assert.equal(classifyBashTool({ command: "cd app && pnpm test" }), "bash");
  assert.equal(classifyBashTool({ command: "/usr/bin/curl https://example.com" }), "bash");
  assert.equal(classifyBashTool({ command: "curl/path" }), "bash");
  assert.equal(classifyBashTool({ command: "curl\"$SUFFIX\"" }), "bash");
  assert.equal(classifyBashTool({ command: "pnpm test/foo" }), "bash");
});

test("falls back for malformed Bash arguments", () => {
  for (const args of [undefined, null, "pnpm test", [], {}, { command: 42 }, { command: "" }]) {
    assert.equal(classifyBashTool(args), "bash");
  }
});

test("sensitive commands never receive a detailed label", () => {
  const commands = [
    "API_TOKEN=hidden curl https://example.com",
    "curl -H 'Authorization: Bearer hidden' https://example.com",
    "curl --header=X-Api-Key:hidden https://example.com",
    "curl -HX-Internal:private https://example.com",
    "curl -u alice:hunter2 https://example.com",
    "curl \"$SIGNED_URL\"",
    "curl https://example.com/path?token=hidden",
    "curl ftp://example.com/path?session=hidden",
    "curl https://user:password@example.com/path",
    "pnpm test --password hidden",
  ];
  for (const command of commands) assert.equal(classifyBashTool({ command }), "bash");
});
