import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { BackgroundRuns, MAX_BACKGROUND_RUNS } from "../src/background.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("run IDs increase across concurrent starts, completion, and collection; new registries reset", async () => {
  const runs = new BackgroundRuns(() => false, () => {});
  const fresh = new BackgroundRuns(() => false, () => {});
  const work = deferred();
  try {
    const ids = Array.from({ length: 3 }, () => runs.start(() => work.promise));
    assert.deepEqual(ids, ["run-1", "run-2", "run-3"]);
    work.resolve("done");
    await tick();
    const completed = runs.start(async () => "completed");
    assert.equal(completed, "run-4");
    assert.equal(await runs.wait(ids[1]), "done");
    assert.equal(await runs.wait(completed), "completed");
    const afterCollection = runs.start(async () => "next");
    assert.equal(afterCollection, "run-5");
    await assert.rejects(runs.wait(ids[1]), /Unknown or already collected/);
    assert.equal(await runs.wait(afterCollection), "next");
    assert.equal(fresh.start(async () => "fresh"), "run-1");
  } finally {
    work.resolve("done");
    await Promise.all([runs.close(), fresh.close()]);
  }
});

test("background runs bound all uncollected work, including completed runs", async () => {
  const reports = [];
  const runs = new BackgroundRuns((value) => !value.ok, (...args) => reports.push(args));
  const work = deferred();
  try {
    const ids = Array.from({ length: MAX_BACKGROUND_RUNS }, () => runs.start(() => work.promise));
    assert.deepEqual(ids, Array.from({ length: MAX_BACKGROUND_RUNS }, (_, index) => `run-${index + 1}`));
    assert.throws(() => runs.start(async () => ({ ok: true })), /At most .* uncollected/);
    work.resolve({ ok: true });
    await tick();
    assert.throws(() => runs.start(async () => ({ ok: true })), /At most .* uncollected/);
    assert.deepEqual(await runs.wait(ids[0]), { ok: true });
    const replacement = runs.start(async () => ({ ok: true }));
    assert.equal(replacement, `run-${MAX_BACKGROUND_RUNS + 1}`);
    assert.deepEqual(await runs.wait(replacement), { ok: true });
    await assert.rejects(runs.wait(ids[0]), /Unknown or already collected/);
    assert.deepEqual(reports, []);
  } finally {
    work.resolve({ ok: true });
    await runs.close();
  }
});

test("background duplicate waits cannot steal a result", async () => {
  const work = deferred();
  const runs = new BackgroundRuns(() => false, () => {});
  const id = runs.start(() => work.promise);
  try {
    const first = runs.wait(id);
    await assert.rejects(runs.wait(id), /already has a waiter/);
    work.resolve("answer");
    assert.equal(await first, "answer");
    await assert.rejects(runs.wait(id), /Unknown or already collected/);
    await assert.rejects(runs.wait("not-a-run"), /Unknown or already collected/);
  } finally {
    work.resolve("answer");
    await runs.close();
  }
});

test("cancelling a wait retains ownership and reports a later failure once", async () => {
  const work = deferred();
  const reports = [];
  let ownedSignal;
  const runs = new BackgroundRuns((value) => !value.ok, (...args) => reports.push(args));
  const id = runs.start((signal) => { ownedSignal = signal; return work.promise; });
  try {
    const controller = new AbortController();
    const waiting = runs.wait(id, controller.signal);
    await tick();
    controller.abort();
    await assert.rejects(waiting, /Stopped waiting for delegate run-1; delegate not cancelled\. Wait again to get the result\./);
    assert.equal(ownedSignal.aborted, false);
    const failure = { ok: false, message: "failed" };
    work.resolve(failure);
    await tick();
    assert.deepEqual(reports, [[id, failure]]);
    assert.equal(await runs.wait(id), failure);
    await tick();
    assert.equal(reports.length, 1);
  } finally {
    work.resolve({ ok: true });
    await runs.close();
  }
});

