import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { captureProcessSession, createProcessSessionController } from '../src/process-tree.ts';

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

if (process.platform !== 'win32') {
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
