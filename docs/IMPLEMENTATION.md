# Implementation and verification plan

## Delivery strategy

Implement one small vertical path first, then harden it. Do not build all profile or rendering conveniences before lifecycle tests pass.

## Stage 1: package and clean scout path

Deliver:

- npm package metadata for `pi-delegator`
- Pi package extension registration
- strict TypeScript configuration
- one `delegate` tool
- the `scout` profile
- fresh foreground Pi child invocation
- bounded JSONL parsing
- a mandatory wall-clock deadline
- parent abort propagation
- basic success/failure results
- tests using a fake Pi executable

Acceptance:

- Pi can load the extension.
- A fake clean child returns a terminal answer.
- A hanging child is terminated and the tool settles within its deadline plus cleanup grace.
- Typecheck and tests pass.

## Stage 2: deterministic process cleanup

Deliver:

- dedicated POSIX process group
- TERM → KILL escalation
- post-exit stdio guard
- semantic-completion drain guard
- idempotent finalization
- bounded stderr and output

Acceptance:

- A child that spawns a descendant holding stdout open cannot hang the tool.
- A TERM-resistant child is escalated to KILL.
- A valid terminal answer remains successful when forced cleanup is required.
- Cancellation and timeout never produce duplicate completion.

## Stage 3: remaining profiles and progress

Deliver:

- reviewer, oracle, and worker profiles
- fixed role prompts/tool allowlists/thinking/deadlines
- compact `onUpdate` progress
- optional caller timeout that can only shorten the profile deadline
- usage aggregation from assistant events

Acceptance:

- Each profile launches with the expected CLI contract.
- Reviewer/oracle cannot mutate through built-in tools.
- Worker receives mutation tools.
- Parallel calls keep outputs and lifecycle state isolated.

## Stage 4: package polish

Deliver:

- installation and usage README
- changelog entry for v0.1.0
- license
- manual real-Pi smoke test instructions
- final diff review against non-goals

Do not add background execution during polish.

## Test architecture

Set an environment variable such as `PI_DELEGATOR_PI_BINARY` to a fixture executable. The fixture accepts Pi-like arguments, records them when requested, emits controlled JSONL, and can create lifecycle failure modes without provider calls.

Prefer small fixture scripts over mocks of `node:child_process`; real processes are required to test pipes, groups, signals, and descendants.

## Required lifecycle matrix

### Launch and validation

- known profile launches successfully
- unknown profile rejected by schema/runtime
- missing/blank/oversized task rejected
- default cwd used
- nonexistent or non-directory cwd rejected
- unsupported platform helper fails closed
- spawn error returns bounded diagnostic
- CLI invocation uses `shell: false` and required isolation flags

### Protocol

- parses chunk split across several writes
- parses several events in one chunk
- ignores unknown JSON event types
- bounds or rejects a pending oversized line
- handles malformed JSON before a later valid result according to documented policy
- captures assistant error and stop reason
- captures a terminal text answer
- rejects exit with no terminal answer
- truncates final text at 50 KiB with explicit metadata
- retains only a 64 KiB stderr tail

### Deadline and cancellation

- wall-clock deadline settles the run
- already-aborted parent signal prevents launch
- parent abort during model activity terminates the group
- parent abort during a tool terminates the group
- deadline racing normal completion resolves exactly once
- abort racing deadline resolves exactly once
- timers and listeners do not keep the test process alive

### Process tree and drainage

- normal child exits and pipes close
- child exits while descendant holds stdout open
- child emits valid terminal answer but leaks an active timer/watcher
- child ignores TERM and receives KILL
- child spawns a TERM-resistant descendant
- pipe-drain guard finalizes without waiting indefinitely
- forced cleanup metadata is accurate

### Tool timeout

If implemented in V1:

- known-fast tool arms timeout
- matching tool end clears timeout
- concurrent tool IDs do not clear each other's timers
- `bash` does not receive the known-fast deadline
- tool timeout cannot extend the run deadline

### Profiles and concurrency

- each profile emits expected model/thinking/tools arguments
- call timeout shortens profile deadline
- call timeout cannot lengthen profile deadline
- two concurrent delegate calls return their own output
- one concurrent timeout does not stop its sibling

## Manual smoke tests

After automated tests, run against a real authenticated Pi installation:

1. Scout asks for two known files and returns quickly.
2. Reviewer inspects a small diff and does not modify files.
3. Worker edits a disposable fixture repository and reports validation.
4. Two scouts launch as sibling tool calls.
5. Cancel an active delegate and verify no child process remains.
6. Use a fixture task that starts a background process holding pipes and verify bounded cleanup.

Record exact commands and observed outcomes in the implementation report. Do not make live-provider smoke tests part of the deterministic unit suite.

## Expected commands

The implementation agent should establish and document commands equivalent to:

```bash
npm install
npm run typecheck
npm test
```

Add formatting or linting only if configured intentionally; do not spend the first slice installing a large toolchain.

## Definition of done for v0.1.0

- All requirements acceptance criteria pass.
- Lifecycle matrix is automated except explicitly marked manual real-Pi checks.
- No unbounded timer, process wait, stream buffer, or returned output is known.
- No V1 non-goal has entered the public API.
- Source remains small enough for a reviewer to trace one run end-to-end.
- README accurately states supported platforms and limitations.
