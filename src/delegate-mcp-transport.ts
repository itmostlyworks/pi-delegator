import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  McpConnectionClosedError,
  parseJsonRpcMessage,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  type StdioTransportOptions,
} from "@earendil-works/pi-mcp";
import { DELEGATE_BASH_CLEANUP_EXIT_CODE, DELEGATE_CHILD_ENV } from "./delegate-child-contract.ts";
import { createProcessTreeController } from "./process-tree.ts";

const HANDSHAKE_MS = 1_000;
const DRAIN_MS = 100;
const MAX_LINE = 1024 * 1024;
const MAX_STDERR = 64 * 1024;
// Privileged Bash protects the supervisor from BASH_ENV/SHELLOPTS. Monitor mode
// creates a job PGID inside the caller's session, NOT a detached session. Save
// stdin explicitly: Bash otherwise redirects asynchronous jobs from /dev/null.
const SUPERVISOR = 'set -m; exec 4<&0; "$@" <&4 4<&- 3>&- & job=$!; exec 4<&-; printf "%s\\n" "$job" >&3; exec 3>&-; set +m; wait "$job"';
type FailDelegate = (exitCode: number) => void;

function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("MCP transport limits must be positive integers");
  return Math.min(value, maximum);
}

/** Command-local containment; the parent runner remains authoritative for any
 * descendant that deliberately re-groups within the delegate session. */
export class DelegateMcpStdioTransport implements McpTransport {
  readonly options: Readonly<StdioTransportOptions>;
  private readonly messages = new Set<McpTransportMessageListener>();
  private readonly errors = new Set<McpTransportErrorListener>();
  private readonly closes = new Set<McpTransportCloseListener>();
  private readonly maxLine: number;
  private readonly maxStderr: number;
  private readonly termGraceMs: number;
  private child: ChildProcess | undefined;
  private pending = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private started = false;
  private closing = false;
  private closed = false;
  private groupId: number | undefined;
  private handshake: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private drainTimer: NodeJS.Timeout | undefined;
  private unsafeError: Error | undefined;

  private readonly failDelegate: FailDelegate;

  constructor(options: StdioTransportOptions, failDelegate: FailDelegate = (code) => process.exit(code)) {
    this.failDelegate = failDelegate;
    this.options = Object.freeze({ ...options, ...(options.args ? { args: [...options.args] } : {}) });
    this.maxLine = bounded(options.maxMessageBytes, MAX_LINE);
    this.maxStderr = bounded(options.maxStderrBytes, MAX_STDERR);
    this.termGraceMs = bounded(options.closeTimeoutMs, 2_000);
  }

