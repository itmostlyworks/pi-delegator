import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import delegateMcpExtension, { createDelegateMcpTransportFactory } from "../src/delegate-mcp-extension.ts";
import { createDelegateBashOperations } from "../src/delegate-bash-extension.ts";
import { DELEGATE_CHILD_ENV } from "../src/delegate-child-contract.ts";

function entry(config) { return { name: "fixture", config, source: "test", scope: "user" }; }
function fakeTransport() {
  const events = { message: new Set(), error: new Set(), close: new Set() };
  return {
    started: 0, closed: 0, stderr: "diagnostic", version: undefined, sent: [],
    async start() { this.started++; },
    async close() { this.closed++; for (const fn of events.close) fn(); },
    async send(message) { this.sent.push(message); },
    setProtocolVersion(version) { this.version = version; },
    onMessage(fn) { events.message.add(fn); return () => events.message.delete(fn); },
    onError(fn) { events.error.add(fn); return () => events.error.delete(fn); },
    onClose(fn) { events.close.add(fn); return () => events.close.delete(fn); },
    emit(kind, value) { for (const fn of events[kind]) fn(value); },
  };
}

function setEnv(name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return () => { if (before === undefined) delete process.env[name]; else process.env[name] = before; };
}

test("stdio factory preserves native home/cwd and environment template semantics", async () => {
  const restore = setEnv("DELEGATOR_MCP_TEST_TOKEN", "secret");
  try {
    let options;
    const real = fakeTransport();
    const factory = createDelegateMcpTransportFactory({ stdio(value) { options = value; return real; } });
    const transport = factory(entry({ command: "~/bin/server", args: ["~", "~/input", "$LITERAL"], cwd: "relative", env: {
      TOKEN: "Bearer ${DELEGATOR_MCP_TEST_TOKEN}/$DELEGATOR_MCP_TEST_TOKEN",
      LITERAL: "$$TOKEN $!hello ${bad-name} $9 ${unterminated", EMPTY: "",
    } }), "/tmp", undefined);
    assert.equal(options, undefined, "factory must not launch or resolve commands");
    await transport.start();
    assert.deepEqual(options, {
      command: join(homedir(), "bin/server"), args: [homedir(), join(homedir(), "input"), "$LITERAL"],
      cwd: "/tmp/relative", env: { TOKEN: "Bearer secret/secret", LITERAL: "$TOKEN !hello ${bad-name} $9 ${unterminated", EMPTY: "" }, stderr: "pipe",
    });
    assert.equal(transport.stderr, "diagnostic");
    await transport.close();
  } finally { restore(); }
});

test("HTTP header resolution preserves the exact native auth provider", async () => {
  const restore = setEnv("DELEGATOR_MCP_TEST_TOKEN", "secret");
  try {
    let options;
    const auth = { async token() { throw new Error("factory must not invoke auth"); } };
    const factory = createDelegateMcpTransportFactory({ http(value) { options = value; return fakeTransport(); } });
    const transport = factory(entry({ url: "https://example.invalid/mcp", headers: { Authorization: "Bearer $DELEGATOR_MCP_TEST_TOKEN", Literal: "$$ $!" } }), "/tmp", auth);
    await transport.start();
    assert.deepEqual(options.headers, { Authorization: "Bearer secret", Literal: "$ !" });
    assert.equal(options.authProvider, auth);
    assert.equal(options.url, "https://example.invalid/mcp");
    await transport.close();
    const empty = factory(entry({ url: "https://example.invalid/mcp", headers: {} }), "/tmp", auth);
    await empty.start();
    assert.equal(options.headers, undefined);
    await empty.close();
  } finally { restore(); }
});

test("OAuth command-valued secrets are rejected before transport construction or refresh", async () => {
  let authCalls = 0;
  const auth = { async token() { authCalls++; throw new Error("unsafe native refresh path"); } };
  const factory = createDelegateMcpTransportFactory({
    http() { assert.fail("must reject before HTTP/OAuth refresh can run"); },
    operations: { async exec() { assert.fail("OAuth commands must not run"); } },
  });
  const transport = factory(entry({ url: "https://example.invalid/mcp", oauth: { clientSecret: "!sleep 100" } }), "/tmp", auth);
  await assert.rejects(transport.start(), /oauth\.clientSecret cannot use a shell command.*environment variable.*\$\{VARIABLE\}/);
  assert.equal(authCalls, 0);
  await transport.close();

  for (const clientSecret of ["literal-secret", "${DELEGATOR_MCP_TEST_TOKEN}"]) {
    const supported = createDelegateMcpTransportFactory({ http(options) {
      assert.equal(options.authProvider, auth);
      return fakeTransport();
    } })(entry({ url: "https://example.invalid/mcp", oauth: { clientSecret } }), "/tmp", auth);
    await supported.start();
    await supported.close();
  }
});

test("missing and empty environment values fail before transport construction", async () => {
  for (const value of [undefined, ""]) {
    const restore = setEnv("DELEGATOR_MCP_TEST_TOKEN", value);
    try {
      const factory = createDelegateMcpTransportFactory({ stdio() { assert.fail("must not construct"); } });
      const transport = factory(entry({ command: "unused", env: { TOKEN: "$DELEGATOR_MCP_TEST_TOKEN" } }), "/tmp", undefined);
      await assert.rejects(transport.start(), /env "TOKEN".*environment variable.*DELEGATOR_MCP_TEST_TOKEN.*nonempty/);
      await transport.close();
    } finally { restore(); }
  }
});

