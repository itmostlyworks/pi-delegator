import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DelegateMcpStdioTransport } from '../src/delegate-mcp-transport.ts';
import { DELEGATE_CHILD_ENV, DELEGATE_BASH_CLEANUP_EXIT_CODE } from '../src/delegate-child-contract.ts';

const fixture = new URL('./fixtures/mcp-server.mjs', import.meta.url).pathname;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function next(transport, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`waiting for ${event}`)); }, 6000);
    const unsubscribe = transport[event]((value) => { clearTimeout(timer); unsubscribe(); resolve(value); });
  });
}
function transport(mode, options = {}) {
  const failures = [];
  const instance = new DelegateMcpStdioTransport({ command: process.execPath, args: [fixture, mode], closeTimeoutMs: 100, ...options }, (code) => { failures.push(code); throw new Error('fail delegate'); });
  return { instance, failures };
}
function live(pid) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 500 });
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}

test('RPC preserves argv/stdin, caller session, cwd and inherited env; close is idempotent', async () => {
  const args = ['space here', '$(touch /not-a-real-command)', '"quoted"', '; exit 42'];
  const { instance, failures } = transport('rpc', { args: [fixture, 'rpc', ...args], env: { [DELEGATE_CHILD_ENV]: '1', MCP_TEST_VALUE: 'value' }, cwd: '/tmp' });
  let closes = 0;
  instance.onClose(() => closes++);
  try {
    await instance.start();
    const response = next(instance, 'onMessage');
    await instance.send({ jsonrpc: '2.0', id: 1, method: 'echo', params: { unicode: 'héllo' } });
    const { result } = await response;
    assert.deepEqual(result.argv, args);
    assert.deepEqual(result.params, { unicode: 'héllo' });
    assert.equal(result.cwd, '/tmp');
    assert.equal(result.env.MCP_TEST_VALUE, 'value');
    assert.equal(result.env[DELEGATE_CHILD_ENV], undefined);
    assert.equal(result.env.PATH, process.env.PATH);
    assert.equal(result.pid, instance.pid);
    if (process.platform === 'linux') {
      const session = (pid) => spawnSync('ps', ['-o', 'sess=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      assert.equal(session(instance.pid), session(process.pid));
      const pgid = (pid) => spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      assert.notEqual(pgid(instance.pid), pgid(process.pid));
    }
    const first = instance.close();
    assert.equal(first, instance.close());
    await first;
    assert.equal(closes, 1);
    assert.equal(live(result.pid), false);
    assert.deepEqual(failures, []);
    await assert.rejects(instance.send({ jsonrpc: '2.0', method: 'late' }));
  } finally { await instance.close(); }
});

test('inheritEnv false excludes ambient env and strips child marker', async () => {
  const { instance } = transport('rpc', { inheritEnv: false, env: { MCP_ONLY: 'yes', [DELEGATE_CHILD_ENV]: '1' } });
  try {
    await instance.start();
    const response = next(instance, 'onMessage');
    await instance.send({ jsonrpc: '2.0', id: 2, method: 'echo' });
    const { result } = await response;
    assert.equal(result.env.MCP_ONLY, 'yes');
    assert.equal(result.env.HOME, undefined);
    assert.equal(result.env[DELEGATE_CHILD_ENV], undefined);
  } finally { await instance.close(); }
});

for (const mode of ['huge', 'malformed', 'partial']) {
  test(`${mode} JSONL notifies error and cleans up automatically`, async () => {
    const { instance, failures } = transport(mode);
    const error = next(instance, 'onError');
    const closed = next(instance, 'onClose');
    await instance.start().catch(() => {});
    const pid = instance.pid;
    assert.ok(await error);
    await closed;
    await instance.close();
    assert.equal(live(pid), false);
    assert.deepEqual(failures, []);
  });
}

test('stderr retains a bounded tail', async () => {
  const { instance } = transport('stderr');
  const ready = next(instance, 'onMessage');
  try {
    await instance.start(); await ready;
    await delay(50);
    assert.equal(Buffer.byteLength(instance.stderr), 64 * 1024);
    assert.ok(instance.stderr.endsWith('TAIL'));
  } finally { await instance.close(); }
});

test('spawn error rejects start without a fatal containment error when no job launched', async () => {
  const { instance, failures } = transport('rpc', { cwd: '/nonexistent-pi-mcp-cwd' });
  await assert.rejects(instance.start(), /ENOENT/);
  await instance.close();
  assert.deepEqual(failures, []);
});

test('missing executable is reported and cleanup still completes', async () => {
  const { instance, failures } = transport('rpc', { command: '/nonexistent-pi-mcp-executable' });
  const error = next(instance, 'onError');
  const closed = next(instance, 'onClose');
  await instance.start().catch(() => {});
  assert.match((await error).message, /exited/);
  await closed;
  await instance.close();
  assert.deepEqual(failures, []);
});

test('EOF/TERM resistant server is killed within bounded close', async () => {
  const { instance, failures } = transport('resistant');
  const ready = next(instance, 'onMessage');
  await instance.start();
  const { params } = await ready;
  const started = Date.now();
  await instance.close();
  assert.ok(Date.now() - started < 3000);
  assert.equal(live(params.pid), false);
  assert.deepEqual(failures, []);
});

for (const mode of ['leader-hold', 'leader-close']) {
  test(`${mode}: leader exit cleans descendants even after pipes close`, async () => {
    const { instance, failures } = transport(mode);
    const ready = next(instance, 'onMessage');
    const closed = next(instance, 'onClose');
    await instance.start();
    const { params } = await ready;
    await closed;
    await instance.close();
    assert.equal(live(params.pid), false);
    assert.equal(live(params.descendant), false);
    assert.deepEqual(failures, []);
  });
}

test('unverifiable cleanup calls injected failDelegate even when it throws', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', new URL('./fixtures/mcp-unsafe-cleanup.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 6000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.failures, [DELEGATE_BASH_CLEANUP_EXIT_CODE]);
  assert.match(report.rejection, /cleanup failed/);
  assert.ok(report.errors.some((error) => error.includes('cleanup failed')));
  assert.equal(live(report.pid), false);
});

test('close before start and close during handshake settle once', async () => {
  const { instance: unused } = transport('rpc');
  await unused.close();
  await assert.rejects(unused.start());
  const { instance, failures } = transport('rpc');
  const starting = assert.rejects(instance.start());
  await instance.close();
  await starting;
  assert.deepEqual(failures, []);
});
