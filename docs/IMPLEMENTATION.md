# Implementation and verification plan

## Delivery strategy

Implement one small vertical path first, then harden it. Do not build all profile or rendering conveniences before lifecycle tests pass.

**Target contract, not current behavior:** The shipped runner still enforces fixed profile deadlines and fails the entire child on Bash timeout/abort. The original delivery stages below have been aligned with the approved target, as has the lifecycle matrix; they are not evidence of passing runtime behavior today. `README.md` documents current behavior separately; `docs/REQUIREMENTS.md` defines the target contract. This documentation-only update does not settle the deadline API, migration, or command cleanup architecture.

## Transition work (not implemented)

Before changing runtime behavior:

- Design the user opt-in deadline interface and migration of existing explicit `deadlineMs` values, without carrying bundled mandatory limits into the new default.
- Design command ownership and bounded cleanup that allow timeout recovery without weakening parent cancellation or assuming collateral shutdown of earlier commands is acceptable.
- Replace fatal command-timeout handling with a recoverable tool error after safe cleanup; keep cleanup failure distinct.
- Update profile/configuration handling, role prompts, lifecycle tests, and current-behavior documentation together. Existing tests that assert fatal Bash timeouts verify the old contract, not the target.

## Stage 1: package and clean scout path

Deliver:

- npm package metadata for `pi-delegator`
- Pi package extension registration
- strict TypeScript configuration
- one `delegate` tool
- the `scout` profile
- fresh foreground Pi child invocation
- bounded JSONL parsing
- parent abort propagation and bounded cleanup; optional user-controlled run deadline in the target contract (interface pending)
- basic success/failure results
- tests using a fake Pi executable

Acceptance:

- Pi can load the extension.
- A fake clean child returns a terminal answer.
- Parent cancellation or an explicitly configured run deadline terminates a hanging child with bounded cleanup; no run timer is armed by default in the target contract.
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

- After child exit or semantic completion, a descendant holding stdout open cannot hang the tool.
- A TERM-resistant child is escalated to KILL.
- A valid terminal answer remains successful when forced cleanup is required.
- Cancellation and an opted-in run timeout never produce duplicate completion.

## Stage 3: remaining profiles and progress

Deliver:

- reviewer, oracle, tester, and worker profiles
- fixed role prompts/tool allowlists/default thinking; optional user-controlled deadline policy pending design
- compact `onUpdate` progress
- optional caller model override; thinking remains profile-controlled; deadline interface pending design
- usage aggregation from assistant events

Acceptance:

- Each profile launches with the expected default CLI contract.
- Valid model overrides affect only the selected call; thinking cannot be supplied by the caller.
- Reviewer/oracle cannot mutate through built-in tools.
- Tester receives bash for bounded behavioral verification but no edit/write tools.
- Worker receives mutation tools.
- Parallel calls keep outputs and lifecycle state isolated.

## Stage 4: user-level effective profiles

Deliver:

- optional bounded user-level configuration at the Pi agent directory
- a `profiles` map whose entries add or completely replace profiles, or disable names with `null`
- complete definitions for description, model, thinking, prompt, tools, and explicit local capability arrays; optional deadline representation and migration pending design
- model precedence: call override → effective profile → inherited parent model
- strict validation with source/profile/corrective startup diagnostics
- trusted project-level configuration with project → user → bundled precedence
- session-scoped resolution that ignores untrusted projects and delegate-call working directories
- tests proving loaded registries and independent calls/sessions remain immutable

Acceptance:

- With no config file, bundled roles and tool access are preserved, with no default run timer.
- Complete user profiles add, replace, and disable names reflected in the tool schema.
- Per-call model fields override only one invocation; thinking cannot be overridden per call. Deadline opt-in interface and treatment of existing explicit user `deadlineMs` values require migration review; do not discard existing safeguards silently.
- Legacy, incomplete, malformed, and unsafe configuration fails before delegation.
- Trusted project configuration can add, replace, and disable profiles; untrusted project configuration is ignored.
- Delegate-call working directories cannot select profile configuration, and different project sessions retain independent registries.

