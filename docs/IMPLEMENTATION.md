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
| Background schema | Opt-in closed schema; foreground unchanged; invalid action/field combinations rejected before execution |
| Background ownership | Immediate start; monotonic session-local IDs; 32-entry cap includes settled runs; collect once; duplicate waits rejected; cancelled waits retryable |
| Background presentation | Start calls reuse foreground profile/task formatting (abbreviated collapsed/full expanded); static headings settle without answers; tasks are not duplicated in results; no human collection instructions, run badges, or extra usage/cleanup rows; historical starts cannot bind another call's reused run ID; wait calls identify the run and pending results exactly match foreground activity/elapsed formatting; collected results add only Completed/Failed; foreground unchanged |
| Background observers | Settlement and wait progress are separate and observational; cancellation leaves waits retryable and identifies the run, says waiting stopped without cancelling the delegate, and advises waiting again; settlement, collection, navigation, and shutdown release applicable subscriptions/timers; starts do not redraw on collection; parallel runs remain isolated |
| Background reporting and usage | Waiter owns failure reporting; otherwise visible non-turn-triggering diagnostics, with or without UI; usage charged once on collection |
| Session transitions | Bounded cleanup before navigation/shutdown; cancelled navigation reopens the registry; shutdown stays closed; cleanup failures reported |

Background coverage spans registry ownership and races (`test/background.test.mjs`), opt-in configuration (`test/config.test.mjs`), and tool integration with real child processes (`test/extension.test.mjs`).

Tests must preserve valid terminal answers through forced post-completion cleanup while reporting cleanup status honestly. An active run without an opted-in deadline is not a hang by itself.

## Live checks

Use the [smoke-test guide](SMOKE_TEST.md) with an authenticated Pi installation and disposable fixtures. Check scout, reviewer, tester, worker, parallel calls, Bash timeout recovery, background-process cleanup, and interactive cancellation. Verify descendants are gone, not merely that the direct child exited. For background mode, check static starts/live waits, collection, wait cancellation/retry, failure notifications, and navigation/shutdown cleanup.

Keep live-provider and native-platform checks separate from the deterministic suite. Record the tested version, environment, commands, exit codes, observations, and unverified behavior in [verification results](RELEASE_CHECK.md). Publication is not verification.

## Change checklist

- Typecheck and tests pass; package contents are correct for release.
- Lifecycle changes have tests covering cleanup, drainage, and races.
- Waits and output remain bounded; useful work is not given mandatory deadlines.
- Public behavior matches the [product contract](REQUIREMENTS.md) and [architecture](DESIGN.md).
- The final diff adds no orchestration or persistence outside the documented scope.
