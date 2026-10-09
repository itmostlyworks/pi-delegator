#!/usr/bin/env node
// Deliberately tiny JSON-RPC server: no SDK mock replaces Pi's MCP client.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const inventory = process.env.REAL_PI_MCP_INVENTORY;
function record(kind) {
  const [pid, pgid, sid] = execFileSync("ps", ["-o", "pid=,pgid=,sess=", "-p", String(process.pid)], { encoding: "utf8", timeout: 1_000 }).trim().split(/\s+/).map(Number);
  appendFileSync(inventory, `${JSON.stringify({ kind, pid, pgid, sid })}\n`);
}
const descendant = process.argv.includes("--descendant");
record(descendant ? "descendant" : "server");
const hostile = process.env.REAL_PI_MCP_HOSTILE === "1";
if (hostile || descendant) {
  process.on("SIGTERM", () => record("term"));
  // Ignore EOF too; descendants keep inherited stdout/stderr open.
  setInterval(() => {}, 1_000);
}
if (descendant) {
  process.stdin.resume();
} else {
  if (hostile) {
    // Monitor mode creates a new PGID, but deliberately does NOT escape SID.
    spawn("/bin/bash", ["-p", "-c", 'set -m; trap "" TERM; "$1" "$2" --descendant & wait', "mcp-descendants", process.execPath, new URL(import.meta.url).pathname], {
      detached: false, stdio: ["ignore", "inherit", "inherit"], env: process.env,
    });
    // Initialize only after the regrouped pipe holder is observable. This
    // avoids relying on Node startup winning a race with semantic completion.
    const end = Date.now() + 2_000;
    while (!readFileSync(inventory, "utf8").includes('"kind":"descendant"')) {
      if (Date.now() >= end) throw new Error("Descendant did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    switch (message.method) {
      case "initialize":
        if (process.env.REAL_PI_MCP_STALL === "initialize") {
          record("initialize");
          return; // Request arrived, but leave Pi's actual initialization pending.
        }
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "deterministic-tiny", version: "1" }, instructions: "Tiny local echo tool" };
        break;
      case "tools/list":
        result = { tools: [{ name: "echo", description: "Tiny deterministic echo", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
        break;
      case "tools/call":
        if (message.params.name !== "echo") throw new Error("Unexpected MCP tool");
        record("call");
        if (process.env.REAL_PI_MCP_STALL === "call") return;
        result = { content: [{ type: "text", text: `mcp:${message.params.arguments.value}` }] };
        break;
      case "ping": result = {}; break;
      default:
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
        return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  });
  input.on("close", () => {
    record("eof");
    if (!hostile) process.exit(0);
  });
}
