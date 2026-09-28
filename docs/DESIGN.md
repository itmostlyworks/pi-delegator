# Technical design

## Architectural summary

`pi-delegator` is a Pi extension with one tool and one subprocess runner:

```text
parent Pi
  └─ delegate tool
      ├─ resolve one immutable effective profile
      ├─ build explicit child CLI arguments
      ├─ spawn a detached `/bin/sh` gate and exec Pi in an owned POSIX session
      ├─ parse bounded JSONL events
      ├─ stream compact progress
      └─ finalize once with result, failure, or forced cleanup
```

There is no manager process, worker-script DSL, run registry, or persistence layer. Recovery here means the same running delegate may retry or adapt after a failed/timed-out subcommand; it is not package-orchestrated whole-run retry.

**Implementation status:** Optional deadlines and command recovery are implemented locally but not yet released on npm. Native macOS `ps sess` behavior and live provider execution remain unverified.

## Suggested modules

### `src/index.ts`

- Registers the `delegate` tool with TypeBox.
- Validates input and cwd.
- Loads the bounded user source once, then resolves a session-scoped immutable registry after project trust is known.
- Loads `.pi/pi-delegator.json` only from a trusted parent session cwd, with project → user → bundled precedence.
- Generates the `agent` schema and descriptions from that registry.
- Resolves the selected profile and calls `runDelegate` with Pi's tool `AbortSignal` and `onUpdate` callback.
- Converts the runner outcome into a Pi tool result.
- Keeps rendering minimal; default rendering is acceptable for V1.

### `src/agents.ts`

- Defines the five immutable bundled profiles.
- Loads packaged Markdown prompt bodies and exports the bundled registry.
- Provides the normalized internal profile type shared by bundled and configured profiles.

### `src/config.ts`

- Reads bounded user and trusted-project sources once per session.
- Validates complete profile replacements, disables, prompt files, tools, thinking, models, and any explicitly configured run deadline. Omitted or `null` `deadlineMs` disables the timer; existing explicit positive values remain active through 2,147,483,647 ms.
- Resolves project entries over user and bundled profiles without inheritance or field merging.
- Returns a deeply immutable effective registry; delegate-call working directories never affect discovery.

Suggested profile type:

```ts
interface DelegateProfile {
  name: string;
  description: string;
  model: string | null;
  tools: readonly string[];
  skills: readonly string[];
  extensions: readonly string[];
  thinking: ThinkingLevel;
  timeoutMs: number | null; // null by default; configured from optional deadlineMs
  systemPrompt: string;
}
```

### `src/runner.ts`

- Owns one child invocation from spawn through finalization.
- Creates and cleans the temporary prompt file when needed.
- Builds CLI arguments.
- Parses stdout through `protocol.ts`.
- Captures bounded stderr.
- Owns any configured run-deadline timer, bounded cleanup/drain timers, abort listener, process-control calls, and the single finalization gate.

### `src/delegate-bash-extension.ts`

- Private child-only extension loaded before configured extensions: Pi uses the first registration for each tool name.
- Wraps Pi's public `createBashTool` with `BashOperations`: each operation starts a non-detached privileged supervisor with monitor mode enabled; the nested command Bash runs with monitor mode disabled (`+m`), in its own PGID within the delegate session. A private fd 3 handshake supplies the PGID within 1 second.
- Uses `/bin/bash` or `bash` on `PATH`; custom Pi `shellPath` is not applied.
- Command timeouts clean up and verify only the affected job PGID with fixed TERM → KILL windows, then return a recoverable Pi tool error; ordinary command failures also remain recoverable. Earlier background groups are retained. Failed containment/verification exits with reserved code 86 (`cleanup_failed`); abort exits with reserved code 87 (`cancelled`) and is terminal.
- Settles on pipe close or a bounded post-exit drain wait, then removes listeners, clears timers, and destroys streams. Continuous background output cannot extend drainage.
- A private environment marker gates registration and is removed from Bash command environments. This is not a security boundary.

### `src/protocol.ts`

- Incremental UTF-8 line buffering with a maximum pending-line size.
- Discards oversized tool-result events through a bounded drain-to-newline mode; oversized assistant or unclassifiable lines remain protocol errors because they may affect completion authority.
- Parses only event types needed to classify progress and completion.
- Tracks assistant messages, errors, usage, turn/tool activity, and `agent_settled` when present. A later turn supersedes a transient failed attempt or stale terminal candidate from Pi's in-process continuation and provider-retry paths.
- Unknown valid JSON events are ignored.
- Non-JSON lines are retained only as bounded diagnostics unless the child protocol explicitly permits them.

