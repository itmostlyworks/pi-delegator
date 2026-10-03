# Current architecture

`pi-delegator` exposes one foreground `delegate` tool. Each call owns one fresh
Pi subprocess, bounded protocol state, and an idempotent finalization path.
There is no manager process, persistence layer, or package-orchestrated run retry.
Recovery means the same child can adapt after a safely cleaned-up command failure.

See [requirements](REQUIREMENTS.md) for the public contract and
[profile configuration](REQUIREMENTS.md#user-profile-configuration) for configuration.
The [testing guide](IMPLEMENTATION.md) describes
fixtures and lifecycle coverage; observed results live in [RELEASE_CHECK.md](RELEASE_CHECK.md).

## Module map

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Session-scoped tool registration, input/cwd validation, runner invocation, progress/result rendering, error propagation, and usage accounting. |
| `src/agents.ts` | Immutable bundled profiles, packaged role prompts, normalized profile type, and human-facing labels. |
| `src/config.ts` | Bounded configuration loading, complete-profile validation, canonical capability paths, and immutable project → user → bundled resolution. |
| `src/runner.ts` | Child arguments, private prompt, launch gate, protocol/progress integration, deadlines, drainage, finalization, and result classification. |
| `src/process-tree.ts` | Session identity capture, bounded process queries, whole-session group cleanup, and command-local PGID cleanup. |
| `src/protocol.ts` | Incremental bounded JSONL parsing, terminal candidates, retry/continuation state, diagnostics, and usage. |
| `src/delegate-bash-extension.ts` | Private child Bash override with job isolation, handshake, timeout recovery, and bounded drainage. |
| `src/delegate-child-contract.ts` | Private child environment marker and reserved lifecycle exit codes. |
| `src/display.ts` | Terminal-safe compact previews and observational tool/activity summaries. |
| `src/bash-classification.ts` | Conservative Bash activity labels without rendering raw command arguments. |

## Launch and child contract

The runner resolves Pi, writes the appended role prompt to an OS temporary file
with mode `0600`, and spawns a detached `/bin/sh` gate in the requested cwd.
Launch uses argument arrays and `shell: false`; the gate execs Pi only after
private stdin authorization. Closing the gate during cancellation prevents exec.

Before authorization, the runner captures a usable session identity distinct
from the parent's: Linux uses `ps sess`; macOS uses Python 3 `os.getsid()` because
`ps sess` may be masked. macOS refreshes PGIDs with `os.getpgid()` between matching
SID reads, retrying at most three times; only ESRCH permits omitting a process.
Missing Python or unsafe identity fails launch rather than weakening containment.
Python runs with `-I -S`. Process queries cap output at 1 MiB and time at 500 ms
(Linux `ps`: 250 ms).

Pi runs with `--mode json --print --no-session --no-extensions --no-skills`,
explicit tools, model, thinking level, and `--append-system-prompt`.
Only validated explicit local skills/extensions are added. Bash-enabled profiles
load the private Bash extension first so its registration wins tool-name conflicts.
The environment is inherited with the private child marker overwritten;
stdout/stderr are piped. Parent sessions and ambient capabilities are not passed.
Pi's normal coding prompt and project instructions remain active.

## Private Bash lifecycle

Each operation starts a non-detached privileged Bash supervisor with monitor
mode enabled. Its command Bash uses `+m` in a separate PGID within the delegate
session. A private fd 3 handshake must supply a safe PGID within one second.
The shell is `/bin/bash` or `bash` on PATH, not Pi's custom `shellPath`.

A supplied timeout terminates and verifies only that job PGID using bounded
TERM → KILL windows, then returns a recoverable Pi tool error. Ordinary nonzero
command exits are also recoverable. Earlier background groups remain until
whole-session cleanup; command recovery never restarts the delegation.
Failed containment or cleanup exits the child with reserved code 86
(`cleanup_failed`); abort uses 87 (`cancelled`) and is terminal. These exits
supersede any terminal answer already observed.

Bash settles on pipe close or a fixed 100 ms post-exit drain, clears timers and
listeners, and destroys streams. Continuous output cannot extend this wait.
The registration marker is removed from command environments, not used as a
security boundary. There are no package-imposed fast-command deadlines.

## Protocol and completion

The parser retains completion/progress/usage state, not a transcript. It handles
split UTF-8 JSONL chunks and ignores unknown valid events. Malformed lines are
counted without automatically preventing a later valid answer. Pending lines
are capped at 1 MiB: safely classifiable nonterminal events can be discarded
through bounded drain-to-newline mode; oversized assistant or unclassifiable
output is a protocol error.

A finalized assistant text with terminal stop reason is an answer candidate;
`agent_settled` also supplies completion evidence. An assistant error alone
cannot trigger semantic completion because Pi may retry in-process. Later turns
invalidate stale candidates, and later successful assistant messages supersede
transient errors. Progress and silence never decide lifecycle outcomes.

## Finalization and cleanup

No overall timer is armed without an explicit profile deadline. When enabled,
it covers startup and useful work; command recovery does not reset it.
An already-aborted call does not launch. Parent cancellation and deadline expiry
are terminal, unlike recoverable command errors.

Spawn/protocol failures, process completion, semantic completion, cancellation,
and deadline expiry converge on one guarded finalizer. It stops accepting output,
clears timers and the abort listener, closes the gate, terminates the captured
session, destroys pipes, and removes the temporary prompt best-effort.
Every completion path scans all live same-session groups, including reparented
and earlier background jobs, with fixed TERM/KILL windows and honest verification.
Default cleanup windows are 2 seconds for TERM and 1 second for KILL verification.

The runner listens to both `exit` and `close`, never waiting exclusively on
`close`. Post-exit and semantic-completion drains default to 250 ms; pipe-close
verification after destruction is capped at 50 ms. A valid answer survives forced
cleanup only when no authoritative error or cleanup diagnostic invalidates it.
Results disclose forced cleanup, signals, process exit, and pipe closure.
Failures remain distinct and are thrown through Pi's tool-error semantics.

## Bounds, trust, and containment

Returned text is capped at 50 KiB with explicit truncation/original-size metadata;
stderr retains a 64 KiB tail. Each concurrent call owns its mutable run state and
private prompt; shared profiles are immutable. No run artifacts enter the repo.
Project profiles require parent-session trust; call cwd cannot select configuration.

Linux and macOS are supported; Windows fails before spawn. Whole-session cleanup
contains ordinary Bash jobs, not deliberate session escape. PGID-local cleanup
cannot contain deliberate command regrouping. Abrupt parent death has no cleanup
guarantee. Allowed tools have local system access: this is not a sandbox, and
no-edit role prompts are not enforced write protection.
