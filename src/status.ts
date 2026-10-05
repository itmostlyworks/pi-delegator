import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactDisplayText } from "./display.ts";

/** Session-local, event-driven observation; never owns or controls a run. */
export class DelegateStatus {
  private readonly counts = new Map<string, number>();
  private disposed = false;
  private ctx: ExtensionContext;

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx;
    this.publish();
  }

  begin(profile: string, ctx: ExtensionContext): () => void {
    if (this.disposed) return () => {};
    this.ctx = ctx;
    this.counts.set(profile, (this.counts.get(profile) ?? 0) + 1);
    this.publish();
    let finished = false;
    return () => {
      if (finished || this.disposed) return;
      finished = true;
      const count = this.counts.get(profile)!;
      if (count === 1) this.counts.delete(profile);
      else this.counts.set(profile, count - 1);
      this.publish();
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.counts.clear();
    this.publish();
    this.disposed = true;
  }

  private publish(): void {
    try {
      if (this.ctx.mode !== "tui") return;
      const entries = [...this.counts];
      const names = entries.map(([name, count]) =>
        compactDisplayText(name, 19) + (count > 1 ? ` ×${count}` : ""));
      this.ctx.ui.setStatus("pi-delegator", names.length
        ? this.ctx.ui.theme.fg("dim", `delegates: ${names.join(" · ")}`)
        : undefined);
    } catch { /* UI observers must never affect lifecycle. */ }
  }
}
