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

There is no manager process, worker-script DSL, run registry, persistence layer, or recovery path.

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
- Validates complete profile replacements, disables, prompt files, tools, thinking, models, and bounded deadlines.
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
  timeoutMs: number; // normalized configured deadline
  systemPrompt: string;
}
```

### `src/runner.ts`

- Owns one child invocation from spawn through finalization.
- Creates and cleans the temporary prompt file when needed.
- Builds CLI arguments.
- Parses stdout through `protocol.ts`.
- Captures bounded stderr.
- Owns timers, abort listener, process-control calls, and the single finalization gate.

### `src/protocol.ts`

- Incremental UTF-8 line buffering with a maximum pending-line size.
- Parses only event types needed to classify progress and completion.
- Tracks assistant messages, errors, usage, tool starts/ends, and `agent_settled` when present.
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
- Keep ambient extension and skill discovery disabled; add only the selected profile's validated explicit local capability paths with repeated CLI flags.
- Preserve only the environment needed for provider authentication and normal Pi operation. V1 may inherit the environment, but must overwrite any internal recursion/depth variables it introduces.

## Prompt assembly

Use Pi's normal coding prompt plus an appended role prompt. This preserves ordinary coding behavior and project instruction discovery while the role prompt narrows authority.

Role prompts must state:

- the role's purpose;
- the allowed scope;
- that the task must finish within a bounded run;
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

Treat a finalized assistant text message that represents a non-tool terminal stop as the candidate final answer. `agent_settled`, when received, strengthens completion evidence and begins post-settle drainage.

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

## Deadline and cancellation

### Wall-clock deadline

Use the selected profile's fixed deadline; the model-facing tool exposes no deadline override. Arm the run deadline before or immediately after spawn. It includes startup, model calls, tools, and process drainage. Tests may inject shorter private runner deadlines to keep lifecycle fixtures deterministic and fast.

On deadline:

1. classify the run as timed out;
2. signal the process group with TERM;
3. wait no more than the configured termination grace period (suggested: 2 seconds);
4. signal the process group with KILL;
5. wait a short fixed verification period (suggested: 1 second);
6. destroy pipes and finalize even if the platform cannot prove every descendant exited.

The tool itself must not remain pending while waiting for perfect cleanup proof.

### Parent abort

Use the same termination path, classified as cancellation. If the signal is already aborted before spawn, do not launch.

### Fast-tool timeout

V1 may implement a small fixed timeout for known-fast tools: `read`, `grep`, `find`, `ls`, `edit`, and `write`. Track timers by `toolCallId` from `tool_execution_start` through `tool_execution_end`.

Suggested defaults:

- scout: 45 seconds
- reviewer/oracle: 120 seconds
- tester: 120 seconds for known-fast tools
- worker: 120 seconds for known-fast tools
- `bash`: bounded only by the run deadline in V1

If protocol event names differ in the installed Pi version, verify against the official example and actual JSON-mode output before coding the timer.

## Exit and pipe drainage

Node's child `exit` event can occur before `close`; descendants may keep stdout/stderr open forever. Therefore:

- listen to both `exit` and `close`;
- start a short post-exit pipe-drain timer on `exit`;
- if pipes do not close, destroy them and finalize;
- after a trustworthy semantic completion event, start a short process-drain timer even if `exit` has not fired;
- if the child remains alive after semantic completion, terminate the process group but preserve success if the terminal answer is valid.

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
  | "tool_timeout"
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

## Security

- Effective names and complete profiles come only from bundled definitions, the bounded user source, and the trusted parent project's bounded source.
- Project-controlled profile prompts are loaded only after `ctx.isProjectTrusted()` succeeds; delegate-call working directories cannot select profile sources.
- No shell interpolation in launch construction.
- No delegator-owned run artifacts are written to the repository. Tester commands may create bounded generated artifacts or local test state as part of exercising behavior, but must clean them up.
- Explicit tool allowlists per role.
- Worker is the only source-mutating role. Tester may create bounded temporary/generated artifacts and local test state through runtime commands, but its prompt forbids source and configuration edits and requires cleanup.
- Output and diagnostics are bounded before entering parent model context.