for (const ok of [true, false]) {
  for (const throws of [false, true]) {
    test(`settled ${ok ? "success" : "failure"} survives a synchronously aborting${throws ? " and throwing" : ""} wait observer`, async () => {
      const reports = [];
      const outcome = { ok };
      const metadata = { profile: "worker" };
      let ownedSignal;
      const runs = new BackgroundRuns((value) => !value.ok, (...args) => reports.push(args));
      const id = runs.start(async (signal) => { ownedSignal = signal; return outcome; }, metadata);
      const controller = new AbortController();
      try {
        await tick();
        const expectedReports = ok ? [] : [[id, outcome]];
        assert.deepEqual(reports, expectedReports);
        let observerCalls = 0;
        await assert.rejects(runs.wait(id, controller.signal, (observed) => {
          observerCalls += 1;
          assert.equal(observed, metadata);
          controller.abort();
          if (throws) throw new Error("observer");
        }), /Stopped waiting for delegate run-1; delegate not cancelled\. Wait again to get the result\./);
        assert.equal(observerCalls, 1);
        assert.equal(ownedSignal.aborted, false);
        assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
        // Allow any unhandled cancellation rejection to surface before retrying.
        await tick();
        assert.deepEqual(reports, expectedReports);
        assert.equal(await runs.wait(id), outcome, "waiter released and result remains collectable");
        await assert.rejects(runs.wait(id), /Unknown or already collected/);
        await tick();
        assert.deepEqual(reports, expectedReports, "failure notification is not repeated");
      } finally {
        await runs.close();
      }
    });
  }
}

test("an already cancelled wait does not collect or abort its run", async () => {
  const work = deferred();
  const runs = new BackgroundRuns(() => false, () => {});
  const id = runs.start(() => work.promise);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runs.wait(id, controller.signal), /Stopped waiting for delegate/);
    work.resolve("still owned");
    assert.equal(await runs.wait(id), "still owned");
  } finally {
    work.resolve("still owned");
    await runs.close();
  }
});

test("an active waiter suppresses failure notifications and observers cannot own cleanup", async () => {
  const work = deferred();
  let reportCalls = 0;
  const runs = new BackgroundRuns(() => true, () => { reportCalls += 1; throw new Error("observer"); });
  try {
    const id = runs.start(() => work.promise);
    const waiting = runs.wait(id);
    work.resolve("failed while waiting");
    assert.equal(await waiting, "failed while waiting");
    assert.equal(reportCalls, 0);
    const uncollected = runs.start(async () => "uncollected failure");
    await tick();
    assert.equal(reportCalls, 1);
    assert.equal(await runs.wait(uncollected), "uncollected failure");
    assert.equal(reportCalls, 1);
  } finally {
    work.resolve("failure");
    await runs.close();
  }
});

test("close aborts every owned run, waits for finalizers, and is idempotent", async () => {
  const reports = [];
  const runs = new BackgroundRuns(() => true, (...args) => reports.push(args));
  const finalizers = [deferred(), deferred()];
  const signals = [];
  const ids = finalizers.map((work) => runs.start((signal) => {
    signals.push(signal);
    return work.promise;
  }));
  await tick();
  let closed = false;
  const closePromise = runs.close();
  assert.equal(runs.close(), closePromise, "concurrent close shares the same finalization");
  const closing = closePromise.then(() => { closed = true; });
  try {
    assert.ok(signals.every((signal) => signal.aborted));
    assert.throws(() => runs.start(async () => "late"), /session is closing/);
    await tick();
    assert.equal(closed, false);
    finalizers[0].resolve("cancelled");
    await tick();
    assert.equal(closed, false);
    finalizers[1].resolve("cancelled");
    await closing;
    assert.equal(runs.close(), closePromise, "completed close stays idempotent");
    await runs.close();
    assert.deepEqual(reports, []);
    for (const id of ids) await assert.rejects(runs.wait(id), /Unknown or already collected/);
  } finally {
    for (const work of finalizers) work.resolve("cancelled");
    await closing;
  }
});

test("close reports cleanup failures once but suppresses ordinary cancellation", async () => {
  const reports = [];
  const runs = new BackgroundRuns(
    (value) => !value.ok,
    (...args) => { reports.push(args); throw new Error("observer"); },
    (value) => !value.ok && (value.code !== "cancelled" || Boolean(value.cleanup?.diagnostic)),
  );
  const alreadyReported = { ok: false, code: "child_error" };
  const reportedId = runs.start(async () => alreadyReported);
  await tick();
  assert.deepEqual(reports, [[reportedId, alreadyReported]]);
  const outcomes = [
    { ok: false, code: "cancelled" },
    { ok: false, code: "cleanup_failed" },
    { ok: false, code: "child_error" },
    { ok: true },
    { ok: false, code: "cancelled", cleanup: { diagnostic: "session survivors could not be verified" } },
  ];
  const ids = outcomes.map((outcome) => runs.start((signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(outcome), { once: true });
  })));
  await tick();
  const closing = runs.close();
  assert.equal(runs.close(), closing);
  await closing;
  assert.deepEqual(reports, [[reportedId, alreadyReported], [ids[1], outcomes[1]], [ids[2], outcomes[2]], [ids[4], outcomes[4]]]);
  assert.equal(runs.close(), closing);
  await runs.close();
  assert.equal(reports.length, 4);
  for (const id of [reportedId, ...ids]) await assert.rejects(runs.wait(id), /Unknown or already collected/);
});