  get pid(): number | undefined { return this.groupId; }
  get stderr(): string { return this.stderrTail.toString("utf8"); }
  onMessage(listener: McpTransportMessageListener): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onError(listener: McpTransportErrorListener): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  onClose(listener: McpTransportCloseListener): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }

  private notify<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) { try { listener(value); } catch { /* observers cannot prevent cleanup */ } }
  }
  private error(error: Error): void { this.notify(this.errors, error); }
  private unsafe(message: string): void {
    if (this.unsafeError) return;
    this.unsafeError = new Error(`MCP containment/cleanup failed: ${message.slice(0, 256)}`);
    this.error(this.unsafeError);
    // In production this ends the delegate so the parent cleans its entire SID.
    // Test callbacks may throw; still finish local destruction in that case.
    try { this.failDelegate(DELEGATE_BASH_CLEANUP_EXIT_CODE); } catch { /* reported by close/start */ }
  }
  private stop(error?: Error): void {
    if (this.closing || this.closed) return;
    if (error) this.error(error);
    void this.close().catch(() => { /* unsafe failure already notified */ });
  }
  private drain(): void {
    if (!this.closing && !this.closed) this.drainTimer ??= setTimeout(() => this.stop(), DRAIN_MS);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("MCP stdio transport already started");
    if (this.closing || this.closed) throw new McpConnectionClosedError();
    if (process.platform === "win32") throw new Error("Contained MCP stdio requires Linux or macOS; Windows process-tree cleanup is unsupported");
    this.started = true;
    const env = this.options.inheritEnv === false ? { ...this.options.env } : { ...process.env, ...this.options.env };
    delete env[DELEGATE_CHILD_ENV];
    const child = spawn(existsSync("/bin/bash") ? "/bin/bash" : "bash", ["-p", "-c", SUPERVISOR, "delegate-mcp", this.options.command, ...this.options.args ?? []], {
      cwd: this.options.cwd, env, shell: false, detached: false,
      stdio: ["pipe", "pipe", this.options.stderr === "inherit" ? "inherit" : "pipe", "pipe"], windowsHide: true,
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.stdout(chunk));
    child.stdout?.on("end", () => this.drain());
    child.stdout?.on("error", (error) => this.stop(error));
    child.stdin?.on("error", (error) => this.stop(error));
    child.stderr?.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      this.stderrTail = Buffer.concat([this.stderrTail, chunk.subarray(-this.maxStderr)]).subarray(-this.maxStderr);
      try { this.options.onStderr?.(chunk.toString("utf8")); } catch { /* observational */ }
    });
    child.stderr?.on("error", (error) => this.stop(error));
    child.once("exit", (code, signal) => {
      if (!this.closing && (code !== 0 || signal)) this.error(new Error(`MCP stdio server exited (${signal ?? code}); ${this.stderr.slice(-1024)}`));
      this.drain();
    });
    child.once("close", () => this.drain());
    this.handshake = new Promise<void>((resolve, reject) => {
      let text = "";
      let settled = false;
      const fd = child.stdio[3];
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fd?.removeListener("data", data);
        fd?.removeListener("end", end);
        fd?.removeListener("error", fail);
        child.removeListener("error", spawnError);
        fd?.destroy();
        if (error) reject(error); else resolve();
      };
      const fail = (error: Error): void => { this.unsafe(error.message); finish(this.unsafeError); };
      const spawnError = (error: Error): void => {
        if (child.pid !== undefined) this.unsafe(error.message);
        finish(error);
      };
      const data = (chunk: Buffer): void => {
        text += chunk.toString("ascii");
        if (text.length > 32 || !/^[0-9]*\n?$/.test(text)) fail(new Error("invalid job PGID handshake"));
      };
      const end = (): void => {
        const id = Number(text.trim());
        // The job's PID is freshly allocated and different from the supervisor,
        // which is still in our own PGID. Never signal that supervisor group.
        if (!/^[1-9][0-9]*\n$/.test(text) || !Number.isSafeInteger(id) || id <= 1 || id === process.pid || id === child.pid) {
          fail(new Error("missing or unsafe job PGID handshake")); return;
        }
        this.groupId = id;
        finish();
      };
      const timer = setTimeout(() => fail(new Error("job PGID handshake timed out")), HANDSHAKE_MS);
      fd?.on("data", data);
      fd?.once("end", end);
      fd?.once("error", fail);
      child.once("error", spawnError);
    });
    child.on("error", (error) => this.stop(error));
    try { await this.handshake; } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
    if (this.closing) throw this.unsafeError ?? new McpConnectionClosedError();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!this.groupId || this.closing || !stdin?.writable) throw new McpConnectionClosedError();
    await new Promise<void>((resolve, reject) => stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve()));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.closePromise = this.finalize();
    return this.closePromise;
  }

  private async finalize(): Promise<void> {
    const child = this.child;
    try {
      // Even close during startup must acquire the job identity (or fail the
      // delegate). The handshake's fixed deadline also bounds this wait.
      await this.handshake?.catch(() => {});
      child?.stdin?.end();
      if (this.groupId !== undefined) {
        const result = await createProcessTreeController(this.groupId, { termGraceMs: this.termGraceMs }).terminate();
        if (!result.processGroupGone) this.unsafe(result.diagnostic ?? "job group survived cleanup");
      }
    } catch (error) {
      this.unsafe(error instanceof Error ? error.message : String(error));
    } finally {
      // No dependency on 'close': descendants can hold pipes after leader exit.
      // The supervisor has no executable work once its monitored job is gone.
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL"); // positive PID only, never our group
        await new Promise<void>((resolve) => {
          const done = (): void => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
          const timer = setTimeout(done, DRAIN_MS);
          child.once("exit", done);
        });
      }
      if (this.pending.toString("utf8").trim()) this.error(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
      this.pending = Buffer.alloc(0);
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.stdio[3]?.destroy();
      this.closed = true;
      for (const listener of this.closes) { try { listener(); } catch { /* observational */ } }
    }
    if (this.unsafeError) throw this.unsafeError;
  }

  private stdout(chunk: Buffer): void {
    if (this.closing) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.pending.length + end - offset > this.maxLine) {
        this.pending = Buffer.alloc(0);
        this.stop(new Error(`MCP stdio message exceeds ${this.maxLine} bytes`)); return;
      }
      this.pending = Buffer.concat([this.pending, chunk.subarray(offset, end)]);
      if (newline < 0) return;
      const text = this.pending.toString("utf8");
      this.pending = Buffer.alloc(0);
      if (text.trim()) {
        let message: JsonRpcMessage;
        try { message = parseJsonRpcMessage(JSON.parse(text)); } catch (error) {
          this.stop(error instanceof Error ? error : new Error(String(error))); return;
        }
        this.notify(this.messages, message);
        if (this.closing) return;
      }
      offset = newline + 1;
    }
  }
}
