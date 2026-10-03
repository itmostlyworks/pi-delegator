import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureProcessSession, createProcessSessionController, createProcessTreeController } from '../src/process-tree.ts';

const ps = () => {
  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,sess=,stat='], { encoding: 'utf8', timeout: 250, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map((line) => {
    const [pid, pgid, sess, stat] = line.trim().split(/\s+/);
    return { pid: Number(pid), pgid: Number(pgid), sess, stat };
  });
};
const live = (key) => ps().filter((row) => row.sess === key && !row.stat.startsWith('Z'));
const waitFor = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for session jobs');
};

// Top-level tests run serially: restore PATH and kill mocks before real lifecycle tests.
const fakePs = (t, output) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-delegator-ps-'));
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  });
  const setOutput = (text, status = 0) => {
    const quoted = `'${text.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(directory, 'ps'), `#!/bin/sh\n[ "$1" = '-axo' ] && [ "$2" = 'pid=,pgid=,sess=,stat=' ] || exit 99\nprintf '%s' ${quoted}\nexit ${status}\n`, { mode: 0o700 });
  };
  setOutput(output);
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  return setOutput;
};
const assertRuntime = (message) => {
  for (const marker of [
    `platform=${process.platform}`, `release=${JSON.stringify(release().slice(0, 80))}`, `arch=${process.arch}`,
    `node=${process.version}`, `uv=${process.versions.uv}`, 'ps="ps -axo pid=,pgid=,sess=,stat="',
  ]) assert.ok(message.includes(marker), `Missing ${marker}: ${message}`);
};
const captureError = (pid) => {
  let caught;
  try { captureProcessSession(pid); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error, 'Expected capture to fail');
  return caught.message;
};