### `src/process-tree.ts`

- Captures an opaque, distinct, unmasked `ps sess` key from the live detached launch gate before it execs Pi. Privileged gate authorization is private; fail early if session identification is unusable.
- Scans and signals every live group in that session on normal completion, parent cancellation, and opted-in deadline, including reparented Bash jobs. Bounds `ps` output/calls and TERM → KILL windows; failed verification is reported honestly.
- No Windows fallback that silently downgrades to direct-child termination.

Modules may be combined if the resulting code is easier to audit.

## Child command

Conceptual invocation:

```bash
pi \
  --mode json \
  --print \
  --no-session \
  --no-extensions \
  --no-skills \
  [--skill <explicit-local-path>]... \
  [--extension <explicit-local-path>]... \
  --model <effective-provider/model> \
  --thinking <effective-level> \
  --tools <profile-tools> \
  --append-system-prompt <private-temp-file> \
  'Task: <task>'
```

Requirements:

- Resolve the current Pi executable robustly. Permit a private test override such as `PI_DELEGATOR_PI_BINARY`.
- Use the caller's bounded model selector when supplied; otherwise use the effective profile model when non-null, then the active parent model.
- Do not expose thinking to the caller; use the selected effective profile's level.
- Use an argument array and `shell: false`.
- Spawn in the requested cwd.
- Set `detached: true` on POSIX for the `/bin/sh` launch gate; capture its new session key before authorizing exec of Pi.
- Ignore stdin; pipe stdout/stderr.
- Do not pass parent extension paths or session files.
- Keep ambient extension and skill discovery disabled; add the private Bash extension first for Bash-enabled profiles, followed by the selected profile's validated explicit local capability paths with repeated CLI flags.
- Preserve only the environment needed for provider authentication and normal Pi operation. V1 may inherit the environment, but must overwrite any internal recursion/depth variables it introduces.

## Prompt assembly

Use Pi's normal coding prompt plus an appended role prompt. This preserves ordinary coding behavior and project instruction discovery while the role prompt narrows authority.

Role prompts must state:

- the role's purpose;
- the allowed scope;
- that tasks remain bounded in scope and respect cancellation or an explicitly configured run deadline;
- the expected final response format;
- whether modification is forbidden or allowed;
- that it must not launch nested agents or long-lived services.

Temporary prompt files:

- live under the OS temporary directory;
- use mode `0600`;
- contain no shell interpolation;
- are deleted in finalization best-effort.

## Protocol state

The runner needs only small state:

```ts
interface ProtocolState {
  finalText?: string;
  assistantError?: string;
  stopReason?: string;
  agentSettled: boolean;
  currentTools: Map<string, ActiveTool>;
  usage: UsageSummary;
  malformedLineCount: number;
}
```

Do not retain the full transcript. Keep only information needed for progress, completion, diagnostics, and usage.

### Terminal answer

Treat a finalized assistant text message that represents a non-tool terminal stop as the candidate final answer. `agent_settled`, when received, strengthens completion evidence and begins post-settle drainage. An assistant error alone is not semantic completion because Pi may retry a transient provider failure inside the same child; only the settled final assistant outcome is authoritative.

Do not require the OS process to exit cleanly before preserving a valid candidate answer. A leaked watcher can keep the process alive after semantically complete work.

## Lifecycle state machine

The public lifecycle should remain small:

```text
starting → running → terminal
                    ├─ succeeded
                    ├─ failed
                    ├─ timed_out
                    └─ cancelled
```

Cleanup state is internal metadata, not a second public lifecycle.

### Single finalization gate

Every exit path calls one idempotent `finalize(reason)` function. It must:

1. win an atomic/in-memory `settled` guard;
2. clear all timers;
3. remove the parent abort listener;
4. stop accepting stream data;
5. destroy stdout/stderr if necessary;
6. end or destroy temporary streams/files;
7. clean the temporary prompt;
8. return exactly one outcome.

No callback may resolve/reject the outer promise independently.

## Deadline, recovery, and cancellation

### Optional run deadline

