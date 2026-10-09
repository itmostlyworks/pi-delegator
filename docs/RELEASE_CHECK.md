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

## Background review fixes (current branch)

Automated checks on Linux, without provider calls:

- `npm run typecheck` — exit 0.
- `npm test` — exit 0; 194 passed.
- `git diff --check` — exit 0.

Regression coverage verifies that permanent shutdown wins overlapping navigation cleanup, concurrent navigation cleanup cannot reopen early, collected failures are not also reported as uncollected, cancelled waiters leave failures reportable, and independent HTML-export-style rendering cannot displace an interactive start card's settlement observer in either rendering order. Weak subscriptions and an isolated GC probe cover abandoned export callback collection while preserving live callbacks. Actual live Pi export/TUI interaction remains unverified.

## Opt-in codemode and contained MCP (current branch)

Environment: Linux x86_64; Node 26.5.0, npm 11.17.0, Pi SDK 1.1.0. The new MCP checks also ran under Node 22.23.2. No paid provider calls were made; native Pi sessions used an in-process mock provider with isolated agent directories and local MCP servers.

- `npm install` — exit 0; dependency audit reported no vulnerabilities.
- `npm run typecheck` — exit 0.
- `npm test` — exit 0; 228 passed.
- Node 22 `--experimental-strip-types --test --test-concurrency=1` over `test/delegate-mcp-extension.test.mjs`, `test/delegate-mcp-transport.test.mjs`, `test/mcp-http.test.mjs`, and `test/mcp-runner.test.mjs` — exit 0; 29 passed.
- `npm pack --dry-run` — exit 0; both adapter modules included, tests excluded.
- `git diff --check` — exit 0.

The initial dependency-upgrade baseline failed one legacy Bash assertion: Pi 1.1 returns structured nonzero-exit errors instead of throwing. The test now checks Pi's actual result semantics; command-timeout assertions still require thrown errors.

Coverage verifies explicit built-in validation and safe MCP adapter substitution; actual codemode read/private-Bash execution and write exclusion; actual tool-search and MCP discovery/calls; native project-trust isolation; bounded protocol/stderr and idempotent transport close; cleanup after server-leader exit with inherited pipes; completion, cancellation, and opted-in deadlines with EOF/TERM-resistant regrouped descendants. Cancellation during native MCP initialization and pending tool calls leaves no live processes in the captured session. Separate dependency installations and local HTTP 503/429/404/401 responses verify that transport errors use the host Pi's constructors. Command-valued OAuth secrets are rejected before transport/auth startup.

Unverified: macOS execution of the new integration (its Linux-specific end-to-end fixtures skip there), live model/TUI behavior, real remote HTTP/OAuth services and token refresh, compiled Bun Pi distributions, and an explicitly delayed host-module import cancellation race. Native HTTP recovery branches were checked through constructor identity, not a live remote-service retry exercise. Deliberate session escape and abrupt parent death remain outside containment; remote cancellation or rollback is not guaranteed.

## Reproduce

Use the [smoke-test guide](SMOKE_TEST.md). Automated checks and coverage expectations are in the [testing guide](IMPLEMENTATION.md).
