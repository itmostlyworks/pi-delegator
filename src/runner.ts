import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { DelegateProfile } from "./agents.ts";
import { ProtocolLineTooLargeError, ProtocolParser } from "./protocol.ts";

export const MAX_FINAL_TEXT_BYTES = 50 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLEANUP_GRACE_MS = 2_000;
const DEFAULT_EXIT_DRAIN_MS = 250;

export function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export type DelegateFailureCode =
  | "unsupported_platform"
  | "spawn_failed"
  | "cancelled"
  | "run_timeout"
  | "protocol_error"
  | "child_error"
  | "missing_terminal_answer";

export interface DelegateSuccess {
  readonly ok: true;
  readonly text: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly originalBytes?: number;
  readonly malformedLineCount: number;
  readonly exitCode: number | null;
}

export interface DelegateFailure {
  readonly ok: false;
  readonly code: DelegateFailureCode;
  readonly message: string;
  readonly durationMs: number;
  readonly stderr: string;
  readonly malformedLineCount: number;
  readonly exitCode: number | null;
}

export type DelegateOutcome = DelegateSuccess | DelegateFailure;

export interface RunDelegateOptions {
  readonly profile: DelegateProfile;
  readonly task: string;
  readonly cwd: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly onAssistantText?: (text: string) => void;
  /** Private lifecycle tuning for deterministic process fixtures. */
  readonly cleanupGraceMs?: number;
  /** Private lifecycle tuning for deterministic process fixtures. */
  readonly exitDrainMs?: number;
  /** Private child environment override for deterministic process fixtures. */
  readonly env?: NodeJS.ProcessEnv;
}

type FinalizeReason =
  | { readonly type: "process_done" }
  | { readonly type: "spawn_failed"; readonly error: unknown }
  | { readonly type: "cancelled" }
  | { readonly type: "run_timeout" }
  | { readonly type: "protocol_error"; readonly error: unknown };

function getPiInvocation(args: string[], env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const override = env.PI_DELEGATOR_PI_BINARY?.trim();
  if (override) return { command: override, args };

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (chunk.length >= maxBytes) return Buffer.from(chunk.subarray(chunk.length - maxBytes));
  const combined = current.length === 0 ? Buffer.from(chunk) : Buffer.concat([current, chunk]);
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes);
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; originalBytes?: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };

  let end = maxBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      const truncated = decoder.decode(bytes.subarray(0, end));
      return { text: truncated, truncated: true, originalBytes: bytes.length };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true, originalBytes: bytes.length };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeTemporaryPrompt(directory: string | undefined): Promise<void> {
  if (!directory) return;
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup must not hide the delegate outcome.
  }
}

interface TemporaryPrompt {
  readonly directory: string;
  readonly filePath: string;
}

async function createTemporaryPrompt(prompt: string): Promise<TemporaryPrompt> {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-"));
  const filePath = join(directory, "scout-prompt.md");
  try {
    await writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
    return { directory, filePath };
  } catch (error) {
    await removeTemporaryPrompt(directory);
    throw error;
  }
}

type PromptSetupOutcome =
  | { readonly type: "ready"; readonly prompt: TemporaryPrompt }
  | { readonly type: "failed"; readonly error: unknown }
  | { readonly type: "cancelled" }
  | { readonly type: "run_timeout" };

