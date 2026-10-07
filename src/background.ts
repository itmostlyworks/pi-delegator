export const MAX_BACKGROUND_RUNS = 32;

export interface BackgroundSnapshot<T, M> {
  metadata: M | undefined;
  settled: boolean;
  value?: T;
}

type Observer<T, M> = (snapshot: BackgroundSnapshot<T, M>) => void;
type ObserverSlot<T, M> = Observer<T, M> | WeakRef<Observer<T, M>>;

// Holdings never retain a callback, renderer context, or run. Lifecycle cleanup
// unregisters eagerly; GC only prunes subscriptions abandoned by their owners.
const observerFinalizers = new FinalizationRegistry<{
  observers: Set<unknown>;
  slot: WeakRef<object>;
}>(({ observers, slot }) => { observers.delete(slot); });

function unsubscribeObserver<T, M>(observers: Set<ObserverSlot<T, M>>, slot: ObserverSlot<T, M>): () => void {
  // Keep this closure outside observe: it owns only the set and slot, not the run
  // or observe's callback argument (which must remain weak for weak subscribers).
  return () => {
    observers.delete(slot);
    if (slot instanceof WeakRef) observerFinalizers.unregister(slot);
  };
}

interface Run<T, M> {
  readonly metadata: M | undefined;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  waiting: boolean;
  settled: boolean;
  value?: T;
  reported: boolean;
  collected: boolean;
  readonly observers: Set<ObserverSlot<T, M>>;
  waitingTimer?: ReturnType<typeof setInterval>;
}

/** Session-local, bounded ownership. Aborting a wait never detaches ownership. */
export class BackgroundRuns<T, M = undefined> {
  private readonly runs = new Map<string, Run<T, M>>();
  private nextRunId = 1n;
  private closed = false;
  private closing: Promise<void> | undefined;
  private permanentlyClosed = false;
  private cancelling: Promise<void> | undefined;

  private readonly isFailure: (value: T) => boolean;
  private readonly report: (id: string, value: T) => void;

  private readonly reportOnClose: (value: T) => boolean;

  constructor(
    isFailure: (value: T) => boolean,
    report: (id: string, value: T) => void,
    reportOnClose: (value: T) => boolean = () => false,
  ) {
    this.isFailure = isFailure;
    this.report = report;
    this.reportOnClose = reportOnClose;
  }

  start(work: (signal: AbortSignal) => Promise<T>, metadata?: M): string {
    if (this.closed) throw new Error("Delegate session is closing");
    if (this.runs.size >= MAX_BACKGROUND_RUNS) {
      throw new Error(`At most ${MAX_BACKGROUND_RUNS} uncollected background delegates are allowed; wait for an existing run first`);
    }
    const id = `run-${this.nextRunId++}`;
    const controller = new AbortController();
    const run: Run<T, M> = {
      metadata,
      controller, promise: Promise.resolve().then(() => work(controller.signal)),
      waiting: false, settled: false, reported: false, collected: false,
      observers: new Set(),
    };
    this.runs.set(id, run);
    // Both branches are handled immediately, even when nobody calls wait.
    void run.promise.then((value) => {
      run.settled = true;
      run.value = value;
      this.clearWaitingTimer(run);
      this.notify(run);
      this.clearObservation(run);
      this.reportFailure(id, run);
    }, () => {
      // Work must convert unexpected errors to a value, but observation still stops.
      run.settled = true;
      this.clearWaitingTimer(run);
      this.notify(run);
      this.clearObservation(run);
    });
    return id;
  }

  snapshot(id: string): BackgroundSnapshot<T, M> | undefined {
    const run = this.closed ? undefined : this.runs.get(id);
    return run ? this.runSnapshot(run) : undefined;
  }

  observe(id: string, observer: Observer<T, M>, options?: { weak?: boolean }): () => void {
    const run = this.runs.get(id);
    if (!run || run.settled || this.closed) return () => {};
    // Each subscription has its own identity, even with the same callback.
    // Weak subscribers must retain this exact callback, not a wrapper.
    const slot: ObserverSlot<T, M> = options?.weak
      ? new WeakRef(observer)
      : (snapshot) => observer(snapshot);
    run.observers.add(slot);
    if (slot instanceof WeakRef) {
      observerFinalizers.register(observer, { observers: run.observers, slot }, slot);
    }
    return unsubscribeObserver(run.observers, slot);
  }

