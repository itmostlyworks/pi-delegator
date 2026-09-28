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
type ProcessRow = { readonly pid: number; readonly pgid: number; readonly sess: string; readonly stat: string };
type Snapshot = readonly ProcessRow[] | { readonly diagnostic: string };

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

function usableSessionKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key) &&
    !/^(?:0+|0x0+|unknown|none|n\/a)$/i.test(key);
}

function snapshot(): Snapshot {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,sess=,stat="], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    return { diagnostic: result.error
      ? errorMessage(result.error).slice(0, 256)
      : (result.stderr.trim().slice(0, 256) || `ps exited with ${String(result.status)}`) };
  }
  const rows: ProcessRow[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0 ||
        !Number.isSafeInteger(Number(match[2])) || !match[4]) {
      return { diagnostic: `Malformed ps process row: ${line.slice(0, 120)}` };
    }
    rows.push({ pid: Number(match[1]), pgid: Number(match[2]), sess: match[3]!, stat: match[4]! });
  }
  return rows;
}

/** Capture the POSIX session while the detached launch gate is still alive. */
export function captureProcessSession(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid launch gate pid ${pid}`);
  const rows = snapshot();
  if ("diagnostic" in rows) throw new Error(`Cannot capture launch gate session: ${rows.diagnostic}`);
  const target = rows.find((row) => row.pid === pid);
  const parent = rows.find((row) => row.pid === process.pid);
  if (!target || !parent) throw new Error("Cannot capture launch gate session: gate or parent missing from ps; keep the gate alive until capture completes");
  if (target.pid !== target.pgid || !usableSessionKey(target.sess) ||
      !usableSessionKey(parent.sess) || target.sess === parent.sess) {
    throw new Error("Unsafe launch gate session: expected a group leader with an unmasked, nonzero session distinct from the parent; keep the detached gate alive and check ps sess support");
  }
  return target.sess;
}

function activeProcessGroupMembers(processGroupId: number): GroupMembers {
  const rows = snapshot();
  if ("diagnostic" in rows) return rows;
  return rows.filter((row) => row.pgid === processGroupId && !row.stat.startsWith("Z"))
    .map((row) => row.pid);
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

/** Terminate every live group in a captured POSIX session, including reparented jobs. */
export function createProcessSessionController(
  sessionKey: string,
  options: ProcessTreeOptions = {},
): ProcessTreeController {
  if (!usableSessionKey(sessionKey)) throw new Error("Invalid or masked process session key; capture it from a live detached launch gate");
  let termination: Promise<ProcessTreeTermination> | undefined;
  return {
    terminate(): Promise<ProcessTreeTermination> {
      if (termination) return termination;
      termination = (async () => {
        let termSent = false;
        let killSent = false;
        let diagnostic: string | undefined;
        const seenTerm = new Set<number>();
        const graceEnd = Date.now() + Math.max(0, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS);
        const verifyEnd = graceEnd + Math.max(0, options.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS);
        const inspect = (): number[] | undefined => {
          const rows = snapshot();
          if ("diagnostic" in rows) {
            diagnostic = `Cannot verify process session ${sessionKey}: ${rows.diagnostic}`;
            return undefined;
          }
          const parent = rows.find((row) => row.pid === process.pid);
          if (!parent || !usableSessionKey(parent.sess) || parent.sess === sessionKey) {
            diagnostic = "Unsafe session cleanup: parent session missing, masked, or matches target; refusing to signal";
            return undefined;
          }
          const members = rows.filter((row) => row.sess === sessionKey && !row.stat.startsWith("Z"));
          if (members.some((row) => row.pgid <= 0)) {
            diagnostic = `Cannot safely signal session ${sessionKey}: ps reported a nonpositive process group`;
            return undefined;
          }
          return [...new Set(members.map((row) => row.pgid))];
        };
        const send = (groups: readonly number[], signal: NodeJS.Signals, seen?: Set<number>) => {
          for (const pgid of groups) {
            if (seen?.has(pgid)) continue;
            seen?.add(pgid);
            const result = signalProcessGroup(pgid, signal);
            if (result === "sent") {
              if (signal === "SIGTERM") termSent = true;
              else killSent = true;
            } else if (typeof result === "object") {
              diagnostic = `${signal} group ${pgid}: ${result.diagnostic.slice(0, 160)}`;
            }
          }
        };
        const pause = async (until: number) => {
          const remaining = until - Date.now();
          if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, remaining)));
        };
        // Both phases use fixed deadlines: discovering another job never extends cleanup.
        while (true) {
          const groups = inspect();
          if (groups?.length === 0) return { termSent, killSent, processGroupGone: true };
          if (groups) send(groups, "SIGTERM", seenTerm);
          if (Date.now() >= graceEnd) break;
          await pause(graceEnd);
        }
        while (true) {
          const groups = inspect();
          if (groups?.length === 0) return { termSent, killSent, processGroupGone: true };
          if (groups) send(groups, "SIGKILL");
          if (Date.now() >= verifyEnd) break;
          await pause(verifyEnd);
        }
        const remaining = inspect();
        return {
          termSent,
          killSent,
          processGroupGone: remaining?.length === 0,
          ...(remaining?.length === 0 ? {} : { diagnostic: diagnostic ??
            `Session ${sessionKey} still has active groups: ${remaining?.slice(0, 12).join(", ") ?? "unverified"}` }),
        };
      })();
      return termination;
    },
  };
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
