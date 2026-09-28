# Technical design

## Architectural summary

`pi-delegator` is a Pi extension with one tool and one subprocess runner:

```text
parent Pi
  └─ delegate tool
      ├─ resolve one immutable effective profile
      ├─ build explicit child CLI arguments
      ├─ spawn fresh Pi process in its own POSIX process group
      ├─ parse bounded JSONL events
      ├─ stream compact progress
      └─ finalize once with result, failure, or forced cleanup
```

There is no manager process, worker-script DSL, run registry, or persistence layer. Recovery here means the same running delegate may retry or adapt after a failed/timed-out subcommand; it is not package-orchestrated whole-run retry.

**Target contract, not current behavior:** This document describes the approved direction. The current implementation still has fixed profile run deadlines and treats Bash timeout/abort as fatal to the delegate. `README.md` documents current behavior separately; `docs/REQUIREMENTS.md` defines the target contract. This documentation-only change does not alter runtime or settle the pending API and process-ownership design.

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
- Validates complete profile replacements, disables, prompt files, tools, thinking, models, and any explicitly configured run deadline. The optional deadline representation and migration rules remain undecided.
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
  // Run deadline is optional in the target contract; field/default/migration design pending.
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
- Currently wraps Pi's public `createBashTool` with `BashOperations` that spawn shells with `detached: false`, preserving the outer runner's process-group ownership even after ordinary background commands reparent. This topology does not yet provide command-local timeout cleanup; its replacement or adaptation is pending design.
- Uses `/bin/bash` or `bash` on `PATH`; custom Pi `shellPath` is not applied.
- Currently, Bash timeout/abort fails the whole child via reserved exit codes in `delegate-child-contract.ts`. Target: a command-local failure or timeout can be reported to the same delegate for retry/adaptation only after command cleanup is verified. If cleanup fails or cannot be verified, report an explicit cleanup failure rather than treating it as an ordinary recoverable timeout. How command ownership, cancellation and recovery cleanup fit together remains a design question; do not terminate unrelated earlier background commands merely to enable recovery.
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

- POSIX process-group launch and termination helpers.
- TERM, bounded grace period, KILL escalation.
- Best-effort liveness verification without indefinite polling.
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
- Set `detached: true` on POSIX so the child owns a process group.
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

### Optional run deadline (target)

No run-deadline timer is armed by default in the target contract. A user may opt into an overall wall-clock safeguard; when configured, it covers startup, model calls, tools, and drainage. Its expiry terminates the delegate using bounded TERM → KILL cleanup and reports a run timeout, not a model answer. The tool must not wait indefinitely for perfect cleanup proof. Command recovery must not reset or extend an opted-in run deadline. The opt-in interface, validation, and migration representation are **pending design**, including how existing explicit user `deadlineMs` values retain their intended safeguards. Do not silently discard those values or treat existing bundled profile limits as user opt-in. Current runtime still enforces mandatory profile deadlines.

### Parent abort

Cancellation always terminates the owned delegate process tree with bounded escalation and honest cleanup diagnostics, regardless of whether a run deadline is configured. If already aborted before spawn, do not launch. Parent cancellation is not a recoverable command failure.

### Subcommand recovery (target)

Subcommand failure or timeout should return a bounded diagnostic to the running delegate so it can retry or adapt. Command-local cancellation/abort semantics and ownership topology require explicit design before implementation: recovery must not continue alongside an unverified surviving command. Verify cleanup within bounded waits before exposing a recoverable outcome; failure to contain or verify cleanup must be surfaced as a cleanup failure, not an ordinary recovered timeout. Do not assume cleanup may kill earlier background commands unrelated to the timed-out command; whether and how to isolate them remains open. Do not add package-supplied fast-tool timers.

## Exit and pipe drainage

Node's child `exit` event can occur before `close`; descendants may keep stdout/stderr open forever. Therefore:

- listen to both `exit` and `close`;
- start a bounded post-exit pipe-drain timer on `exit`;
- if pipes do not close, destroy them and finalize;
- after a trustworthy semantic completion event, start a bounded process-drain timer even if `exit` has not fired;
- if the child remains alive after semantic completion, terminate the process group; preserve success if the terminal answer is valid and cleanup status is reported honestly. Cleanup that cannot be verified must not be silently presented as a clean completion.

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
  | "tool_timeout" // current fatal behavior; target command-local timeout is recoverable after verified cleanup
  | "cleanup_failed" // target: containment or cleanup not verified
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

Ordinary Bash descendants inherit the owned process group. Deliberate daemonization or separate process groups created by trusted custom extensions are not contained. Abrupt parent death is not Pi tool cancellation and does not guarantee immediate cleanup; no parent-death supervisor is provided.

## Security

- Effective names and complete profiles come only from bundled definitions, the bounded user source, and the trusted parent project's bounded source.
- Project-controlled profile prompts are loaded only after `ctx.isProjectTrusted()` succeeds; delegate-call working directories cannot select profile sources.
- No shell interpolation in launch construction.
- No delegator-owned run artifacts are written to the repository. Tester commands may create bounded generated artifacts or local test state as part of exercising behavior, but must clean them up.
- Explicit tool allowlists per role.
- Worker is the only source-mutating role. Tester may create bounded temporary/generated artifacts and local test state through runtime commands, but its prompt forbids source and configuration edits and requires cleanup.
- Output and diagnostics are bounded before entering parent model context.