  private runSnapshot(run: Run<T, M>): BackgroundSnapshot<T, M> {
    return {
      metadata: run.metadata,
      settled: run.settled,
      ...(run.settled && "value" in run ? { value: run.value } : {}),
    };
  }

  private notify(run: Run<T, M>): void {
    const snapshot = this.runSnapshot(run);
    for (const slot of run.observers) {
      const observer = slot instanceof WeakRef ? slot.deref() : slot;
      if (!observer) {
        run.observers.delete(slot);
        observerFinalizers.unregister(slot);
        continue;
      }
      try { observer(snapshot); } catch { /* Observers do not own lifecycle. */ }
    }
  }

  private clearObservation(run: Run<T, M>): void {
    for (const slot of run.observers) {
      if (slot instanceof WeakRef) observerFinalizers.unregister(slot);
    }
    run.observers.clear();
  }

  private clearWaitingTimer(run: Run<T, M>): void {
    if (run.waitingTimer !== undefined) clearInterval(run.waitingTimer);
    delete run.waitingTimer;
  }

  private reportFailure(id: string, run: Run<T, M>): void {
    if (!run.settled || !("value" in run) || run.waiting || run.reported || this.closed) return;
    if (!this.isFailure(run.value!)) return;
    run.reported = true;
    try { this.report(id, run.value!); } catch { /* Observers do not own lifecycle. */ }
  }

  async wait(id: string, signal?: AbortSignal, onWaiting?: (metadata: M | undefined) => void): Promise<T> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown or already collected background delegate: ${id}`);
    if (run.waiting) throw new Error(`Background delegate already has a waiter: ${id}`);
    if (signal?.aborted) throw new Error(`Stopped waiting for delegate ${id}; delegate not cancelled. Wait again to get the result.`);
    run.waiting = true;
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          this.clearWaitingTimer(run);
          reject(new Error(`Stopped waiting for delegate ${id}; delegate not cancelled. Wait again to get the result.`));
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
      const notifyWaiting = () => {
        try { onWaiting?.(run.metadata); } catch { /* Observers do not own lifecycle. */ }
      };
      notifyWaiting();
      if (onWaiting && !run.settled && !signal?.aborted && !this.closed) {
        run.waitingTimer = setInterval(notifyWaiting, 1000);
        run.waitingTimer.unref();
      }
      const value = await Promise.race([run.promise, cancelled]);
      if (signal?.aborted) throw new Error(`Stopped waiting for delegate ${id}; delegate not cancelled. Wait again to get the result.`);
      this.clearObservation(run);
      run.collected = true;
      this.runs.delete(id);
      return value;
    } finally {
      this.clearWaitingTimer(run);
      if (abort) signal?.removeEventListener("abort", abort);
      run.waiting = false;
      if (this.runs.has(id)) this.reportFailure(id, run);
    }
  }

  close(): Promise<void> {
    this.permanentlyClosed = true;
    return this.closeRuns();
  }

  private closeRuns(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const runs = [...this.runs.entries()];
    for (const [, run] of runs) {
      this.clearWaitingTimer(run);
      // Redraw retained cards as inactive even if another extension cancels navigation.
      this.notify(run);
      this.clearObservation(run);
    }
    for (const [, run] of runs) run.controller.abort();
    // The runner owns bounded cancellation/cleanup; never abandon its finalizer.
    this.closing = (async () => {
      const outcomes = await Promise.allSettled(runs.map(([, run]) => run.promise));
      for (const [index, outcome] of outcomes.entries()) {
        const [id, run] = runs[index]!;
        if (outcome.status === "fulfilled" && !run.collected && !run.waiting && !run.reported && this.reportOnClose(outcome.value)) {
          run.reported = true;
          try { this.report(id, outcome.value); } catch { /* Diagnostic observers only. */ }
        }
      }
      this.runs.clear();
    })();
    return this.closing;
  }

  /** Pre-navigation can be cancelled by another extension: keep this session usable. */
  cancelAll(): Promise<void> {
    if (this.permanentlyClosed) return this.closeRuns();
    if (this.cancelling) return this.cancelling;
    this.cancelling = this.closeRuns().then(() => {
      if (!this.permanentlyClosed) {
        this.closing = undefined;
        this.closed = false;
      }
      this.cancelling = undefined;
    });
    return this.cancelling;
  }
}