for (const closeFirst of [false, true]) {
  test(`permanent close wins overlapping cancelAll (${closeFirst ? "close first" : "cancel first"})`, async () => {
    const work = deferred();
    const runs = new BackgroundRuns(() => false, () => {});
    runs.start(() => work.promise);
    await tick();
    const first = closeFirst ? runs.close() : runs.cancelAll();
    const second = closeFirst ? runs.cancelAll() : runs.close();
    assert.throws(() => runs.start(async () => "early"), /session is closing/);
    work.resolve("cancelled");
    await Promise.all([first, second]);
    await runs.cancelAll();
    assert.throws(() => runs.start(async () => "late"), /session is closing/);
  });
}

test("concurrent cancelAll shares reopening and cannot reopen a newer cancellation", async () => {
  const work = deferred();
  const nextWork = deferred();
  const runs = new BackgroundRuns(() => false, () => {});
  runs.start(() => work.promise);
  await tick();
  const first = runs.cancelAll();
  const second = runs.cancelAll();
  assert.equal(first, second);
  let nextCancellation;
  const restarted = first.then(() => {
    runs.start(() => nextWork.promise);
    nextCancellation = runs.cancelAll();
  });
  try {
    assert.throws(() => runs.start(async () => "early"), /session is closing/);
    work.resolve("cancelled");
    await second;
    await restarted;
    assert.throws(() => runs.start(async () => "still closing"), /session is closing/);
    nextWork.resolve("cancelled");
    await nextCancellation;
    const id = runs.start(async () => "reopened");
    assert.equal(await runs.wait(id), "reopened");
  } finally {
    work.resolve("cancelled");
    nextWork.resolve("cancelled");
    await runs.close();
  }
});

for (const cancelWait of [false, true]) {
  test(`close ${cancelWait ? "reports a cancelled wait's" : "does not duplicate an active wait's"} failure`, async () => {
    const work = deferred();
    const reports = [];
    const runs = new BackgroundRuns(() => true, (...args) => reports.push(args), () => true);
    const id = runs.start(() => work.promise);
    const controller = new AbortController();
    const waiting = runs.wait(id, controller.signal);
    await tick();
    const closing = runs.close();
    if (cancelWait) {
      controller.abort();
      await assert.rejects(waiting, /Stopped waiting/);
    }
    work.resolve("cleanup failure");
    if (!cancelWait) assert.equal(await waiting, "cleanup failure");
    await closing;
    assert.deepEqual(reports, cancelWait ? [[id, "cleanup failure"]] : []);
  });
}

test("cancelAll waits for cleanup then reopens the same registry without session_start", async () => {
  const reports = [];
  const runs = new BackgroundRuns(() => true, (...args) => reports.push(args));
  try {
    for (let navigation = 0; navigation < 3; navigation += 1) {
      const finalizer = deferred();
      let signal;
      const id = runs.start((ownedSignal) => { signal = ownedSignal; return finalizer.promise; });
      assert.equal(id, `run-${navigation * 2 + 1}`);
      await tick();
      const cancelling = runs.cancelAll();
      try {
        assert.equal(signal.aborted, true);
        assert.throws(() => runs.start(async () => "too early"), /session is closing/);
      } finally {
        finalizer.resolve("cancelled");
        await cancelling;
      }
      await assert.rejects(runs.wait(id), /Unknown or already collected/);
      const replacement = runs.start(async () => "replacement");
      assert.equal(replacement, `run-${navigation * 2 + 2}`);
      assert.equal(await runs.wait(replacement), "replacement");
    }
    assert.deepEqual(reports, []);
  } finally {
    await runs.close();
  }
  assert.throws(() => runs.start(async () => "after shutdown"), /session is closing/);
});

