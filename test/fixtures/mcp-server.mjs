import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
const emit = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'ready', params: result })}\n`);
if (mode === 'descendant') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'leader-hold' || mode === 'leader-close') {
  const child = spawn(process.execPath, [import.meta.filename, 'descendant'], {
    detached: false, stdio: mode === 'leader-hold' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
  });
  // Wait until the descendant has installed its signal handler.
  setTimeout(() => { emit({ pid: process.pid, descendant: child.pid }); process.exit(0); }, 150);
} else if (mode === 'huge') {
  process.stdout.write('x'.repeat(1024 * 1024 + 1));
  setInterval(() => {}, 1000);
} else if (mode === 'malformed') {
  process.stdout.write('{"jsonrpc":"2.0","bad":true}\n');
  setInterval(() => {}, 1000);
} else if (mode === 'partial') {
  process.stdout.write('{"jsonrpc":');
} else if (mode === 'resistant') {
  process.on('SIGTERM', () => {});
  process.stdin.resume();
  emit({ pid: process.pid });
  setInterval(() => {}, 1000);
} else if (mode === 'stderr') {
  process.stderr.write('x'.repeat(100000) + 'TAIL');
  emit({ pid: process.pid });
  process.stdin.resume();
} else {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      argv: process.argv.slice(3), params: message.params, env: process.env,
      pid: process.pid, cwd: process.cwd(),
    } })}\n`);
  });
}
