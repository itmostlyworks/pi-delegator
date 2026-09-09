#!/usr/bin/env node

import { createDelegateBashOperations } from "../../src/delegate-bash-extension.ts";

let settled = false;
let callbacksAfterSettlement = 0;
const startedAt = Date.now();
const operations = createDelegateBashOperations(() => {
  throw new Error("unexpected fail-whole-delegate callback");
});
const result = await operations.exec('(sleep 0.2; printf "late") &', process.cwd(), {
  onData() {
    if (settled) callbacksAfterSettlement += 1;
  },
  env: process.env,
});
settled = true;
const settledAfterMs = Date.now() - startedAt;
await new Promise((resolve) => setTimeout(resolve, 300));
process.stdout.write(`${JSON.stringify({ ...result, settledAfterMs, callbacksAfterSettlement })}\n`);
