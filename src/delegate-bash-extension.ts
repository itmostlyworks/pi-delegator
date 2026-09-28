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
  DELEGATE_BASH_CLEANUP_EXIT_CODE,
  DELEGATE_CHILD_ENV,
  DELEGATE_CHILD_ENV_VALUE,
} from "./delegate-child-contract.ts";
import { createProcessTreeController } from "./process-tree.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const POST_EXIT_DRAIN_MS = 100;
const HANDSHAKE_MS = 1_000;
// The supervisor stays in the delegate's session/group; its single monitor-mode
// job gets a separate group in that same session. Only fd 3 carries its PGID.
// The user command is an argument, never interpolated into this script.
const SUPERVISOR = 'set -m; "$1" +m -c "$2" 3>&- & job=$!; printf "%s\\n" "$job" >&3; exec 3>&-; set +m; wait "$job"';

type FailDelegate = (exitCode: number) => void;

function resolveShell(): string {
  if (existsSync("/bin/bash")) return "/bin/bash";
  return "bash";
}

function defaultFailDelegate(exitCode: number): void {
  process.exit(exitCode);
}

/** Isolate each Bash job without removing it from the outer runner's session. */
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
      const shell = resolveShell();
      // Privileged mode only on the supervisor prevents BASH_ENV/SHELLOPTS
      // from altering the containment script. The command shell uses normal env.
      const child = spawn(shell, ["-p", "-c", SUPERVISOR, "delegate-bash", shell, command], {
        cwd,
        detached: false,
        shell: false,
        env: commandEnv,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let settled = false;
        let exitCode: number | null = null;
        let groupId: number | undefined;
        let handshake = "";
        let timedOut = false;
        let cleaning = false;
        let exited = false;
        let closed = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let handshakeHandle: NodeJS.Timeout | undefined;
        let drainHandle: NodeJS.Timeout | undefined;
        const fd = child.stdio[3];

        const handleData = (data: Buffer): void => {
          if (!settled && !timedOut) onData(data);
        };
        const cleanup = (): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (handshakeHandle) clearTimeout(handshakeHandle);
          if (drainHandle) clearTimeout(drainHandle);
          signal?.removeEventListener("abort", handleAbort);
          child.removeListener("error", handleError);
          child.removeListener("exit", handleExit);
          child.removeListener("close", handleClose);
          child.stdout?.removeListener("data", handleData);
          child.stderr?.removeListener("data", handleData);
          fd?.removeListener("data", handleHandshake);
          fd?.removeListener("end", handleHandshakeEnd);
          fd?.removeListener("error", handleHandshakeError);
          child.stdout?.destroy();
          child.stderr?.destroy();
          fd?.destroy();
        };
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve({ exitCode });
        };
        const failContainment = (message: string): void => {
          if (settled) return;
          finish(new Error(`Bash containment/cleanup failed: ${message}`));
          // The outer runner owns the entire session, including any job whose
          // handshake was lost. Continuing this child would be unsafe.
          failDelegate(DELEGATE_BASH_CLEANUP_EXIT_CODE);
        };
        const maybeFinish = (): void => {
          if (settled || timedOut || groupId === undefined) return;
          if (closed) finish();
          else if (exited) drainHandle ??= setTimeout(() => finish(), POST_EXIT_DRAIN_MS);
        };
        const terminateJob = (): void => {
          if (settled || !timedOut || cleaning || groupId === undefined) return;
          cleaning = true;
          void createProcessTreeController(groupId).terminate().then(
            (result) => {
              if (settled) return;
              if (!result.processGroupGone) {
                failContainment(result.diagnostic ?? `process group ${groupId} survived cleanup`);
              } else {
                finish(new Error(`timeout:${timeout}`));
              }
            },
            (error: unknown) => failContainment(String(error).slice(0, 256)),
          );
        };
        function handleAbort(): void {
          if (settled) return;
          finish(new Error("Bash was aborted; delegation must end"));
          failDelegate(DELEGATE_BASH_ABORT_EXIT_CODE);
        }
        function handleError(error: Error): void {
          failContainment(`supervisor spawn: ${error.message}`);
        }
        function handleExit(code: number | null): void {
          exitCode = code;
          exited = true;
          // The supplied timeout bounds command execution, not post-exit drainage.
          if (timeoutHandle) clearTimeout(timeoutHandle);
          maybeFinish();
        }
        function handleClose(): void {
          closed = true;
          maybeFinish();
        }
        function handleHandshake(data: Buffer): void {
          handshake += data.toString("ascii");
          if (handshake.length > 32 || !/^[0-9]*\n?[0-9]*$/.test(handshake)) {
            failContainment("invalid job PGID handshake");
          }
        }
        function handleHandshakeEnd(): void {
          if (settled) return;
          if (!/^[1-9][0-9]*\n$/.test(handshake)) {
            failContainment("missing or invalid job PGID handshake");
            return;
          }
          const id = Number(handshake.trim());
          if (!Number.isSafeInteger(id) || id <= 0 || id === process.pid || id === child.pid) {
            failContainment("unsafe job PGID handshake");
            return;
          }
          groupId = id;
          if (handshakeHandle) clearTimeout(handshakeHandle);
          if (timedOut) terminateJob();
          else maybeFinish();
        }
        function handleHandshakeError(error: Error): void {
          failContainment(`job PGID handshake: ${error.message}`);
        }

        child.stdout?.on("data", handleData);
        child.stderr?.on("data", handleData);
        fd?.on("data", handleHandshake);
        fd?.once("end", handleHandshakeEnd);
        fd?.once("error", handleHandshakeError);
        child.once("error", handleError);
        child.once("exit", handleExit);
        child.once("close", handleClose);
        handshakeHandle = setTimeout(() => failContainment("job PGID handshake timed out"), HANDSHAKE_MS);
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (drainHandle) clearTimeout(drainHandle);
            terminateJob(); // If setup is still pending, handshake's bound stays in force.
          }, timeoutMs);
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
    description: `${bashTool.description} In a delegate, a supplied timeout stops this command group and returns a recoverable tool error after verified cleanup; abort ends the delegation.`,
  });
}