if (process.platform !== 'win32') {
  const gatePid = 987654321;
  const parentRow = `${process.pid} ${process.pid} parent-session S`;
  const gateRow = `${gatePid} ${gatePid} gate-session Ss`;
  for (const [check, gate, parent] of [
    ['gate_not_group_leader', `${gatePid} ${gatePid - 1} gate-session Ss`, parentRow],
    ['gate_session_unusable', `${gatePid} ${gatePid} **** Ss`, parentRow],
    ['parent_session_unusable', gateRow, `${process.pid} ${process.pid} 0 S`],
    ['session_matches_parent', `${gatePid} ${gatePid} parent-session Ss`, parentRow],
  ]) {
    test(`capture diagnostics identify ${check} and both rows`, (t) => {
      fakePs(t, `${gate}\n${parent}\n`);
      const message = captureError(gatePid);
      assert.match(message, /^Unsafe launch gate session:/);
      assert.ok(message.includes(check), message);
      for (const [label, row] of [['gate', gate], ['parent', parent]]) {
        const [pid, pgid, sess, stat] = row.split(' ');
        assert.ok(message.includes(`${label}={pid=${pid},pgid=${pgid},sess=${JSON.stringify(sess)},stat=${JSON.stringify(stat)}}`), message);
      }
      assertRuntime(message);
    });
  }

  for (const missing of ['gate', 'parent', 'both']) {
    test(`capture diagnostics identify missing ${missing} and expected PIDs`, (t) => {
      fakePs(t, missing === 'gate' ? `${parentRow}\n` : missing === 'parent' ? `${gateRow}\n` : '');
      const message = captureError(gatePid);
      assert.match(message, /^Cannot capture launch gate session:/);
      if (missing !== 'parent') assert.ok(message.includes('gate=missing'), message);
      if (missing !== 'gate') assert.ok(message.includes('parent=missing'), message);
      assert.ok(message.includes(String(gatePid)), message);
      assert.ok(message.includes(String(process.pid)), message);
      assertRuntime(message);
    });
  }

  test('capture diagnostics bound untrusted session keys and status fields', (t) => {
    const sess = `evil;${'x'.repeat(5000)}`;
    const stat = `S${'y'.repeat(5000)}`;
    fakePs(t, `${gatePid} ${gatePid} ${sess} ${stat}\n${parentRow}\n`);
    const message = captureError(gatePid);
    assert.match(message, /^Unsafe launch gate session:/);
    assert.ok(message.includes('gate_session_unusable'), message);
    const fields = /gate=\{pid=\d+,pgid=\d+,sess=([^,]*),stat=([^}]*)\}/.exec(message);
    assert.ok(fields, message);
    assert.ok(fields[1].length <= 84, 'Session diagnostic must stay near the 80-character bound');
    assert.ok(fields[2].length <= 84, 'Status diagnostic must stay near the 80-character bound');
    assert.ok(message.length < 1500);
    assertRuntime(message);
  });

  for (const [label, output, status] of [['failed ps', '', 7], ['malformed ps', 'not a process row\n', 0]]) {
    test(`capture ${label} diagnostics include runtime and ps invocation`, (t) => {
      const setOutput = fakePs(t, '');
      setOutput(output, status);
      const message = captureError(gatePid);
      assert.match(message, /^Cannot capture launch gate session:/);
      assert.match(message, status ? /ps exited with 7/ : /Malformed ps process row/);
      assertRuntime(message);
    });
  }

  for (const present of [false, true]) {
    test(`group cleanup preserves EPERM with ${present ? 'live' : 'absent'} group verification`, async (t) => {
      fakePs(t, `${parentRow}\n${present ? `${gateRow}\n` : ''}`);
      // Mock every signal, including KILL; never pass a synthetic PGID to the OS.
      const kill = t.mock.method(process, 'kill', (pid, signal) => {
        assert.equal(pid, -gatePid);
        assert.ok(['SIGTERM', 'SIGKILL'].includes(signal));
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });
      const controller = createProcessTreeController(gatePid, { termGraceMs: 0, killVerifyMs: 0 });
      const result = await controller.terminate();
      assert.equal(result.processGroupGone, !present);
      assert.equal(result.termSent, false);
      assert.equal(result.killSent, false);
      assert.ok(result.diagnostic?.includes(`SIGTERM group ${gatePid}: kill EPERM`), result.diagnostic);
      if (present) {
        assert.ok(result.diagnostic.includes(`SIGKILL group ${gatePid}: kill EPERM`), result.diagnostic);
        assert.match(result.diagnostic, /still has active members|not verified|verification failed/);
      } else {
        assert.match(result.diagnostic, /group verified gone/);
      }
      assert.equal(kill.mock.callCount(), present ? 2 : 1);
      assert.strictEqual(await controller.terminate(), result);
    });
  }

  test('capture rejects non-leaders, parent session and masked keys', () => {
    assert.throws(() => captureProcessSession(process.pid), /Unsafe launch gate session|Cannot capture launch gate session/);
    assert.throws(() => captureProcessSession(-1), /Invalid launch gate pid/);
    assert.throws(() => createProcessSessionController('****'), /Invalid or masked/);
    assert.throws(() => createProcessSessionController('0'), /Invalid or masked/);
  });

  test('session cleanup escalates TERM-resistant job group', async () => {
    const gate = spawn('/bin/sh', ['-c', "read release; exec /bin/bash -c 'set -m; (trap \"\" TERM; exec sleep 30) & wait'"], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    assert.ok(gate.pid);
    const key = captureProcessSession(gate.pid);
    const controller = createProcessSessionController(key, { termGraceMs: 100, killVerifyMs: 600 });
    try {
      gate.stdin.end('go\n');
      await waitFor(() => new Set(live(key).map((row) => row.pgid)).size >= 2);
      const result = await controller.terminate();
      assert.equal(result.processGroupGone, true, result.diagnostic);
      assert.equal(result.killSent, true);
      assert.deepEqual(live(key), []);
    } finally {
      await controller.terminate();
    }
  });

  for (const reparent of [false, true]) {
    test(`session cleanup kills multiple monitor-mode jobs${reparent ? ' after leader exits' : ''}`, async () => {
      // The sh gate holds the detached session open until capture completes.
      const command = reparent ? 'sleep 30 & sleep 30 & sleep 0.5; exit 0' : 'sleep 30 & sleep 30 & wait';
      const gate = spawn('/bin/sh', ['-c', `read release; exec /bin/bash -c 'set -m; ${command}'`], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      });
      assert.ok(gate.pid);
      const key = captureProcessSession(gate.pid);
      const controller = createProcessSessionController(key, { termGraceMs: 100, killVerifyMs: 600 });
      try {
        gate.stdin.end('go\n');
        await waitFor(() => new Set(live(key).map((row) => row.pgid)).size >= 3);
        const groups = new Set(live(key).map((row) => row.pgid));
        assert.ok(groups.size >= 3, 'leader and two separate job groups');
        if (reparent) await waitFor(() => !live(key).some((row) => row.pid === gate.pid));
        const result = await controller.terminate();
        assert.equal(result.processGroupGone, true, result.diagnostic);
        assert.equal(result.termSent, true);
        assert.strictEqual(await controller.terminate(), result);
        assert.deepEqual(live(key), []);
      } finally {
        // Only ever signal the captured, distinct session's currently live groups.
        await controller.terminate();
      }
    });
  }
}
