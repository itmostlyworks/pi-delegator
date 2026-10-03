import { spawnSync } from "node:child_process";
import { release } from "node:os";

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_VERIFY_MS = 1_000;
const VERIFY_INTERVAL_MS = 25;
const PS_TIMEOUT_MS = process.platform === "darwin" ? 500 : 250;

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

// macOS ps "sess" is a kernel pointer and may be masked to zero. Query the
// POSIX ID instead; ESRCH is the only safe reason to omit a sampled process.
const MAC_SESSION_SCRIPT = `import json, os, sys
result = {}
for pid in json.load(sys.stdin):
    try:
        for attempt in range(3):
            sid = os.getsid(pid)
            pgid = os.getpgid(pid)
            if sid == os.getsid(pid):
                result[str(pid)] = [str(sid), pgid]
                break
        else:
            raise RuntimeError("session changed repeatedly during query")
    except ProcessLookupError:
        result[str(pid)] = None
json.dump(result, sys.stdout)
`;

function macSessionRows(rows: readonly ProcessRow[]): Snapshot {
  const result = spawnSync("python3", ["-I", "-S", "-c", MAC_SESSION_SCRIPT], {
    input: JSON.stringify(rows.map((row) => row.pid)),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    return { diagnostic: `macOS getsid query failed (Python 3 is required on PATH): ${
      (result.error ? errorMessage(result.error) : result.stderr.trim() || `exit ${result.status}`).slice(0, 256)}` };
  }
  try {
    const sessions: unknown = JSON.parse(result.stdout);
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) throw new Error("expected session map");
    const resolved: ProcessRow[] = [];
    for (const row of rows) {
      const identity: unknown = (sessions as Record<string, unknown>)[String(row.pid)];
      if (identity === null) continue; // Exited between ps and getsid.
      if (!Array.isArray(identity) || identity.length !== 2) throw new Error(`invalid session ID for PID ${row.pid}`);
      const [sid, pgid]: unknown[] = identity;
      if (typeof sid !== "string" || !/^[1-9]\d*$/.test(sid) || !Number.isSafeInteger(Number(sid)) ||
          typeof pgid !== "number" || !Number.isSafeInteger(pgid) || pgid <= 0) {
        throw new Error(`invalid session ID or process group for PID ${row.pid}`);
      }
      // Read SID and PGID together: shell job creation can change the ps PGID.
      resolved.push({ ...row, sess: sid, pgid });
    }
    return resolved;
  } catch (error) {
    return { diagnostic: `Invalid macOS getsid response: ${errorMessage(error).slice(0, 256)}` };
  }
}

function snapshot(includeSessions = true): Snapshot {
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
  return includeSessions && process.platform === "darwin" ? macSessionRows(rows) : rows;
}

// Keep failure evidence bounded and single-line; never include command lines or environment.
function captureContext(pid: number, target?: ProcessRow, parent?: ProcessRow): string {
  const field = (value: string): string => JSON.stringify(value.slice(0, 80));
  const row = (value: ProcessRow | undefined): string => value
    ? `{pid=${value.pid},pgid=${value.pgid},sess=${field(value.sess)},stat=${field(value.stat)}}`
    : "missing";
  return `gatePid=${pid}; parentPid=${process.pid}; gate=${row(target)}; parent=${row(parent)}; ` +
    `platform=${process.platform}; release=${field(release())}; arch=${process.arch}; ` +
    `node=${process.version}; uv=${process.versions.uv ?? "unknown"}; ps="ps -axo pid=,pgid=,sess=,stat="; ` +
    `sessionSource=${process.platform === "darwin" ? "python3 os.getsid" : "ps sess"}`;
}

/** Capture the POSIX session while the detached launch gate is still alive. */
export function captureProcessSession(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid launch gate pid ${pid}`);
  const rows = snapshot();
  if ("diagnostic" in rows) throw new Error(`Cannot capture launch gate session: ${rows.diagnostic}; ${captureContext(pid)}`);
  const target = rows.find((row) => row.pid === pid);
  const parent = rows.find((row) => row.pid === process.pid);
  const context = captureContext(pid, target, parent);
  if (!target || !parent) throw new Error(`Cannot capture launch gate session: gate or parent missing from ps; keep the gate alive until capture completes; ${context}`);
  const failedChecks = [
    target.pid !== target.pgid ? "gate_not_group_leader" : undefined,
    !usableSessionKey(target.sess) ? "gate_session_unusable" : undefined,
    !usableSessionKey(parent.sess) ? "parent_session_unusable" : undefined,
    target.sess === parent.sess ? "session_matches_parent" : undefined,
  ].filter((value) => value !== undefined);
  if (failedChecks.length > 0) {
    throw new Error(`Unsafe launch gate session: expected a group leader with an unmasked, nonzero session distinct from the parent; failed checks=${failedChecks.join(",")}; ${context}`);
  }
  return target.sess;
}

function activeProcessGroupMembers(processGroupId: number): GroupMembers {
  const rows = snapshot(false);
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
            ...(typeof term === "object"
              ? { diagnostic: `SIGTERM group ${processGroupId}: ${term.diagnostic.slice(0, 160)}; group verified gone` }
              : {}),
          };
        }

        const kill = signalProcessGroup(processGroupId, "SIGKILL");
        const afterKill = await waitUntilGroupGone(
          processGroupId,
          options.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS,
        );
        const diagnostics = [
          typeof term === "object" ? `SIGTERM group ${processGroupId}: ${term.diagnostic.slice(0, 160)}` : undefined,
          typeof kill === "object" ? `SIGKILL group ${processGroupId}: ${kill.diagnostic.slice(0, 160)}` : undefined,
          afterKill.gone ? (typeof term === "object" || typeof kill === "object" ? "group verified gone" : undefined) : "cleanup unverified",
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