test("start observation is settlement-only and independent of live wait updates", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const work = deferred();
  const metadata = { profile: "worker" };
  const runs = new BackgroundRuns(() => false, () => {});
  const id = runs.start(() => work.promise, metadata);
  const snapshots = [];
  try {
    assert.equal(runs.snapshot("missing"), undefined);
    assert.deepEqual(runs.snapshot(id), { metadata, settled: false });
    runs.observe(id, (snapshot) => snapshots.push(snapshot));
    assert.deepEqual(snapshots, [], "registration is not recursive");
    t.mock.timers.tick(999);
    assert.equal(snapshots.length, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(snapshots, [], "start observation never arms a heartbeat");
    const updates = [];
    const waiting = runs.wait(id, undefined, (value) => updates.push(value));
    assert.deepEqual(updates, [metadata], "admitted wait emits immediately");
    t.mock.timers.tick(999);
    assert.equal(updates.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(updates, [metadata, metadata]);
    assert.deepEqual(snapshots, [], "wait ticks do not notify the start observer");
    work.resolve("answer");
    assert.equal(await waiting, "answer");
    assert.deepEqual(snapshots, [{ metadata, settled: true, value: "answer" }]);
    t.mock.timers.tick(3000);
    assert.equal(updates.length, 2, "settlement detaches the wait heartbeat");
    assert.equal(runs.snapshot(id), undefined);
    t.mock.timers.tick(3000);
    assert.equal(snapshots.length, 1, "collection leaves no heartbeat");
  } finally {
    work.resolve("answer");
    await runs.close();
  }
});

test("invalid waits and waits without callbacks arm no timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const intervals = t.mock.method(globalThis, "setInterval");
  const work = deferred();
  const runs = new BackgroundRuns(() => false, () => {});
  const id = runs.start(() => work.promise);
  let calls = 0;
  const observer = () => { calls += 1; };
  try {
    runs.observe(id, observer);
    await assert.rejects(runs.wait("missing", undefined, observer), /Unknown/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runs.wait(id, controller.signal, observer), /Stopped waiting for delegate/);
    const waiting = runs.wait(id);
    await assert.rejects(runs.wait(id, undefined, observer), /already has a waiter/);
    assert.equal(intervals.mock.callCount(), 0);
    assert.equal(calls, 0);
    work.resolve("done");
    assert.equal(await waiting, "done");
    assert.equal(calls, 1, "only the settlement observer ran");
    await assert.rejects(runs.wait(id, undefined, observer), /Unknown/);
    assert.equal(intervals.mock.callCount(), 0);
  } finally {
    work.resolve("done");
    await runs.close();
  }
});

for (const synchronous of [true, false]) {
  test(`${synchronous ? "immediate" : "heartbeat"} wait observer can abort and throw without detaching start ownership`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const intervals = t.mock.method(globalThis, "setInterval");
    const work = deferred();
    const runs = new BackgroundRuns(() => false, () => {});
    const id = runs.start(() => work.promise);
    const controller = new AbortController();
    let calls = 0;
    let settlements = 0;
    try {
      runs.observe(id, () => { settlements += 1; });
      const waiting = runs.wait(id, controller.signal, () => {
        calls += 1;
        if (synchronous || calls === 2) controller.abort();
        throw new Error("observer");
      });
      assert.equal(intervals.mock.callCount(), synchronous ? 0 : 1);
      t.mock.timers.tick(1000);
      const expectedCalls = synchronous ? 1 : 2;
      assert.equal(calls, expectedCalls);
      t.mock.timers.tick(3000);
      assert.equal(calls, expectedCalls, "abort detaches timer synchronously");
      await assert.rejects(waiting, /Stopped waiting for delegate/);
      assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
      assert.equal(settlements, 0);
      const retry = runs.wait(id, undefined, () => { calls += 1; });
      t.mock.timers.tick(1000);
      assert.equal(calls, expectedCalls + 2);
      work.resolve("answer");
      assert.equal(await retry, "answer");
      assert.equal(settlements, 1, "wait cancellation preserves the start observer");
      t.mock.timers.tick(3000);
      assert.equal(calls, expectedCalls + 2);
    } finally {
      work.resolve("answer");
      await runs.close();
    }
  });
}

test("unexpected work rejection detaches wait heartbeat and start observer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const work = deferred();
  const runs = new BackgroundRuns(() => false, () => {});
  const id = runs.start(async () => { await work.promise; throw new Error("unexpected"); });
  const controller = new AbortController();
  const snapshots = [];
  let calls = 0;
  try {
    runs.observe(id, (snapshot) => snapshots.push(snapshot));
    const waiting = runs.wait(id, controller.signal, () => { calls += 1; throw new Error("observer"); });
    t.mock.timers.tick(1000);
    assert.equal(calls, 2);
    work.resolve();
    await assert.rejects(waiting, /unexpected/);
    assert.deepEqual(snapshots, [{ metadata: undefined, settled: true }]);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    t.mock.timers.tick(3000);
    assert.equal(calls, 2);
    assert.equal(snapshots.length, 1);
  } finally {
    work.resolve();
    await runs.close();
  }
});

