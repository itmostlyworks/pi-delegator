import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as hostMcp from "@earendil-works/pi-mcp";

// An installed extension can have its own MCP dependency while Pi aliases its
// public API to the host. Exercise that topology, not just npm's deduped tree.
test("HTTP transport errors use host Pi constructors across separate package installations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-http-"));
  const server = createServer();
  let transport;
  let status = 200;
  server.on("request", (request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.method === "DELETE") { response.writeHead(204).end(); return; }
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Mcp-Session-Id", "fixture-session");
      response.writeHead(status);
      response.end(status === 200 ? JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: {} }) : "fixture failure");
    });
  });
  try {
    await mkdir(join(directory, "node_modules", "@earendil-works"), { recursive: true });
    const duplicate = join(directory, "node_modules", "@earendil-works", "pi-mcp");
    await cp(resolve("node_modules/@earendil-works/pi-mcp"), duplicate, { recursive: true });
    await symlink(resolve("node_modules/cross-spawn"), join(directory, "node_modules", "cross-spawn"), "dir");
    await symlink(resolve("node_modules/@earendil-works/pi-coding-agent"), join(directory, "node_modules", "@earendil-works", "pi-coding-agent"), "dir");
    await cp(resolve("src/delegate-mcp-extension.ts"), join(directory, "delegate-mcp-extension.ts"));
    for (const name of ["delegate-bash-extension.ts", "delegate-child-contract.ts", "delegate-mcp-transport.ts"]) {
      await symlink(resolve("src", name), join(directory, name));
    }
    const localMcp = await import(pathToFileURL(join(duplicate, "dist/index.js")).href);
    assert.notEqual(localMcp.McpHttpError, hostMcp.McpHttpError, "fixture must really have different constructors");
    const { createDelegateMcpTransportFactory } = await import(pathToFileURL(join(directory, "delegate-mcp-extension.ts")).href);
    await new Promise(resolveListening => server.listen(0, "127.0.0.1", resolveListening));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    transport = createDelegateMcpTransportFactory()({ name: "http", source: "fixture", config: { url } }, directory, undefined);
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    for (const [code, expected] of [[503, hostMcp.McpHttpError], [429, hostMcp.McpHttpError], [404, hostMcp.McpSessionExpiredError], [401, hostMcp.McpAuthRequiredError]]) {
      status = code;
      await assert.rejects(transport.send({ jsonrpc: "2.0", id: code, method: "tools/list", params: {} }), error => {
        assert(error instanceof expected, `${code}: native Pi must recognize the transport error`);
        assert(!(error instanceof localMcp.McpHttpError), "must not use extension-local error constructors");
        return true;
      });
    }
  } finally {
    await transport?.close();
    server.closeAllConnections();
    await new Promise(resolveClosed => server.close(resolveClosed));
    await rm(directory, { recursive: true, force: true });
  }
});
