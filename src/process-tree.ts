import { spawnSync } from "node:child_process";

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_VERIFY_MS = 1_000;
const VERIFY_INTERVAL_MS = 25;
const PS_TIMEOUT_MS = 250;

export interface ProcessTreeTermination {
  readonly termSent: boolean;
  readonly killSent: boolean;
  readonly processGroupGone: boolean;
  readonly diagnostic?: string;
}

export interface ProcessTreeController {
  terminate(): Promise<ProcessTreeTermination>;
}

interface ProcessTreeOptions {
  readonly termGraceMs?: number;
  readonly killVerifyMs?: number;
}

type SignalResult = "sent" | "absent" | { readonly diagnostic: string };
type GroupMembers = readonly number[] | { readonly diagnostic: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): SignalResult {
  try {
    process.kill(-processGroupId, signal);
    return "sent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent";
    return { diagnostic: errorMessage(error) };
  }
}

function activeProcessGroupMembers(processGroupId: number): GroupMembers {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    return {
      diagnostic: result.error
        ? errorMessage(result.error)
        : result.stderr.trim() || `ps exited with ${String(result.status)}`,
    };
  }

  const members: number[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!match || Number(match[2]) !== processGroupId || match[3]?.startsWith("Z")) continue;
    members.push(Number(match[1]));
  }
  return members;
}

async function waitUntilGroupGone(
  processGroupId: number,
  timeoutMs: number,
): Promise<{ readonly gone: true } | { readonly gone: false; readonly diagnostic: string }> {
  const deadlineAt = Date.now() + Math.max(0, timeoutMs);
  let lastDiagnostic: string | undefined;

  while (true) {
    const members = activeProcessGroupMembers(processGroupId);
    if ("diagnostic" in members) {
      lastDiagnostic = members.diagnostic;
    } else {
      if (members.length === 0) return { gone: true };
      lastDiagnostic = `Process group ${processGroupId} still has active members: ${members.join(", ")}`;
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return { gone: false, diagnostic: lastDiagnostic ?? `Could not verify process group ${processGroupId}` };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, remainingMs)));
  }
}

/** Owns one detached POSIX process group and arbitrates its termination exactly once. */
export function createProcessTreeController(
  processGroupId: number,
  options: ProcessTreeOptions = {},
): ProcessTreeController {
  let termination: Promise<ProcessTreeTermination> | undefined;

  return {
    terminate(): Promise<ProcessTreeTermination> {
      if (termination) return termination;
      termination = (async () => {
        const term = signalProcessGroup(processGroupId, "SIGTERM");
        const afterTerm = await waitUntilGroupGone(
          processGroupId,
          options.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
        );
        if (afterTerm.gone) {
          return {
            termSent: term === "sent",
            killSent: false,
            processGroupGone: true,
            ...(typeof term === "object" ? { diagnostic: term.diagnostic } : {}),
          };
        }

        const kill = signalProcessGroup(processGroupId, "SIGKILL");
        const afterKill = await waitUntilGroupGone(
          processGroupId,
          options.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS,
        );
        const diagnostics = [
          typeof term === "object" ? `SIGTERM: ${term.diagnostic}` : undefined,
          typeof kill === "object" ? `SIGKILL: ${kill.diagnostic}` : undefined,
          afterKill.gone ? undefined : afterTerm.diagnostic,
          afterKill.gone ? undefined : afterKill.diagnostic,
        ].filter((value): value is string => value !== undefined);

        return {
          termSent: term === "sent",
          killSent: kill === "sent",
          processGroupGone: afterKill.gone,
          ...(diagnostics.length === 0 ? {} : { diagnostic: diagnostics.join("; ") }),
        };
      })();
      return termination;
    },
  };
}
