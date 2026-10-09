import { DelegateMcpStdioTransport } from '../../src/delegate-mcp-transport.ts';
// Isolate PATH fault injection from the test harness and other process tests.
const failures = [];
const errors = [];
const transport = new DelegateMcpStdioTransport({
  command: process.execPath,
  args: [new URL('./mcp-server.mjs', import.meta.url).pathname, 'resistant'],
  closeTimeoutMs: 50,
}, (code) => { failures.push(code); throw new Error('injected delegate termination'); });
transport.onError((error) => errors.push(error.message));
const ready = new Promise((resolve) => transport.onMessage(resolve));
await transport.start();
const { params: { pid } } = await ready;
const originalPath = process.env.PATH;
process.env.PATH = '/nonexistent-mcp-ps-path';
let rejection;
try { await transport.close(); } catch (error) { rejection = error.message; }
process.env.PATH = originalPath;
console.log(JSON.stringify({ failures, errors, rejection, pid }));
