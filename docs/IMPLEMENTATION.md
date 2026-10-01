# Implementation and verification plan

## Delivery strategy

Implement one small vertical path first, then harden it. Do not build all profile or rendering conveniences before lifecycle tests pass.

**Implementation status:** Optional deadlines, Bash timeout recovery, and same-session cleanup are implemented locally, not yet released on npm. The stages below record delivery and verification criteria, not a pending redesign. Native macOS session-key behavior and live-provider calls remain unverified. Bundled profiles use `timeoutMs: null`; configuration omits `deadlineMs` or sets it to `null` for no run timer, preserving explicit positive values through 2,147,483,647 ms. There is no caller deadline input.

## Lifecycle implementation

- The detached `/bin/sh` gate waits for private authorization while the runner captures its distinct, unmasked opaque `ps sess` key; it then execs Pi. Unusable or masked keys fail early.
- Each Bash operation uses a non-detached privileged supervisor with monitor mode enabled to launch a normal Bash job (`+m`) with a separate PGID in the same session; a private fd 3 PGID handshake is bounded to 1 second.
- A timed-out job receives bounded TERM → KILL and verification for its PGID only, preserving earlier background job groups. A recoverable Pi tool error allows continuation. Failed containment uses reserved exit 86 (`cleanup_failed`); parent abort uses 87 (`cancelled`) and remains terminal. There is no delegate `tool_timeout` code.
- Normal completion, cancellation, and optional overall deadline scan and signal all live groups in the captured session with bounded `ps` output/calls and fixed TERM/KILL waits. Post-exit Bash drainage remains at most 100 ms. Session escape is excluded; command-local cleanup does not cover deliberate regrouping inside a command.

## Stage 1: package and clean scout path

Deliver:

- npm package metadata for `pi-delegator`
- Pi package extension registration
- strict TypeScript configuration
- one `delegate` tool
- the `scout` profile
- fresh foreground Pi child invocation
- bounded JSONL parsing
- parent abort propagation and bounded cleanup; optional user-controlled configured run deadline
- basic success/failure results
- tests using a fake Pi executable

Acceptance:

- Pi can load the extension.
- A fake clean child returns a terminal answer.
- Parent cancellation or an explicitly configured run deadline terminates a hanging child with bounded cleanup; no run timer is armed by default.
- Typecheck and tests pass.

## Stage 2: deterministic process cleanup

Deliver:

- detached launch gate with a captured POSIX session key and bounded whole-session group cleanup
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
- fixed role prompts/tool allowlists/default thinking; bundled `timeoutMs: null`
- compact `onUpdate` progress
- optional caller model override; thinking remains profile-controlled; no caller deadline input
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
- complete definitions for description, model, thinking, prompt, tools, and explicit local capability arrays; optional `deadlineMs` (`null` or omission disables; positive existing values retained)
- model precedence: call override → effective profile → inherited parent model
- strict validation with source/profile/corrective startup diagnostics
- trusted project-level configuration with project → user → bundled precedence
- session-scoped resolution that ignores untrusted projects and delegate-call working directories
- tests proving loaded registries and independent calls/sessions remain immutable

Acceptance:

- With no config file, bundled roles and tool access are preserved, with no default run timer.
- Complete user profiles add, replace, and disable names reflected in the tool schema.
- Per-call model fields override only one invocation; thinking cannot be overridden per call. Optional `deadlineMs` preserves explicit positive user values and accepts omission or `null` to disable the timer.
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

- no run-deadline timer is armed by default (`timeoutMs: null` bundled)
- explicit positive configured `deadlineMs` settles the run and cleans up the session with bounded waits; omission or `null` disables it
- existing explicit user values remain active through 2,147,483,647 ms
- already-aborted parent signal prevents launch
- parent abort during model activity terminates the group
- parent abort during a tool terminates the group
- opted-in deadline racing normal completion resolves exactly once
- abort racing an opted-in deadline resolves exactly once
- command recovery does not reset or extend an opted-in run deadline
- cancellation without a configured run deadline still settles with bounded same-session cleanup
- cleanup/drain timers and listeners do not keep the test process alive

### Process tree and drainage

- normal child exits and pipes close
- child exits while descendant holds stdout open
- child emits valid terminal answer but leaks an active timer/watcher
- child ignores TERM and receives KILL
- child spawns a TERM-resistant descendant
- pipe-drain guard finalizes without waiting indefinitely
- forced cleanup metadata is accurate
- delegate-owned same-session groups are cleaned up after normal completion, opted-in run timeout, and parent cancellation, with bounded waits and honest diagnostics if verification fails
- Bash command failure/timeout reports bounded diagnostics and permits the same delegate to retry/adapt only after cleanup is verified; a surviving command or unverified cleanup is an explicit cleanup failure, not an ordinary recoverable timeout
- tests cover command-local job PGID isolation from earlier background groups and whole-session cleanup of those groups
- parent cancellation during a subcommand remains terminal for the delegate
- private Bash registration wins over conflicting configured extensions through Pi's actual loader
- Bash output drainage is bounded and no callbacks occur after settlement

### Subcommand recovery

- failed and timed-out subcommands can be observed and retried/adapted within the same delegate, without package-orchestrated whole-run retries
- command-local cleanup is bounded and verified before a recoverable result is returned
- cleanup failure is distinguished from command timeout/failure and cannot be hidden by a terminal candidate
- private fd 3 handshake is bounded to 1 second; unsafe containment exits 86 as `cleanup_failed`, while abort exits 87 as `cancelled`; deliberate regrouping within a command is outside PGID-local cleanup

### Profiles and concurrency

- each bundled or configured profile emits its expected model/thinking/tools/prompt arguments
- effective names and descriptions appear in the tool schema after add/replace/disable resolution
- optional display names are trimmed, nonblank, and bounded to 256 UTF-8 bytes; calls, progress, final headers, and runner diagnostics use them while schema/result identifiers stay unchanged
- stored details preserve optional display names; labels without them title-case hyphen-separated identifiers, independent of registry lookup
- call model overrides replace profile defaults for only that call, including concurrent calls; thinking overrides are absent from the tool schema; no caller deadline input exists
- invalid or oversized model overrides are rejected
- omitted/null configured deadline, explicit prior positive values, and Node timer maximum are tested
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

## Definition of done

- Verify the acceptance criteria in `docs/REQUIREMENTS.md`; the local implementation is not an npm release.
- Lifecycle matrix is automated except explicitly marked manual real-Pi and native macOS checks.
- Cleanup/drain waits, stream buffers, and returned output are bounded; active work without an opted-in run deadline is permitted.
- No V1 non-goal has entered the public API.
- Source remains small enough for a reviewer to trace one run end-to-end.
- README accurately states supported platforms and limitations.