test("config commands run asynchronously with timeout, trim output, and report bounded failures", async () => {
  for (const mode of ["ok", "exit", "empty", "overflow", "timeout"]) {
    let options;
    const operations = { async exec(command, cwd, settings) {
      assert.equal(cwd, "/tmp");
      assert.equal(settings.timeout, 10);
      assert.match(command, /2>\/dev\/null$/);
      assert.ok(settings.signal instanceof AbortSignal);
      if (mode === "timeout") throw new Error("timeout:10");
      if (mode === "overflow") { settings.onData(Buffer.alloc(1024 * 1024)); settings.onData(Buffer.from("x")); }
      else settings.onData(Buffer.from(mode === "empty" ? " \n" : " token \n"));
      return { exitCode: mode === "exit" ? 3 : 0 };
    } };
    const factory = createDelegateMcpTransportFactory({ operations, stdio(value) { options = value; return fakeTransport(); } });
    const transport = factory(entry({ command: "unused", env: { TOKEN: "!get-token" } }), "/tmp", undefined);
    if (mode === "ok") { await transport.start(); assert.equal(options.env.TOKEN, "token"); }
    else { await assert.rejects(transport.start(), /Failed to resolve.*shell command/); assert.equal(options, undefined); }
    await transport.close();
  }
});

test("real config command captures stdout only and rejects nonzero exits", async () => {
  const operations = createDelegateBashOperations((code) => assert.fail(`unexpected terminal failure ${code}`));
  let options;
  const factory = createDelegateMcpTransportFactory({ operations, stdio(value) { options = value; return fakeTransport(); } });
  const transport = factory(entry({ command: "unused", env: { TOKEN: "!printf ' token '; printf 'not-a-token' >&2" } }), "/tmp", undefined);
  await transport.start();
  assert.equal(options.env.TOKEN, "token");
  await transport.close();
  const failed = factory(entry({ command: "unused", env: { TOKEN: "!exit 4" } }), "/tmp", undefined);
  await assert.rejects(failed.start(), /command exited with 4/);
  await failed.close();
});

test("closing during config command aborts resolution and prevents late construction", async () => {
  let finish, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let signal;
  const factory = createDelegateMcpTransportFactory({
    operations: { exec(_command, _cwd, settings) { signal = settings.signal; entered(); return new Promise((resolve) => { finish = () => { settings.onData(Buffer.from("late")); resolve({ exitCode: 0 }); }; }); } },
    stdio() { assert.fail("closed config resolution must not construct or launch"); },
  });
  const transport = factory(entry({ command: "unused", env: { TOKEN: "!sleep" } }), "/tmp", undefined);
  let closes = 0;
  transport.onClose(() => closes++);
  const starting = transport.start();
  const rejected = assert.rejects(starting, /closed/i);
  await ready;
  await transport.close();
  assert.equal(signal.aborted, true);
  assert.equal(closes, 1);
  finish();
  await rejected;
  await transport.close();
  assert.equal(closes, 1);
});

test("close before start cannot resolve commands or construct a transport", async () => {
  const factory = createDelegateMcpTransportFactory({
    operations: { async exec() { assert.fail("closed transport must not execute"); } },
    stdio() { assert.fail("closed transport must not construct"); },
  });
  const transport = factory(entry({ command: "unused", env: { TOKEN: "!get-token" } }), "/tmp", undefined);
  await transport.close();
  await assert.rejects(transport.start(), /closed/i);
});

test("close during real startup is idempotent and forwards events and protocol version", async () => {
  const real = fakeTransport();
  let finish;
  real.start = () => new Promise((resolve) => { finish = resolve; });
  const factory = createDelegateMcpTransportFactory({ stdio: () => real });
  const transport = factory(entry({ command: "unused" }), "/tmp", undefined);
  const messages = [], errors = [];
  let closes = 0;
  const unsubscribe = transport.onMessage((message) => messages.push(message));
  transport.onError((error) => errors.push(error));
  transport.onClose(() => closes++);
  transport.setProtocolVersion("test-version");
  const starting = transport.start();
  const rejected = assert.rejects(starting, /closed/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(real.version, "test-version");
  real.emit("message", { jsonrpc: "2.0", method: "test" });
  real.emit("error", new Error("diagnostic"));
  assert.equal(messages.length, 1);
  assert.equal(errors.length, 1);
  unsubscribe();
  real.emit("message", {});
  assert.equal(messages.length, 1);
  await Promise.all([transport.close(), transport.close()]);
  assert.equal(real.closed, 1);
  assert.equal(closes, 1);
  finish();
  await rejected;
  await assert.rejects(transport.send({}), /closed/i);
});

test("only the delegate marker registers native MCP hooks and command", () => {
  for (const marker of [undefined, "wrong", "1"]) {
    const restore = setEnv(DELEGATE_CHILD_ENV, marker);
    try {
      const hooks = [], commands = [];
      delegateMcpExtension({
        on(name) { hooks.push(name); return () => {}; },
        registerToolRenderer() {},
        registerCommand(name) { commands.push(name); },
      });
      if (marker === "1") {
        assert.deepEqual(commands, ["mcp"]);
        assert.ok(hooks.includes("session_start"));
        assert.ok(hooks.includes("session_shutdown"));
        assert.ok(hooks.includes("mcp_servers_change"));
      } else { assert.deepEqual(commands, []); assert.deepEqual(hooks, []); }
    } finally { restore(); }
  }
});