test("settlement retains a snapshot but detaches observers and timers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const work = deferred();
  const runs = new BackgroundRuns(() => false, () => {});
  const id = runs.start(() => work.promise);
  let calls = 0;
  try {
    runs.observe(id, () => { calls += 1; });
    work.resolve(undefined);
    await tick();
    assert.equal(calls, 1);
    assert.deepEqual(runs.snapshot(id), { metadata: undefined, settled: true, value: undefined });
    runs.observe(id, () => { calls += 1; })();
    runs.observe("missing", () => { calls += 1; })();
    t.mock.timers.tick(3000);
    assert.equal(calls, 1);
    await runs.wait(id);
  } finally {
    work.resolve(undefined);
    await runs.close();
  }
});

test("throwing settlement observers cannot affect failure reporting or collection", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const work = deferred();
  const reports = [];
  const runs = new BackgroundRuns(() => true, (...args) => reports.push(args));
  const id = runs.start(() => work.promise);
  let calls = 0;
  try {
    runs.observe(id, () => { throw new Error("observer"); });
    runs.observe(id, () => { calls += 1; });
    t.mock.timers.tick(1000);
    work.resolve("failure");
    await tick();
    assert.equal(calls, 1);
    assert.deepEqual(reports, [[id, "failure"]]);
    assert.equal(await runs.wait(id), "failure");
    t.mock.timers.tick(3000);
    assert.equal(calls, 1);
  } finally {
    work.resolve("failure");
    await runs.close();
  }
});

test("weak subscriptions retain exact callback identity and unsubscribe independently", async () => {
  const work = deferred();
  const runs = new BackgroundRuns(() => false, () => {});
  const id = runs.start(() => work.promise);
  const snapshots = [];
  const observer = (snapshot) => snapshots.push(snapshot);
  const observers = runs.runs.get(id).observers;
  try {
    const first = runs.observe(id, observer, { weak: true });
    const current = runs.observe(id, observer, { weak: true });
    const slots = [...observers];
    assert.equal(slots.length, 2);
    assert.notEqual(slots[0], slots[1]);
    for (const slot of slots) {
      assert.ok(slot instanceof WeakRef);
      assert.equal(slot.deref(), observer, "weak reference targets the owner-held callback, not a wrapper");
    }
    first();
    first();
    assert.deepEqual([...observers], [slots[1]]);
    work.resolve("done");
    assert.equal(await runs.wait(id), "done");
    assert.deepEqual(snapshots, [{ metadata: undefined, settled: true, value: "done" }]);
    assert.equal(observers.size, 0, "settlement clears slots without relying on GC");
    current();
    current();
  } finally {
    work.resolve("done");
    await runs.close();
  }
});

for (const terminal of ["settlement", "rejection", "cancelAll", "close"]) {
  test(`weak observation is dereferenced once and eagerly cleared on ${terminal}`, async (t) => {
    const work = deferred();
    const runs = new BackgroundRuns(() => false, () => {});
    const id = runs.start(async () => {
      await work.promise;
      if (terminal === "rejection") throw new Error("unexpected");
      return "done";
    });
    const snapshots = [];
    const live = (snapshot) => snapshots.push(snapshot);
    const missing = () => { throw new Error("missing callback ran"); };
    runs.observe(id, missing, { weak: true });
    runs.observe(id, live, { weak: true });
    const observers = runs.runs.get(id).observers;
    const [missingSlot, liveSlot] = [...observers];
    const missingDeref = t.mock.method(missingSlot, "deref", () => undefined);
    const liveDeref = t.mock.method(liveSlot, "deref");
    try {
      let cleanup;
      if (terminal === "cancelAll") cleanup = runs.cancelAll();
      if (terminal === "close") cleanup = runs.close();
      work.resolve();
      await cleanup;
      await tick();
      assert.equal(missingDeref.mock.callCount(), 1);
      assert.equal(liveDeref.mock.callCount(), 1);
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].settled, terminal === "settlement" || terminal === "rejection");
      assert.equal(observers.size, 0, "all slots clear synchronously on the lifecycle notification");
    } finally {
      work.resolve();
      await runs.close();
    }
  });
}

