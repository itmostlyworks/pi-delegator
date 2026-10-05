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

## Reproduce

Use the [smoke-test guide](SMOKE_TEST.md). Automated checks and coverage expectations are in the [testing guide](IMPLEMENTATION.md).
