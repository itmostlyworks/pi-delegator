# Verification results

**2026-10-03: all requested macOS checks passed with the local session-ID fix.**

Tested the macOS fix on top of 0.6.5, based on checkout `f8208e1e8ebfe9c3f25ad88ab65c3bb10df74c7c`. The fix is included in 0.6.6. Release packaging checks were repeated after the version bump.

## Environment

- macOS 27.2 (26B5091g), arm64; Node v26.5.0, npm 11.17.0, Pi 1.0.0, Python 3.10.2.
- Local checkout loaded explicitly; no auth changes, publishing, or commits.
- Effective profiles came from `~/.pi/agent-personal/pi-delegator.json`; no project override. Scout: low thinking, 180-second deadline; worker: medium thinking, 1,200-second deadline. No explicit skills/extensions.
- Fresh-process scout and worker checks overrode the model to `openai-codex/gpt-6-astra`; the worker harness used a 120-second guard.

## Results

| Check | Evidence | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` — exit 0 | Pass |
| Automated tests | `npm test` — exit 0; 122 passed | Pass |
| Packaging | `npm pack --dry-run` — exit 0 | Pass |
| Scout | Asked for the purposes of `src/index.ts` and `src/runner.ts`; accurate answer in 19.1 s, harness exit 0 | Pass |
| Bash timeout recovery | Marked Node command with tool timeout of 2 seconds; same delegate then printed `RECOVERED_AFTER_TIMEOUT` and finished | Pass |
| Background cleanup | Worker launched a marked background job, then finished without killing it; harness exit 0 | Pass |
| Interactive cancellation | User pressed Escape after both PIDs were observed; tool returned `cancelled`, processes disappeared | Pass |
| Documentation | `git diff --check` — exit 0 | Pass |

## Process evidence

macOS masks `ps sess` as `0`. The fix queries real POSIX session IDs with Python's `os.getsid()` and refreshes process groups with `os.getpgid()`.

| Scenario | Delegate PID / SID | Descendant PID / PGID | After completion or cancellation |
| --- | --- | --- | --- |
| Timeout recovery | 23471 | 23720 / 23720 | Both absent |
| Background job | 23471 | 24108 / 24107 | Both absent |
| Escape cancellation | 53862 | 54168 / 54168 | Both absent; session had no survivors |

Each descendant shared its delegate's POSIX SID while using a distinct PGID. Post-run `ps -p <descendant>,<delegate>` returned no rows and exit 1. No manual process kills were needed for these live checks.

The Escape test ran a marked Node interval with a 180-second safety exit. The tool reported `Parent cancelled the delegate` after 25,601 ms total run time, before that safety exit; this was real Pi tool cancellation, not a signal to the parent.

## Reproduce and history

Use the [smoke-test guide](SMOKE_TEST.md). Exact prompts, commands, original failure diagnosis, profile details, and older 0.5.x results are preserved in the [detailed record](history/2026-10-03-verification.md).

Linux's earlier 114-test pass was supplied in the handoff; Linux was not rerun after this macOS-only lookup change. Deliberate session escape and abrupt parent death remain outside containment scope.
