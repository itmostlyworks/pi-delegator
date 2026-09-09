import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";

import {
  createBashTool,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  DELEGATE_BASH_ABORT_EXIT_CODE,
  DELEGATE_BASH_TIMEOUT_EXIT_CODE,
  DELEGATE_CHILD_ENV,
  DELEGATE_CHILD_ENV_VALUE,
} from "./delegate-child-contract.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const POST_EXIT_DRAIN_MS = 100;

type FailDelegate = (exitCode: number) => void;

function resolveShell(): string {
  if (existsSync("/bin/bash")) return "/bin/bash";
  return "bash";
}

function defaultFailDelegate(exitCode: number): void {
  process.exit(exitCode);
}

/**
 * Keep Bash in the delegate's process group. A Bash timeout or abort fails the
 * whole child Pi so the outer runner can clean that group deterministically.
 */
export function createDelegateBashOperations(
  failDelegate: FailDelegate = defaultFailDelegate,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      let timeoutMs: number | undefined;
      if (timeout !== undefined) {
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new Error("Invalid timeout: must be a finite number of seconds");
        }
        timeoutMs = timeout * 1_000;
        if (timeoutMs > MAX_TIMEOUT_MS) {
          throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1_000} seconds`);
        }
      }
      if (signal?.aborted) {
        failDelegate(DELEGATE_BASH_ABORT_EXIT_CODE);
        throw new Error("Bash abort must terminate the delegated Pi process");
      }

      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      if (signal?.aborted) {
        failDelegate(DELEGATE_BASH_ABORT_EXIT_CODE);
        throw new Error("Bash abort must terminate the delegated Pi process");
      }

      const commandEnv = { ...env };
      delete commandEnv[DELEGATE_CHILD_ENV];
      const child = spawn(resolveShell(), ["-c", command], {
        cwd,
        detached: false,
        env: commandEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let settled = false;
        let exitCode: number | null = null;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let drainHandle: NodeJS.Timeout | undefined;

        const handleData = (data: Buffer): void => {
          if (!settled) onData(data);
        };
        const cleanup = (): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (drainHandle) clearTimeout(drainHandle);
          signal?.removeEventListener("abort", handleAbort);
          child.removeListener("error", handleError);
          child.removeListener("exit", handleExit);
          child.removeListener("close", handleClose);
          child.stdout?.removeListener("data", handleData);
          child.stderr?.removeListener("data", handleData);
          child.stdout?.destroy();
          child.stderr?.destroy();
        };
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve({ exitCode });
        };
        const failWholeDelegate = (code: number, message: string): void => {
          finish(new Error(message));
          failDelegate(code);
        };
        function handleAbort(): void {
          failWholeDelegate(DELEGATE_BASH_ABORT_EXIT_CODE, "Bash was aborted; delegation must end");
        }
        function handleError(error: Error): void {
          finish(error);
        }
        function handleExit(code: number | null): void {
          exitCode = code;
          // Start once and never reset: descendants may keep inherited pipes open.
          drainHandle ??= setTimeout(() => finish(), POST_EXIT_DRAIN_MS);
        }
        function handleClose(): void {
          finish();
        }

        child.stdout?.on("data", handleData);
        child.stderr?.on("data", handleData);
        child.once("error", handleError);
        child.once("exit", handleExit);
        child.once("close", handleClose);
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(
            () => failWholeDelegate(
              DELEGATE_BASH_TIMEOUT_EXIT_CODE,
              `Bash exceeded its ${String(timeout)} second timeout; delegation must end`,
            ),
            timeoutMs,
          );
        }
        if (signal) {
          if (signal.aborted) handleAbort();
          else signal.addEventListener("abort", handleAbort, { once: true });
        }
      });
    },
  };
}

export default function delegateBashExtension(pi: ExtensionAPI): void {
  if (process.env[DELEGATE_CHILD_ENV] !== DELEGATE_CHILD_ENV_VALUE) return;

  const bashTool = createBashTool(process.cwd(), {
    operations: createDelegateBashOperations(),
  });
  pi.registerTool({
    ...bashTool,
    description: `${bashTool.description} In a delegate, supplying a timeout or aborting Bash ends the entire delegation.`,
  });
}
