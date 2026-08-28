# Product requirements

## Problem

Delegating a focused task to a fresh agent is useful, but existing subagent systems often combine that primitive with workflows, durable async state, scheduling, recovery, inter-agent communication, and rich fleet UI. The larger lifecycle surface has produced recurring hangs, misleading status, incomplete cancellation, and agent-type-specific surprises.

We need a delegation primitive whose behavior is easy to understand and whose worst-case runtime is bounded.

## Goal

Provide a Pi extension that lets the parent agent invoke one named delegate in a fresh Pi subprocess, observe compact progress, and receive a trustworthy final result or a precise bounded failure.

## Users

The primary user is a Pi coding agent orchestrating local software work. A human observes the tool call but should not need to operate a separate fleet UI or recover durable run state.

## V1 user stories

1. As a parent agent, I can ask a scout to inspect a codebase without filling my context with discovery work.
2. As a parent agent, I can ask a reviewer or oracle for a fresh-context opinion.
3. As a parent agent, I can hand one bounded implementation task to a worker.
4. As a parent agent, I can launch several independent delegates through Pi's ordinary parallel tool calls.
5. As a user, I can cancel the parent tool call and know the delegated process tree will be terminated.
6. As a user, I receive a bounded timeout rather than an indefinitely running child.
7. As a user, I receive the child's valid final answer even if an extension, watcher, or inherited subprocess prevents the child event loop or pipes from draining normally.

## Public interface

Register exactly one model-facing tool named `delegate`.

```ts
interface DelegateInput {
  agent: "scout" | "reviewer" | "oracle" | "worker";
  task: string;
  model?: string;
  cwd?: string;
}
```

Rules:

- Exactly one child per call.
- `task` must be non-empty and bounded in size.
- `cwd` defaults to the parent context's cwd and must resolve to an existing directory.
- `model`, when supplied, is a bounded Pi model selector passed to the child; otherwise the selected profile's user-configured model is used when present, then the parent model.
- Thinking is not exposed to the calling agent. The selected profile uses the user's configured thinking level when present, otherwise its built-in default; Pi may clamp it to the selected model's capabilities.
- The selected profile's deadline is fixed and is not exposed to the calling agent.
- Unknown fields and agent names are rejected by the schema.
- V1 has no generic prompt or tool override fields. Profiles continue to own role authority and tool access.

## Built-in delegates

### Scout

- Purpose: fast local codebase reconnaissance
- Default thinking: `low`
- Tools: `read`, `grep`, `find`, `ls`
- Default deadline: 180 seconds
- No `bash`, write tools, skills, or extensions

### Reviewer

- Purpose: fresh-context correctness and maintainability review
- Default thinking: `high`
- Tools: `read`, `grep`, `find`, `ls`, `bash`
- Default deadline: 600 seconds
- Prompt instructs it not to modify files

### Oracle

- Purpose: challenge assumptions and advise on material decisions
- Default thinking: `high`
- Tools: `read`, `grep`, `find`, `ls`
- Default deadline: 600 seconds
- Prompt instructs it to advise, not implement

### Worker

- Purpose: implement one clearly bounded task
- Default thinking: `high`
- Tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`
- Default deadline: 1,200 seconds
- Prompt requires a concise change and validation report

Models are omitted from built-in profile defaults, so the child uses the caller's model, then a user-configured profile model, then the parent model. Profile thinking levels may be overridden only through user-level configuration, not by the calling agent. Role prompts, tool allowlists, and deadlines remain fixed; callers cannot guess a shorter deadline that discards useful delegate work.

## Progress behavior

Progress is observational, never lifecycle authority.

- Stream a compact update when the child starts a tool or completes an assistant message.
- Do not persist every event.
- Silence does not itself mean failure; hard deadlines decide failure.
- Tool-level deadlines may be added only for known-fast tools and must never extend the run deadline.
- Avoid rendering a fleet, transcript browser, or attention state machine.

## Success contract

A run succeeds when:

- a valid terminal assistant text response was observed;
- the child did not report an assistant error or abort;
- the run did not hit its wall-clock or fast-tool deadline; and
- no protocol violation makes the terminal response untrustworthy.

A validated terminal answer remains a success if the runner subsequently has to terminate a child that failed to exit or drain. The result details should disclose forced cleanup.

## Failure contract

Failures must distinguish at least:

- unknown agent or invalid input
- invalid cwd
- unsupported platform
- spawn failure
- parent cancellation
- wall-clock timeout
- fast-tool timeout
- child exit before a terminal answer
- child/model error
- malformed or oversized protocol output that prevents trustworthy completion

Return bounded stderr and protocol diagnostics. Never report a timeout as an ordinary model answer.

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
- workflow composition, branching, retries, and chains
- retained conversations, resume, and fork
- child-to-parent questions
- nested subagents
- agent creation or management UI
- project-controlled agent definitions
- automatic worktrees
- external CLI/job providers
- acceptance policy, mutation proofs, and host gates
- durable artifact stores or lifecycle reconciliation
- Windows process-tree support

## Acceptance criteria

1. The extension installs as a Pi package and registers `delegate`.
2. All four profiles launch with their documented prompt, tools, effective configured or built-in thinking, and deadlines; valid model overrides affect only the selected call, and the tool schema exposes no thinking or deadline override.
3. Children run with no sessions, extension discovery, or skill discovery.
4. A clean child result is streamed and returned.
5. Parent abort terminates the full POSIX process group within a bounded grace period.
6. Wall-clock timeout terminates the full process group and returns a timeout failure.
7. A descendant holding stdout/stderr open cannot keep the delegate tool pending indefinitely.
8. A valid terminal answer survives forced post-settle cleanup.
9. Buffers and returned output obey the documented limits.
10. Parallel delegate calls do not share mutable run state.
11. Unit/integration tests cover the lifecycle matrix in `docs/IMPLEMENTATION.md`.
12. Typecheck and tests pass with documented commands.
