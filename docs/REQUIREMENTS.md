# Product requirements

> Optional deadlines and Bash command recovery shipped in 0.6.0 and are included in the published 0.6.5 npm package. The 0.6.x lifecycle changes remain unverified with live providers and native macOS session-key handling. Earlier authenticated smoke results are historical; see [release verification](RELEASE_CHECK.md).

## Problem

Delegating a focused task to a fresh agent is useful, but existing subagent systems often combine that primitive with workflows, durable async state, scheduling, recovery, inter-agent communication, and rich fleet UI. The larger lifecycle surface has produced recurring hangs, misleading status, incomplete cancellation, and agent-type-specific surprises.

We need a delegation primitive whose behavior is easy to understand, lets useful work continue, and stops reliably when cancelled. Bounded cleanup is not the same as a mandatory limit on task duration.

## Goal

Provide a Pi extension that lets the parent agent invoke one named delegate in a fresh Pi subprocess, observe compact progress, and receive a trustworthy final result or a precise failure.

## Lifecycle priorities

- A subcommand failure or supplied timeout is a recoverable tool result, not automatically a failed delegation. After command cleanup, the same delegate can retry, adapt, or report that it is blocked.
- Parent cancellation reliably stops the delegate and its owned subprocesses.
- Cleanup and post-completion drainage have bounded waits; output and diagnostics remain bounded.
- Overall run deadlines are optional user-controlled safeguards, not mandatory profile limits. Without an explicit opt-in, there is no run timer.
- Slow work or silence alone is not failure. Recovery does not reset or extend an explicitly configured overall deadline.

Primary scenario: a delegate's command times out while working on a task. Once that command is cleaned up, the delegate receives the timeout as a tool error and can continue the same task without the parent restarting the delegation. The original timeout remains visible; recovery must not conceal cleanup failure.

## Users

The primary user is a Pi coding agent orchestrating local software work. A human observes the tool call but should not need to operate a separate fleet UI or recover durable run state.

## V1 user stories

1. As a parent agent, I can ask a scout to inspect a codebase without filling my context with discovery work.
2. As a parent agent, I can ask a reviewer or oracle for a fresh-context opinion.
3. As a parent agent, I can ask a tester to exercise a feature's real behavior and return evidence and a verdict.
4. As a parent agent, I can hand one bounded implementation task to a worker.
5. As a parent agent, I can launch several independent delegates through Pi's ordinary parallel tool calls.
6. As a user, I can cancel the parent tool call and know the delegated process tree will be terminated.
7. As a user, I can let a delegate work until completion or cancellation, and opt into an overall deadline when I need one.
8. As a user, I receive the child's valid final answer even if an extension, watcher, or inherited subprocess prevents the child event loop or pipes from draining normally.
9. As a parent agent, I do not have to restart a delegation merely because one of its commands fails or times out.

## Public interface

Register exactly one model-facing tool named `delegate`.

```ts
interface DelegateInput {
  agent: string; // constrained by the tool schema to an effective profile name
  task: string;
  model?: string;
  cwd?: string;
}
```

Rules:

- Exactly one child per call.
- `task` must be non-empty and bounded in size.
- `cwd` defaults to the parent context's cwd and must resolve to an existing directory.
- `model`, when supplied, is a bounded Pi model selector passed to the child; otherwise the effective profile's model is used when non-null, then the parent model.
- Thinking is not exposed to the calling agent. It comes from the effective profile; Pi may clamp it to the selected model's capabilities.
- Overall deadlines require explicit user opt-in; bundled profiles do not impose them. Configured `deadlineMs` omitted or `null` disables the timer; explicit existing positive values remain active. There is no model-facing deadline input.
- Unknown fields and names outside the immutable effective registry are rejected by the schema.
- There are no generic per-call prompt or tool override fields. Profiles continue to own role authority and tool access.

## Built-in delegates

### Scout

- Purpose: fast local codebase reconnaissance
- Default thinking: `low`
- Tools: `read`, `grep`, `find`, `ls`
- No default run deadline
- No `bash`, write tools, skills, or extensions

### Reviewer

- Purpose: fresh-context correctness and maintainability review
- Default thinking: `high`
- Tools: `read`, `grep`, `find`, `ls`, `bash`
- No default run deadline
- Prompt instructs it not to modify files

### Oracle

- Purpose: challenge assumptions and advise on material decisions
- Default thinking: `high`
- Tools: `read`, `grep`, `find`, `ls`
- No default run deadline
- Prompt instructs it to advise, not implement

### Tester

- Purpose: exercise a feature's real behavior in a local, development, or test environment and report evidence
- Default thinking: `high`
- Tools: `read`, `grep`, `find`, `ls`, `bash`
- No default run deadline
- Prompt permits bounded generated state and short-lived local services, forbids source or configuration edits and production credentials/data, and requires cleanup plus a pass/fail/blocked verdict

### Worker