test("abandoned weak callbacks are reclaimed while live weak and default strong callbacks survive", () => {
  const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--expose-gc", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { BackgroundRuns } from ${JSON.stringify(new URL("../src/background.ts", import.meta.url).href)};
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const runs = new BackgroundRuns(() => false, () => {});
    let finish;
    const id = runs.start(() => new Promise((resolve) => { finish = resolve; }));
    let liveCalls = 0;
    let strongCalls = 0;
    const live = () => { liveCalls += 1; };
    runs.observe(id, live, { weak: true });
    runs.observe(id, () => { strongCalls += 1; });
    const abandoned = (() => {
      const context = { payload: new Uint8Array(1024) };
      const callback = () => { throw new Error(String(context.payload.length)); };
      return {
        callback: new WeakRef(callback),
        context: new WeakRef(context),
        unsubscribe: runs.observe(id, callback, { weak: true }),
      };
    })();
    const observers = runs.runs.get(id).observers;
    let reclaimed = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await tick();
      globalThis.gc();
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!abandoned.callback.deref() && !abandoned.context.deref() && observers.size === 2) {
        reclaimed = true;
        break;
      }
    }
    assert.ok(reclaimed, "abandoned callback/context reclaimed and slot pruned during an active run");
    assert.equal([...observers].find((slot) => slot instanceof WeakRef).deref(), live);
    abandoned.unsubscribe();
    finish("done");
    await runs.wait(id);
    assert.equal(liveCalls, 1);
    assert.equal(strongCalls, 1);
    assert.equal(observers.size, 0);
    await runs.close();
  `], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
});

test("independent renderer subscriptions and stale unsubscribe preserve live observation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const work = deferred();
  const runs = new BackgroundRuns(() => false, () => {});
  const id = runs.start(() => work.promise);
  let oldCalls = 0;
  let calls = 0;
  const observer = () => { calls += 1; };
  try {
    runs.observe(id, () => { oldCalls += 1; });
    const first = runs.observe(id, observer);
    const current = runs.observe(id, observer);
    first();
    first();
    t.mock.timers.tick(1000);
    assert.equal(oldCalls, 0);
    assert.equal(calls, 0, "no heartbeat for renderer observers");
    work.resolve("done");
    await runs.wait(id);
    assert.equal(oldCalls, 1, "another renderer cannot steal the live subscription");
    assert.equal(calls, 1, "stale unsubscribe cannot remove same-callback subscription");
    current();
    current();
    const unsubscribed = runs.start(async () => "done");
    const unsubscribe = runs.observe(unsubscribed, observer);
    unsubscribe();
    unsubscribe();
    await runs.wait(unsubscribed);
    t.mock.timers.tick(3000);
    assert.equal(calls, 1, "unsubscribe also removes final notification");
  } finally {
    work.resolve("done");
    await runs.close();
  }
});

for (const method of ["close", "cancelAll"]) {
  test(`${method} clears live observation before abort and still awaits finalizers`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const work = deferred();
    const runs = new BackgroundRuns(() => false, () => {});
    let calls = 0;
    const id = runs.start((signal) => {
      signal.addEventListener("abort", () => {
        t.mock.timers.tick(1000);
        runs.observe(id, () => { calls += 1; });
      }, { once: true });
      return work.promise;
    });
    await tick();
    runs.observe(id, () => {
      calls += 1;
      assert.equal(runs.snapshot(id), undefined, "closure redraw sees inactive state");
    });
    runs.observe(id, () => { calls += 1; });
    let waitCalls = 0;
    const waiting = runs.wait(id, undefined, () => { waitCalls += 1; });
    assert.equal(waitCalls, 1);
    let finished = false;
    const closing = runs[method]().then(() => { finished = true; });
    try {
      t.mock.timers.tick(3000);
      await tick();
      assert.equal(calls, 2, "each renderer gets one inactive redraw before detaching");
      assert.equal(waitCalls, 1, "closure detaches the wait timer before owned abort");
      assert.equal(finished, false);
      work.resolve("cancelled");
      await closing;
      assert.equal(await waiting, "cancelled");
      t.mock.timers.tick(3000);
      assert.equal(waitCalls, 1);
      assert.equal(calls, 2, "no late notifications");
      assert.equal(runs.snapshot(id), undefined);
    } finally {
      work.resolve("cancelled");
      await closing;
      await runs.close();
    }
  });
}
