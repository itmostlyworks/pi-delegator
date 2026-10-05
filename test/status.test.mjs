import assert from "node:assert/strict";
import test from "node:test";
import { DelegateStatus } from "../src/status.ts";

function observer(mode = "tui", throws = false) {
  const values = [];
  const ctx = { mode, ui: { theme: { fg(color, text) {
    assert.equal(color, "dim", "footer uses the built-in statusline color");
    return text;
  } }, setStatus(key, value) {
    assert.equal(key, "pi-delegator");
    values.push(value);
    if (throws) throw new Error("observer failure");
  } } };
  return { ctx, values };
}

test("footer shows every active profile and groups duplicate runs", () => {
  const { ctx, values } = observer();
  const status = new DelegateStatus(ctx);
  const finishes = ["worker", "worker", "scout", "tester", "tester", "oracle"].map(name => status.begin(name, ctx));
  assert.equal(values.at(-1), "delegates: worker ×2 · scout · tester ×2 · oracle");
  finishes[0]();
  assert.equal(values.at(-1), "delegates: worker · scout · tester ×2 · oracle");
  finishes[0](); // idempotent
  finishes.slice(1).forEach(finish => finish());
  assert.equal(values.at(-1), undefined);
});

test("footer applies the current theme's dim color", () => {
  const { ctx, values } = observer();
  ctx.ui.theme.fg = (color, text) => `${color}[${text}]`;
  const status = new DelegateStatus(ctx);
  const finish = status.begin("scout", ctx);
  assert.equal(values.at(-1), "dim[delegates: scout]");
  finish();
  assert.equal(values.at(-1), undefined);
});

test("footer identifiers are compact and terminal safe", () => {
  const { ctx, values } = observer();
  const status = new DelegateStatus(ctx);
  status.begin("long-".repeat(12) + "\x1b[31m\n", ctx);
  assert.ok(values.at(-1).length <= 31);
  assert.doesNotMatch(values.at(-1), /[\x00-\x1f]/);
});

test("footer ignores old session completions and stale launches", () => {
  const { ctx, values } = observer();
  const old = new DelegateStatus(ctx);
  const finish = old.begin("worker", ctx);
  old.dispose();
  const current = new DelegateStatus(ctx);
  current.begin("scout", ctx);
  const count = values.length;
  finish();
  old.begin("tester", ctx)();
  old.dispose();
  assert.equal(values.length, count);
  assert.equal(values.at(-1), "delegates: scout");
});

for (const mode of ["rpc", "json", "print"]) {
  test(`footer makes no UI calls in ${mode} mode`, () => {
    const { ctx, values } = observer(mode);
    const status = new DelegateStatus(ctx);
    status.begin("worker", ctx)();
    status.dispose();
    assert.deepEqual(values, []);
  });
}

test("throwing footer observer cannot prevent bookkeeping or cleanup", () => {
  const { ctx, values } = observer("tui", true);
  const status = new DelegateStatus(ctx);
  status.begin("worker", ctx)();
  status.dispose();
  assert.deepEqual(values, [undefined, "delegates: worker", undefined, undefined]);
});
