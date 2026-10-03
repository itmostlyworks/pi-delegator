# Testing

## Commands

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The automated suite uses `node:test` and a fake Pi executable selected through `PI_DELEGATOR_PI_BINARY`; it makes no provider calls. Real child processes exercise pipes, process groups, signals, and descendants rather than mocking `child_process`.

## Coverage to preserve

| Area | Required behavior |
| --- | --- |
| Registration and launch | Input/schema validation, cwd checks, model precedence, explicit isolation flags, unsupported platform and spawn diagnostics |
| Configuration | Add/replace/disable profiles, complete definitions, bounded input, trusted-project precedence, immutable session registries, validated local capabilities |
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

Tests must preserve valid terminal answers through forced post-completion cleanup while reporting cleanup status honestly. An active run without an opted-in deadline is not a hang by itself.

## Live checks

Use the [smoke-test guide](SMOKE_TEST.md) with an authenticated Pi installation and disposable fixtures. Check scout, reviewer, tester, worker, parallel calls, Bash timeout recovery, background-process cleanup, and interactive cancellation. Verify descendants are gone, not merely that the direct child exited.

Keep live-provider and native-platform checks separate from the deterministic suite. Record the tested version, environment, commands, exit codes, observations, and unverified behavior in [verification results](RELEASE_CHECK.md). Publication is not verification.

## Change checklist

- Typecheck and tests pass; package contents are correct for release.
- Lifecycle changes have tests covering cleanup, drainage, and races.
- Waits and output remain bounded; useful work is not given mandatory deadlines.
- Public behavior matches the [product contract](REQUIREMENTS.md) and [architecture](DESIGN.md).
- The final diff adds no orchestration or persistence outside the documented scope.