- Purpose: implement one clearly bounded task
- Default thinking: `high`
- Tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`
- No default run deadline
- Prompt requires a concise change and validation report

Bundled profile models are null, so the child inherits the parent model unless the call supplies an override. User configuration may add, atomically replace, or disable complete profiles. Complete definitions own model, thinking, role prompt, and tool allowlist; callers can override only the model for one invocation. Roles do not imply mandatory time budgets.

## User profile configuration

The bounded user document at the Pi agent directory's `pi-delegator.json` contains a `profiles` map. Each name maps to `null`, which disables it, or a complete definition containing `description`, `model`, `thinking`, `prompt`, `tools`, `skills`, and `extensions`. `deadlineMs` is optional: omitted or `null` disables the timer; an explicit positive integer retains its safeguard, up to 2,147,483,647 ms (Node's timer maximum). Optional `displayName` is a trimmed, nonblank string bounded to 256 UTF-8 bytes. Human-facing labels use it, falling back to title-cased hyphen-separated identifiers; tool schemas and result `agent` identifiers are unchanged. Result details retain the optional name for rendering independently of the current registry. All other definition fields remain required. Definitions replace whole profiles; there is no inheritance or field merging. Prompt and capability paths resolve relative to the source document. Skills identify explicit local Markdown files or directories, and extensions identify explicit local JavaScript or TypeScript files. Capability paths are canonicalized and must be readable, supported, and unique; remote sources and pi-delegator itself are rejected before launch.

Configuration is immutable for each session. Trusted projects may provide the same document at `.pi/pi-delegator.json`; complete project entries replace or disable user and bundled entries. Invalid, incomplete, legacy, or unsafe sources prevent registration and identify the source, affected profile, and corrective action. Tool lists cannot enable nested `delegate` calls. Any optional deadline must be validated against supported timer limits rather than imposing a role-based work budget. Untrusted project documents are ignored, and delegate-call working directories never participate in profile discovery.

## Progress behavior

Progress is observational, never lifecycle authority.

- Stream a compact update when the child starts a tool or completes an assistant message.
- Include a bounded, whitespace-normalized preview of the latest non-empty assistant text alongside accumulated tool activity.
- Do not persist every event.
- Silence and elapsed time do not themselves mean failure; only an explicitly enabled overall deadline limits run duration.
- Do not add package-imposed "fast-tool" deadlines. Command-supplied timeouts belong to tool execution and recovery, not delegation failure classification.
- Avoid rendering a fleet, transcript browser, or attention state machine.

## Success contract

A run succeeds when:

- a valid terminal assistant text response was observed;
- the child did not report an assistant error or abort;
- the run was not cancelled and did not hit an explicitly enabled overall deadline; and
- no protocol violation makes the terminal response untrustworthy.

A validated terminal answer remains a success if the runner subsequently has to terminate a child that failed to exit or drain. The result details should disclose forced cleanup. Earlier recoverable tool errors do not disqualify an otherwise valid final answer; success denotes completed delegation, not proof that every command or the requested task succeeded.

## Failure contract

Failures must distinguish at least:

- unknown agent or invalid input
- invalid cwd
- unsupported platform
- spawn failure
- parent cancellation
- expiration of an explicitly enabled overall deadline
- inability to safely clean up an interrupted command
- child exit before a terminal answer
- child/model error
- malformed or oversized protocol output that prevents trustworthy completion

Return bounded stderr and protocol diagnostics. Never disguise cancellation, an overall deadline expiry, or unsafe cleanup as ordinary successful completion. A command timeout must instead be visible to the delegate as a tool error, with continuation allowed after cleanup. This does not authorize silently stopping unrelated commands or earlier background services; command-local cleanup targets only the timed-out job's group; earlier background groups remain until whole-session cleanup.

## Output limits

Initial limits:

- task: 32 KiB UTF-8
- model selector: 256 bytes UTF-8
- pending JSONL line: 1 MiB
- returned final text: 50 KiB
- stderr tail: 64 KiB
- progress text: compact summary only

If final text is truncated, say so explicitly and report original byte size in result details. V1 does not write a full output artifact.

## Non-goals

V1 intentionally excludes:

- persistent or background execution
- workflow composition, branching, package-orchestrated whole-run retries, and chains (the delegate may retry its own commands)
- retained conversations, resume, and fork
- child-to-parent questions
- nested subagents
- agent creation or management UI
- untrusted project-controlled agent definitions
- automatic worktrees
- external CLI/job providers
- acceptance policy, mutation proofs, and host gates
- durable artifact stores or lifecycle reconciliation
- Windows process-tree support

## Acceptance criteria

1. The extension installs as a Pi package and registers `delegate`.
2. With no configuration, all five bundled profiles retain their roles and tool access, without mandatory run deadlines. User configuration can add, replace, or disable complete profiles; valid model overrides affect only the selected call, and the tool schema exposes no thinking or deadline override.
3. Children run with no sessions, ambient extension discovery, or skill discovery. A package-private Bash lifecycle extension is explicitly loaded for Bash-enabled profiles.
4. A clean child result is streamed and returned.
5. Parent abort scans and terminates live groups in the owned POSIX session within bounded cleanup windows.
6. A supplied Bash timeout cleans up and verifies the affected job PGID and returns a recoverable Pi tool error; the same delegate can run another command and produce a valid final answer. Earlier background job groups are not terminated by command-local cleanup. Ordinary nonzero command exits are recoverable; unsafe cleanup is `cleanup_failed`, while parent abort remains terminal.
7. After child exit or semantic completion, a descendant holding stdout/stderr open cannot keep the delegate tool pending indefinitely; whole-session cleanup scans same-session groups, including earlier background jobs.
8. A valid terminal answer survives forced post-settle cleanup.
9. Buffers and returned output obey the documented limits.
10. Parallel delegate calls do not share mutable run state.
11. Unit/integration tests cover the lifecycle matrix in `docs/IMPLEMENTATION.md`.
12. Typecheck and tests pass with documented commands.
13. An explicitly configured overall deadline terminates the delegate and its owned same-session groups and returns a run timeout; command recovery cannot extend it. Without opt-in, no overall run timer is armed. `ps sess` identity must be distinct and unmasked or launch fails early; deliberate session escape is excluded.