No run-deadline timer is armed by default. A user may opt into an overall wall-clock safeguard; when configured, it covers startup, model calls, tools, and drainage. Its expiry terminates the delegate using bounded TERM → KILL cleanup and reports a run timeout, not a model answer. The tool must not wait indefinitely for perfect cleanup proof. Command recovery must not reset or extend an opted-in run deadline. Complete user/project profile definitions may omit `deadlineMs` or set it to `null` to disable the timer; explicit positive integers, including previously configured values, enable it up to Node's 2,147,483,647 ms timer maximum. Other fields remain required. Bundled profiles have `timeoutMs: null`; there is no caller deadline field.

### Parent abort

Cancellation always terminates the owned delegate process tree with bounded escalation and honest cleanup diagnostics, regardless of whether a run deadline is configured. If already aborted before spawn, do not launch. Parent cancellation is not a recoverable command failure.

### Subcommand recovery

A Bash timeout terminates only its isolated job group and verifies cleanup with bounded waits before reporting a recoverable Pi tool error to the same delegate. Earlier background groups remain until whole-session cleanup. A failed handshake or unverified cleanup is terminal `cleanup_failed` (exit 86), not a recovered timeout; abort is terminal `cancelled` (exit 87). Command-local PGID cleanup cannot contain deliberate regrouping within the command; whole-session cleanup still sees groups in the captured session. Do not add package-supplied fast-tool timers.

## Exit and pipe drainage

Node's child `exit` event can occur before `close`; descendants may keep stdout/stderr open forever. Therefore:

- listen to both `exit` and `close`;
- start a bounded post-exit pipe-drain timer on `exit`;
- if pipes do not close, destroy them and finalize;
- after a trustworthy semantic completion event, start a bounded process-drain timer even if `exit` has not fired;
- if the child remains alive after semantic completion, clean up the captured session; preserve success if the terminal answer is valid and cleanup status is reported honestly. Cleanup that cannot be verified must not be silently presented as a clean completion.

Forced cleanup after a valid terminal answer should be visible in result details:

```ts
interface CleanupDetails {
  forced: boolean;
  termSent: boolean;
  killSent: boolean;
  processExited: boolean;
  pipesClosed: boolean;
}
```

## Result model

Suggested successful details:

```ts
interface DelegateResultDetails {
  agent: string;
  model?: string;
  thinking: string; // effective configured or built-in level
  durationMs: number;
  usage?: UsageSummary;
  truncated: boolean;
  originalBytes?: number;
  cleanup: CleanupDetails;
}
```

Failure details add a stable code such as:

```ts
type FailureCode =
  | "unsupported_platform"
  | "spawn_failed"
  | "cancelled"
  | "run_timeout"
  | "cleanup_failed" // containment or cleanup not verified (reserved child exit 86)
  | "protocol_error"
  | "child_error"
  | "missing_terminal_answer";
```

The user-visible message should name the agent, failure, elapsed time, current tool when known, and bounded stderr tail when useful.

## Parallel safety

Each `delegate` execution owns all mutable state in its function scope. Shared state is limited to immutable profiles. No global current-run variable, shared output path, or shared temporary prompt filename is allowed.

Pi may execute multiple sibling delegate calls concurrently; tests must exercise this.

## Platform policy

V1 officially supports macOS and Linux. On `win32`, fail before spawning with a concise message explaining that reliable process-tree termination is not implemented. Do not silently fall back to `child.kill()` and claim equivalent guarantees.

## Containment limits

Ordinary Bash jobs have distinct groups in the owned session, so whole-session cleanup includes them. Command-local cleanup does not cover deliberate regrouping within a command. Deliberate `setsid`/session escape, including by trusted custom extensions, is not contained. Native macOS session-key functionality remains unverified; fail early if `ps` returns unusable or masked session keys. Abrupt parent death is not Pi tool cancellation and does not guarantee immediate cleanup; no parent-death supervisor is provided.

## Security

- Effective names and complete profiles come only from bundled definitions, the bounded user source, and the trusted parent project's bounded source.
- Project-controlled profile prompts are loaded only after `ctx.isProjectTrusted()` succeeds; delegate-call working directories cannot select profile sources.
- No shell interpolation in launch construction.
- No delegator-owned run artifacts are written to the repository. Tester commands may create bounded generated artifacts or local test state as part of exercising behavior, but must clean them up.
- Explicit tool allowlists per role.
- Worker is the only source-mutating role. Tester may create bounded temporary/generated artifacts and local test state through runtime commands, but its prompt forbids source and configuration edits and requires cleanup.
- Output and diagnostics are bounded before entering parent model context.