Keep each effective registry immutable after session startup. Validate and canonicalize explicit local skill/extension paths before launch while retaining ambient discovery isolation. Generic per-call overrides and dynamic in-session reload remain separate work.

## Stage 5: package polish

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

### Optional deadline and cancellation

- no run-deadline timer is armed by default in the target contract
- explicit user opt-in run deadline settles the run and terminates the group with bounded cleanup
- existing explicit user deadline values are covered by migration tests once representation is decided
- already-aborted parent signal prevents launch
- parent abort during model activity terminates the group
- parent abort during a tool terminates the group
- opted-in deadline racing normal completion resolves exactly once
- abort racing an opted-in deadline resolves exactly once
- command recovery does not reset or extend an opted-in run deadline
- cancellation without a configured run deadline still settles with bounded cleanup
- cleanup/drain timers and listeners do not keep the test process alive

### Process tree and drainage

- normal child exits and pipes close
- child exits while descendant holds stdout open
- child emits valid terminal answer but leaks an active timer/watcher
- child ignores TERM and receives KILL
- child spawns a TERM-resistant descendant
- pipe-drain guard finalizes without waiting indefinitely
- forced cleanup metadata is accurate
- delegate-owned process tree is cleaned up after normal completion, opted-in run timeout, and parent cancellation, with bounded waits and honest diagnostics if verification fails
- Bash command failure/timeout reports bounded diagnostics and permits the same delegate to retry/adapt only after cleanup is verified; a surviving command or unverified cleanup is an explicit cleanup failure, not an ordinary recoverable timeout
- tests cover command isolation from unrelated earlier background commands once ownership topology is decided; do not assume collateral shutdown is acceptable
- parent cancellation during a subcommand remains terminal for the delegate
- private Bash registration wins over conflicting configured extensions through Pi's actual loader
- Bash output drainage is bounded and no callbacks occur after settlement

### Subcommand recovery

- failed and timed-out subcommands can be observed and retried/adapted within the same delegate, without package-orchestrated whole-run retries
- command-local cleanup is bounded and verified before a recoverable result is returned
- cleanup failure is distinguished from command timeout/failure and cannot be hidden by a terminal candidate
- command ownership/recovery cleanup topology and command-local abort semantics are pending design; tests must cover the chosen isolation behavior without assuming earlier background commands may be killed

### Profiles and concurrency

- each bundled or configured profile emits its expected model/thinking/tools/prompt arguments
- effective names and descriptions appear in the tool schema after add/replace/disable resolution
- call model overrides replace profile defaults for only that call, including concurrent calls; thinking overrides are absent from the tool schema; deadline opt-in surface is pending design
- invalid or oversized model overrides are rejected
- deadline opt-in interface and explicit configured-value migration are tested after design is settled
- two concurrent delegate calls return their own output
- one concurrent opted-in run timeout does not stop its sibling

## Manual smoke tests

After automated tests, run against a real authenticated Pi installation:

1. Scout asks for two known files and returns quickly.
2. Reviewer inspects a small diff and does not modify files.
3. Tester exercises a disposable fixture's real CLI behavior without editing source or configuration.
4. Worker edits a disposable fixture repository and reports validation.
5. Two scouts launch as sibling tool calls.
6. Cancel an active delegate and verify no child process remains.
7. Use a fixture task that starts a background process holding pipes and verify bounded cleanup.

Record exact commands and observed outcomes in the implementation report. Do not make live-provider smoke tests part of the deterministic unit suite.

## Expected commands

The implementation agent should establish and document commands equivalent to:

```bash
npm install
npm run typecheck
npm test
```

Add formatting or linting only if configured intentionally; do not spend the first slice installing a large toolchain.

## Definition of done for the target contract

- Before claiming the target contract is implemented, verify the updated acceptance criteria in `docs/REQUIREMENTS.md` and update `README.md` to describe the new runtime behavior.
- Target lifecycle matrix is automated except explicitly marked manual real-Pi checks.
- Cleanup/drain waits, stream buffers, and returned output are bounded; active work without an opted-in run deadline is permitted.
- No V1 non-goal has entered the public API.
- Source remains small enough for a reviewer to trace one run end-to-end.
- README accurately states supported platforms and limitations.
