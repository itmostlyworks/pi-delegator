# Verification results

## Recorded checks: 0.6.6 (2026-10-03)

Environment: macOS 27.2, arm64; Node 26.5.0, npm 11.17.0, Pi 1.0.0, Python 3.10.2. A local checkout was loaded explicitly with user-configured profiles and no project override. These results are recorded evidence, not a claim that every subsequent checkout has been live-tested.

| Check | Recorded outcome |
| --- | --- |
| Typecheck | `npm run typecheck` — exit 0 |
| Automated tests | `npm test` — exit 0; 122 passed |
| Packaging | `npm pack --dry-run` — exit 0 |
| Scout | Correctly identified the purposes of `src/index.ts` and `src/runner.ts` |
| Bash timeout recovery | A command timed out after 2 seconds; the same delegate ran a subsequent command and finished |
| Background cleanup | Worker finished after launching a background job; delegate and descendant were absent afterward |
| Interactive cancellation | Escape returned `cancelled`; delegate and descendant disappeared with no session survivors |

The live scout and worker checks used `openai-codex/gpt-6-astra`. Their profiles had explicit 180-second and 1,200-second deadlines; a worker harness also used a 120-second guard. Descendants shared the delegate's POSIX session with distinct process groups. Post-run process queries found no survivors; no manual kills were needed.

Linux was not rerun in this recorded verification. Deliberate session escape and abrupt parent death are outside the containment guarantee.

## Async presentation refinements (current branch)

Automated checks on Linux, without provider calls:

- `npm run typecheck` — exit 0.
- `npm test` — exit 0; 169 passed.
- `git diff --check` — exit 0.

Coverage includes foreground-style async call/result formatting and raw newline spacing (including the wait call/result gap), task previews/full expanded tasks retained in start calls, no human-card retrieval instructions or extra usage/cleanup sections, historical identity protection, and retryable wait cancellation wording. Live Pi TUI wrapping, scroll stability, and visual emphasis remain unverified.

## Active delegate footer (current branch)

Automated checks on Linux, without provider calls:

- `npm run typecheck` — exit 0.
- `npm test` — exit 0; 181 passed.
- `git diff --check` — exit 0.

Coverage includes grouped parallel foreground/background counts, listing every active profile without an overflow counter, wait cancellation without double-counting, settlement and failure cleanup, navigation/shutdown cleanup and cancelled-navigation reuse, stale-session isolation, terminal-safe labels, the built-in footer's `dim` theme color, non-TUI modes, and throwing UI observers. Live Pi footer rendering remains unverified.

## Reproduce

Use the [smoke-test guide](SMOKE_TEST.md). Automated checks and coverage expectations are in the [testing guide](IMPLEMENTATION.md).