async function createTemporaryPromptWithinDeadline(
  promptText: string,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<PromptSetupOutcome> {
  const setup = createTemporaryPrompt(promptText);
  const setupOutcome = setup.then<PromptSetupOutcome, PromptSetupOutcome>(
    (prompt) => ({ type: "ready", prompt }),
    (error: unknown) => ({ type: "failed", error }),
  );

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interruption = new Promise<PromptSetupOutcome>((resolveInterruption) => {
    timer = setTimeout(() => resolveInterruption({ type: "run_timeout" }), Math.max(0, deadlineMs));
    if (signal) {
      onAbort = () => resolveInterruption({ type: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });

  const outcome = await Promise.race([setupOutcome, interruption]);
  if (timer) clearTimeout(timer);
  if (signal && onAbort) signal.removeEventListener("abort", onAbort);

  if (outcome.type === "cancelled" || outcome.type === "run_timeout") {
    void setupOutcome.then(async (lateOutcome) => {
      if (lateOutcome.type === "ready") await removeTemporaryPrompt(lateOutcome.prompt.directory);
    });
  }
  return outcome;
}

export async function runDelegate(options: RunDelegateOptions): Promise<DelegateOutcome> {
  const startedAt = Date.now();
  const env = options.env ?? process.env;

  if (!isSupportedPlatform(process.platform)) {
    return {
      ok: false,
      code: "unsupported_platform",
      message: "Reliable delegated process-tree termination is not implemented on Windows",
      durationMs: Date.now() - startedAt,
      stderr: "",
      malformedLineCount: 0,
      exitCode: null,
    };
  }

  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "cancelled",
      message: "Parent cancelled before the delegate was launched",
      durationMs: Date.now() - startedAt,
      stderr: "",
      malformedLineCount: 0,
      exitCode: null,
    };
  }

  const deadlineAt = startedAt + options.profile.timeoutMs;
  const promptSetup = await createTemporaryPromptWithinDeadline(
    options.profile.systemPrompt,
    deadlineAt - Date.now(),
    options.signal,
  );
  if (promptSetup.type !== "ready") {
    const durationMs = Date.now() - startedAt;
    if (promptSetup.type === "failed") {
      return {
        ok: false,
        code: "spawn_failed",
        message: `Could not create the private delegate prompt: ${errorMessage(promptSetup.error)}`,
        durationMs,
        stderr: "",
        malformedLineCount: 0,
        exitCode: null,
      };
    }
    return {
      ok: false,
      code: promptSetup.type,
      message:
        promptSetup.type === "cancelled"
          ? "Parent cancelled before the delegate was launched"
          : `Scout exceeded its ${options.profile.timeoutMs} ms wall-clock deadline during startup`,
      durationMs,
      stderr: "",
      malformedLineCount: 0,
      exitCode: null,
    };
  }
  const temporaryPrompt = promptSetup.prompt;

  if (Date.now() >= deadlineAt) {
    await removeTemporaryPrompt(temporaryPrompt.directory);
    return {
      ok: false,
      code: "run_timeout",
      message: `Scout exceeded its ${options.profile.timeoutMs} ms wall-clock deadline during startup`,
      durationMs: Date.now() - startedAt,
      stderr: "",
      malformedLineCount: 0,
      exitCode: null,
    };
  }

  if (options.signal?.aborted) {
    await removeTemporaryPrompt(temporaryPrompt.directory);
    return {
      ok: false,
      code: "cancelled",
      message: "Parent cancelled before the delegate was launched",
      durationMs: Date.now() - startedAt,
      stderr: "",
      malformedLineCount: 0,
      exitCode: null,
    };
  }

  const childArgs = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
  ];
  if (options.model) childArgs.push("--model", options.model);
  childArgs.push(
    "--thinking",
    options.profile.thinking,
    "--tools",
    options.profile.tools.join(","),
    "--append-system-prompt",
    temporaryPrompt.filePath,
    `Task: ${options.task}`,
  );

  return new Promise<DelegateOutcome>((resolve) => {
    let child: ChildProcess | undefined;
    let finalizing = false;
    let acceptingOutput = true;
    let exitObserved = false;
    let pipesClosed = false;
    let exitCode: number | null = null;
    let stderrTail: Buffer = Buffer.alloc(0);
    let runTimer: NodeJS.Timeout | undefined;
    let exitDrainTimer: NodeJS.Timeout | undefined;
    let resolveExit: (() => void) | undefined;
    const exitPromise = new Promise<void>((exitResolve) => {
      resolveExit = exitResolve;
    });

    const parser = new ProtocolParser({
      onAssistantText: (text) => {
        if (!acceptingOutput) return;
        options.onAssistantText?.(truncateUtf8(text, MAX_FINAL_TEXT_BYTES).text);
      },
    });

    const cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
    const exitDrainMs = options.exitDrainMs ?? DEFAULT_EXIT_DRAIN_MS;

    const onAbort = () => {
      void finalize({ type: "cancelled" });
    };

    const settleFromProcess = (): void => {
      try {
        parser.finish();
      } catch (error) {
        void finalize({ type: "protocol_error", error });
        return;
      }
      void finalize({ type: "process_done" });
    };

    const terminateDirectChild = async (): Promise<void> => {
      if (!child || exitObserved) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // Finalization remains bounded even when signaling fails.
      }

      let graceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        exitPromise,
        new Promise<void>((graceResolve) => {
          graceTimer = setTimeout(graceResolve, cleanupGraceMs);
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
    };

    const makeProcessOutcome = (): DelegateOutcome => {
      const durationMs = Date.now() - startedAt;
      const stderr = stderrTail.toString("utf8");
      if (parser.state.assistantError) {
        return {
          ok: false,
          code: "child_error",
          message: parser.state.assistantError,
          durationMs,
          stderr,
          malformedLineCount: parser.state.malformedLineCount,
          exitCode,
        };
      }
      if (parser.state.finalText !== undefined) {
        const final = truncateUtf8(parser.state.finalText, MAX_FINAL_TEXT_BYTES);
        return {
          ok: true,
          text: final.text,
          durationMs,
          truncated: final.truncated,
          ...(final.originalBytes === undefined ? {} : { originalBytes: final.originalBytes }),
          malformedLineCount: parser.state.malformedLineCount,
          exitCode,
        };
      }
      return {
        ok: false,
        code: "missing_terminal_answer",
        message: `Scout exited${exitCode === null ? "" : ` with code ${exitCode}`} before a terminal assistant answer`,
        durationMs,
        stderr,
        malformedLineCount: parser.state.malformedLineCount,
        exitCode,
      };
    };

    async function finalize(reason: FinalizeReason): Promise<void> {
      if (finalizing) return;
      finalizing = true;
      acceptingOutput = false;
      if (runTimer) clearTimeout(runTimer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      options.signal?.removeEventListener("abort", onAbort);

      if (reason.type !== "process_done" && reason.type !== "spawn_failed") {
        await terminateDirectChild();
      }

      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (child && !exitObserved) child.unref();
      await removeTemporaryPrompt(temporaryPrompt.directory);

      const durationMs = Date.now() - startedAt;
      const stderr = stderrTail.toString("utf8");
      let outcome: DelegateOutcome;
      switch (reason.type) {
        case "process_done":
          outcome = makeProcessOutcome();
          break;
        case "spawn_failed":
          outcome = {
            ok: false,
            code: "spawn_failed",
            message: `Could not launch Pi: ${errorMessage(reason.error)}`,
            durationMs,
            stderr,
            malformedLineCount: parser.state.malformedLineCount,
            exitCode,
          };
          break;
        case "cancelled":
          outcome = {
            ok: false,
            code: "cancelled",
            message: "Parent cancelled the delegate",
            durationMs,
            stderr,
            malformedLineCount: parser.state.malformedLineCount,
            exitCode,
          };
          break;
        case "run_timeout":
          outcome = {
            ok: false,
            code: "run_timeout",
            message: `Scout exceeded its ${options.profile.timeoutMs} ms wall-clock deadline`,
            durationMs,
            stderr,
            malformedLineCount: parser.state.malformedLineCount,
            exitCode,
          };
          break;
        case "protocol_error":
          outcome = {
            ok: false,
            code: "protocol_error",
            message:
              reason.error instanceof ProtocolLineTooLargeError
                ? reason.error.message
                : `Could not trust Pi JSONL output: ${errorMessage(reason.error)}`,
            durationMs,
            stderr,
            malformedLineCount: parser.state.malformedLineCount,
            exitCode,
          };
          break;
      }
      resolve(outcome);
    }

    const invocation = getPiInvocation(childArgs, env);
    let spawned: ChildProcess;
    try {
      spawned = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        detached: true,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;
    } catch (error) {
      void finalize({ type: "spawn_failed", error });
      return;
    }

    spawned.stdout?.on("data", (data: Buffer) => {
      if (!acceptingOutput) return;
      try {
        parser.push(data);
      } catch (error) {
        void finalize({ type: "protocol_error", error });
      }
    });

    spawned.stderr?.on("data", (data: Buffer) => {
      if (!acceptingOutput) return;
      stderrTail = appendTail(stderrTail, data, MAX_STDERR_BYTES);
    });

    spawned.once("error", (error) => {
      void finalize({ type: "spawn_failed", error });
    });

    spawned.once("exit", (code) => {
      exitObserved = true;
      exitCode = code;
      resolveExit?.();
      if (!pipesClosed && !finalizing) exitDrainTimer = setTimeout(settleFromProcess, exitDrainMs);
    });

    spawned.once("close", () => {
      pipesClosed = true;
      settleFromProcess();
    });

    runTimer = setTimeout(() => {
      void finalize({ type: "run_timeout" });
    }, Math.max(0, deadlineAt - Date.now()));
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
  });
}
