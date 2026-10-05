# Testing

## Commands

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The automated suite uses `node:test` and a fake Pi executable selected through `PI_DELEGATOR_PI_BINARY`; it makes no provider calls. Real child processes exercise pipes, process groups, signals, and descendants rather than mocking `child_process`. Test files run serially to avoid competing process-heavy fixtures exhausting short lifecycle deadlines; tests still exercise concurrent delegations explicitly.

## Coverage to preserve

| Area | Required behavior |
| --- | --- |
| Registration and launch | Input/schema validation, cwd checks, model precedence, explicit isolation flags, unsupported platform and spawn diagnostics |
| Configuration | Add/replace/disable profiles, complete definitions, bounded input, trusted-project precedence, immutable session registries, validated local capabilities; background defaults false, boolean-only validation, background-only files, independent setting/profile inheritance |
| Profiles and display | Expected prompts/tools/thinking, optional display labels, stable identifiers, bounded progress, usage accounting |
| Protocol | Split/chunked JSONL, unknown events, malformed/oversized lines, bounded output and stderr, assistant retries, trustworthy terminal answers |
| Deadlines | No timer by default; configured timer covers the run, cannot be extended by recovery, and cleans up the session |
| Cancellation | Already-aborted calls do not spawn; abort during model/tool activity is terminal; races settle exactly once |
| Process cleanup | Distinct captured session, same-session groups removed on completion/cancel/deadline, TERM-resistant descendants escalated to KILL |
| Drainage | Child exit or semantic completion cannot hang on inherited pipes, watchers, or continuous background output |
| Bash recovery | Nonzero exits/timeouts allow continuation after verified command-local cleanup; earlier background groups survive until whole-session cleanup |
| Cleanup failure | Unsafe containment or unverifiable cleanup is explicit; reserved child exits cannot be hidden by a terminal candidate |
| Isolation | Private Bash registration wins over conflicting configured extensions; parallel calls share no mutable state |
| Finalization | Bounded waits, cleared timers/listeners, no late updates, private temporary prompts removed best-effort |
| Background schema | Disabled foreground schema unchanged; enabled closed root object; omitted/run foreground behavior; run/start/wait combinations validated before launch/collection |
| Background ownership | Immediate start, monotonic `run-N` IDs across completion/collection/cancelAll with fresh-registry reset, cap of 32 uncollected entries including completed runs, collection once, duplicate-wait rejection, cancelled waits retain session-owned work |
| Background display | Operation-only Start/Wait call rows; static start uses foreground-equivalent profile/`#N`/model/thinking Started heading and full terminal-safe original task in collapsed/expanded views with preserved whitespace/line breaks and blank-line separation, bounded saved preview only for missing arguments; no periodic activity, elapsed-time, or usage repaint; one settlement invalidation yields compact Completed/Failed summary, meaning delegation completion rather than task success, never an answer; wait alone owns collected answer/diagnostics; expanded-only collection/model/thinking/usage/cleanup as applicable; safe saved inactive history fallback and identity isolation; foreground unchanged, no dashboard |
| Settlement and pending wait | Separate bounded settlement observer and admitted-wait progress subscription; start invalidates once on settlement, never on activity or heartbeat; pending wait owns foreground-equivalent bounded compact/expanded activity and elapsed-time heartbeat through `onUpdate`, including silent-child ticks, without duplicate prompt; no wait means no live activity; parallel isolation and harmless throwing observers; wait cancellation releases subscription/timer without cancelling child, settlement/collection/navigation/shutdown release references, runner cleanup unchanged |
| Background reporting and usage | Active waiter owns failure; uncollected failures send one visible non-turn-triggering custom message with or without UI; usage charged once on wait, not start or uncollected outcomes |
| Session transitions | Pre-switch/fork/tree abort and clear owned runs after bounded runner cleanup; cancelled navigation leaves current session usable; shutdown is idempotent and permanent; cleanup failures reported while closing |

`test/background.test.mjs` covers ID sequencing/reset, registry bounds, collection and cancellation races, reporting, closure, and reopening after pre-navigation. `test/config.test.mjs` covers the opt-in setting and independent precedence. Background cases in `test/extension.test.mjs` exercise the schema, real delayed child completion, operation-only calls, bounded task previews, short badges and expanded-only collection instructions/metadata, saved-detail rendering after collection/navigation, usage, UI-independent notifications, wait cancellation, and TERM-resistant descendant cleanup across shutdown and pre-navigation events.

Tests must preserve valid terminal answers through forced post-completion cleanup while reporting cleanup status honestly. An active run without an opted-in deadline is not a hang by itself.

## Live checks

Use the [smoke-test guide](SMOKE_TEST.md) with an authenticated Pi installation and disposable fixtures. Check scout, reviewer, tester, worker, parallel calls, Bash timeout recovery, background-process cleanup, and interactive cancellation. Verify descendants are gone, not merely that the direct child exited. For opt-in background mode, also check start/wait collection, cancellation of a wait without child cancellation, visible failure diagnostics without a new model turn, and session navigation/shutdown cleanup. No persistence or resume is expected.

Keep live-provider and native-platform checks separate from the deterministic suite. Record the tested version, environment, commands, exit codes, observations, and unverified behavior in [verification results](RELEASE_CHECK.md). Publication is not verification.

## Change checklist

- Typecheck and tests pass; package contents are correct for release.
- Lifecycle changes have tests covering cleanup, drainage, and races.
- Waits and output remain bounded; useful work is not given mandatory deadlines.
- Public behavior matches the [product contract](REQUIREMENTS.md) and [architecture](DESIGN.md).
- The final diff adds no orchestration or persistence outside the documented scope.
