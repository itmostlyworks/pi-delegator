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

## Opt-in background implementation checks

Environment: Linux x86_64, Node 26.5.0. These deterministic checks are separate from the 0.6.6 live checks above.

| Check | Recorded outcome |
| --- | --- |
| Typecheck | `npm run typecheck` — exit 0 |
| Automated tests | `npm test` — exit 0; 142 passed |
| Packaging | `npm pack --dry-run` — exit 0; includes `src/background.ts` |
| Coverage | Default-disabled and trusted configuration, provider-compatible root schema, start/wait, single collection and usage, visible uncollected failures without UI, wait cancellation, session lifecycle descendant cleanup, navigation reuse, close-time failure reporting, bounded run registry, monotonic short IDs, start/wait/failure badges, expanded metadata, and saved-history rendering without a live registry |

Earlier parallel-file suite runs exited 1 with timing-sensitive runner fixture failures (four on the first run, one on the second). Serial-file execution passed; `npm test` now runs files serially while retaining explicit concurrency tests. An intermediate renderer typecheck error was fixed before the final checks above.

A live scout start/wait smoke test succeeded before the short-ID/UI refinement and made no file changes. The short-ID/UI refinement passed typecheck, all 142 deterministic tests, package dry-run, and `git diff --check` (each exit 0). Actual interactive cards, end-to-end history reload, and native macOS cleanup remain unverified for this change.

## Background badge deduplication checks

Environment: Linux x86_64, Node 26.5.0; deterministic fake-Pi fixtures, no provider calls.

- `npm run typecheck` — exit 0 (initial and final runs).
- `npm test` — initial exit 1: new failure-text assertion omitted the existing `Delegate failed` wording; assertion corrected. Final exit 0, 142 passed.
- `git diff --check` — exit 0.
- Assertions cover one badge across paired wait call/result renders, start header/body, and custom failure cards in collapsed/expanded views; full model-facing failure content and `run-N` handles remain unchanged. Only the generated leading failure prefix is removed from rendered output.

Actual interactive cards, end-to-end history reload, live-provider behavior, and native macOS rendering remain unverified for this UI-only change. No launch, cancellation, collection, or usage ownership changes were made.

## Congruent background card layout checks

Environment: Linux x86_64, Node 26.5.0; deterministic fake-Pi fixtures, no provider calls.

- `npm run typecheck` — initial exit 2 (optional action needed a property guard); subsequent and final exits 0.
- `npm test` — first two runs exit 1, each 142 passed / 1 failed: the new preview assertion first omitted the truncation ellipsis, then compared unwrapped text against wrapped terminal output. Assertions corrected; final exit 0, 143 passed / 0 failed.
- `npm pack --dry-run` — exit 0 on all three runs.
- `git diff --check` — exit 0 on all three runs and after this record.
- Coverage: collapsed/expanded operation-only start/wait calls; start task preview and exact expanded wait handle; wait answer/failure diagnostics and metadata; saved bounded safe start previews and custom failures after collection/navigation; unchanged foreground call snapshots and model-facing start handles. Launch, cleanup, session ownership, IDs, and usage paths are unchanged.

Actual interactive cards, end-to-end history reload, live-provider behavior, and native macOS UI remain unverified for this layout change.

## Pending background wait checks

Environment: Linux x86_64, Node 26.5.0, npm 11.17.0; deterministic fake-Pi fixtures, no provider calls.

- `npm run typecheck` — initial exit 2 (closure lost runId narrowing); corrected, subsequent and final exits 0.
- `node --test --test-name-pattern='pending background waits|wait timers clear' test/extension.test.mjs` — initial exit 1 (fixture delay too short for a tick); final exit 0, 2 passed.
- `npm test` — initial exit 1, 144 passed / 1 failed (fixture delay string used a numeric separator, yielding NaN); corrected to `2200`. Final exit 0, 145 passed / 0 failed.
- `npm pack --dry-run` — both runs exit 0; 25 files, includes `src/background.ts`.
- `git diff --check` — exit 0 before and after this record.

Coverage: immediate pending results, elapsed time measured from start, silent-child one-second ticks, custom profile labels, parallel wait isolation, expanded model/thinking and cancellation clarification, final result replacement, harmless throwing observers, no late updates, cleared timers on success/failure/abort, and no timers for unknown/duplicate/already-aborted or observer-free waits. Existing collection, usage, foreground rendering, session ownership, and bounded cleanup tests pass unchanged. No new run deadline or live updates to old cards were added.

Actual interactive repaint cadence, end-to-end history reload, live-provider behavior, and native macOS UI remain unverified.

## Settled background wait cancellation race checks

Environment: Linux x86_64, Node 26.5.0, npm 11.17.0; deterministic fake-Pi fixtures, no provider calls.

- `node --test test/background.test.mjs` — exit 0; 13 passed / 0 failed.
- `npm run typecheck` — exit 0.
- `npm test` — exit 0; 149 passed / 0 failed.
- `npm pack --dry-run` — exit 0; 25 files, includes `src/background.ts`.
- `git diff --check` — exit 0 before and after this record.

Coverage: settled successes and failures remain collectable when the immediate wait observer synchronously aborts, including abort-then-throw observers. Cancellation wins before collection; the race handles the rejected cancellation promise, the waiter claim is released, the abort listener is removed, the owned run is not aborted, and failure notification occurs only once. Final change review found only a post-race abort check and regression tests, with no new waits, deadlines, or lifecycle scope.

Live-provider behavior, actual interactive UI, and native macOS behavior remain unverified for this change.

## Approved live-start / compact-wait UI checks

Environment: Linux x86_64, Node 26.5.0, npm 11.17.0; deterministic fake-Pi fixtures, no provider calls.

- `npm run typecheck` — initial exit 2 during integration (optional-property assignments, later closure narrowing); final exit 0.
- `npm test` — integration runs initially exposed obsolete UI assertions; subsequent run exit 1, 160 passed / 2 failed after adding an inactive closure redraw. Assertions updated for that intentional redraw. Final exit 0, 162 passed / 0 failed.
- `npm pack --dry-run` — exit 0; 25 files, includes `src/background.ts`.
- `git diff --check` — exit 0.

Reviewed installed Pi extension/TUI docs, subagent renderer example, actual `ToolRenderContext` declarations, and interactive tool-execution implementation. Public renderer `invalidate()` invalidates this component and requests rendering after a returned result; this implementation does not use post-return `onUpdate` or fake pending execution.

Coverage includes start-card silent heartbeats and bounded foreground-equivalent activity, parallel identity isolation, compact pending waits with no timer, compact terminal start summaries without answers or stale collection hints, history fallback and mismatched tool-call IDs, throwing observers, subscription replacement/unsubscription, settlement/collection/closure cleanup, and automatic inactive redraw on pre-navigation/shutdown. Existing collect-once, settled abort-race, usage, foreground, failure notification, and process cleanup tests remain passing. Final review preserved the user-owned `AGENTS.md` change and found no new useful-work deadlines, persistence, dashboard, or orchestration.

Actual interactive repaint correctness, end-to-end history reload, live-provider behavior for this UI revision, and native macOS behavior remain unverified. Reload Pi before a two-delegate `sleep 20` demonstration; it has not been run against the revised UI yet.

## Foreground/start presentation alignment and scrollback investigation

Environment: Linux x86_64, Node 26.5.0, npm 11.17.0. Project dependency Pi/pi-tui 0.84.3; active installed `pi` binary resolves to Pi 1.0.3 and nested pi-tui 1.0.3.

- `npm run typecheck` — exit 0.
- Targeted extension tests — exit 0, 46 passed.
- `npm test` — initial exit 1, 161 passed / 1 failed (collapsed and expanded renders straddled a millisecond; equivalence assertion incorrectly reused collapsed elapsed time). Corrected assertion to use each rendered header's elapsed time. Final exit 0, 162 passed / 0 failed.
- `npm pack --dry-run` — exit 0, 25 files.
- `git diff --check` — exit 0.

Running start cards now reuse the foreground result formatter for model/thinking/elapsed/Running and activity, with a badge and bounded saved task preview. Tests compare both compact and expanded running output directly against foreground output after removing intentional badge/task/collection instructions. No new live usage section. Pending waits, terminal summaries, billing, lifecycle, and foreground rendering remain unchanged.

Before this alignment, two live parallel Tester/Reviewer starts each executed `sleep 20` and were collected successfully. User reported the revised UI worked mostly, then requested foreground-equivalent start formatting and reported repeated scrollback pull-downs while a later delegate waited.

Scrollback investigation: inspected installed Pi's tool invalidation and main-screen differential renderer. Ran `node /tmp/tui-main-screen-repro.mjs` (temporary script removed) against installed pi-tui 1.0.3 with a fake 5-row terminal and 12 content rows: exit 0. Updating row 2 above the viewport emitted `ESC[3J` and full replay (360 bytes); updating visible row 11 did not clear scrollback (46 bytes). This reproduces a concrete difference between old start-card updates and newest foreground updates, not an actual terminal scrolling gesture. A proposed removal of idle repaints was withdrawn at the user's request; live heartbeat remains intact. No supported extension viewport API was found. Scrollback behavior is not fixed; a host Pi renderer fix requires separate approval/work.

Aligned interactive UI, end-to-end history reload, and native macOS remain unverified.

## Uncompressed start-task text and spacing

Environment: Linux x86_64, Node 26.5.0, npm 11.17.0; deterministic fake-Pi fixtures for code verification.

- `npm run typecheck` — exit 0.
- Targeted extension tests — exit 0, 47 passed.
- `npm test` — exit 0, 163 passed / 0 failed.
- `npm pack --dry-run` — exit 0, 25 files.
- `git diff --check` — exit 0.

Start cards now use the original task from saved renderer call arguments without whitespace normalization or truncation, preserving line breaks, repeated spaces and tabs after terminal-control sanitization. Blank lines separate header, task and activity. Missing-argument fallback remains a bounded 240-codepoint preview but now preserves whitespace. Tests cover both views, tasks longer than the fallback and collapsed preview limits, terminal-control safety, history with/without arguments, shared foreground activity formatting, and unchanged compact waits/terminal summaries. No lifecycle or registry changes; existing user-owned edits remain intact.

Before this spacing change, a repeated live parallel Tester/Reviewer `sleep 20` demo was collected successfully and the user reported scrolling worked fine. A subsequent Scout demo read background/display/rendering files and was collected successfully; the user then requested restoration of newlines and no task compression. The scrollback full-replay mechanism documented above remains a host limitation, but no Pi patch or removal of live heartbeat was made. Actual interactive rendering of this latest spacing revision, history reload, and native macOS behavior remain unverified.

## Local Pi scrollback mitigation for offscreen live start cards

The user reproduced jumps when the start card was above the visible screen with intervening content before wait, and requested a fix without reducing live updates. Applied a reversible host-only patch to installed Pi 1.0.3, not to extension lifecycle or heartbeat code:

- `node_modules/@earendil-works/pi-tui/dist/tui-main-screen.js`
- `dist/bundle/chunks/chunk-AXOERKKW.js`

Both paths are beneath `/home/ludwig/.local/share/pi-node/node-v22.23.2-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/`. Backups, hashes, test script/evidence, and restoration instructions are in `~/.pi/agent/local-patches/pi-tui-scrollback-1.0.3/`. Restore with `sh ~/.pi/agent/local-patches/pi-tui-scrollback-1.0.3/restore.sh`; preflight hash guards reject a changed/upgraded installation and verify backups before copying.

The patched above-viewport fallback rescans only visible changes for equal-height text updates with unchanged dimensions, normal bottom-aligned viewport, no images, and no overlays. Offscreen-only ticks commit renderer bookkeeping without clearing/replaying scrollback. Visible changes continue through normal differential rendering. Structural growth/shrink, resize, images, overlays and other fallbacks are intentionally unchanged. Native scrollback remains a historical snapshot; updates cannot rewrite text already there. This mitigates repeated elapsed-time jumps, not every terminal/layout-change scroll effect.

Verification:
- `node --check` for both modified JavaScript files — exit 0.
- `pi --version` — exit 0, 1.0.3 (bundled CLI loads).
- `node --test ~/.pi/agent/local-patches/pi-tui-scrollback-1.0.3/scrollback.test.mjs` — worker and coordinator runs exit 0, 28 passed / 0 failed. Tests exercise both standalone and bundled exports, baseline comparisons, offscreen-only/visible changes, repeated ticks then append, cursor/high-water bookkeeping, resize/Termux behavior, growth/shrink, image and overlay exclusion, and bounded patch scope.
- `sh -n ~/.pi/agent/local-patches/pi-tui-scrollback-1.0.3/restore.sh` — exit 0.
- `npm run typecheck` — exit 0; extension code unchanged from the prior 163-test passing run.
- `git diff --check` — exit 0.

Restart the Pi process (not only extension reload) to load the host patch. Package upgrades/reinstallation can replace it. Interactive scrolling after restart and native macOS remain unverified; fake-terminal tests do not reproduce actual terminal scroll gestures. No extension live activity was disabled or reduced.

## Local Pi patch reverted for comparison

After a 30-second live sleep demo, the user reported scrolling worked but noticed the offscreen start timer remained at its last painted value until completion. Explained the native-scrollback snapshot tradeoff; user requested reverting the host patch for comparison.

- `sh ~/.pi/agent/local-patches/pi-tui-scrollback-1.0.3/restore.sh` — exit 0; backup and restored-file SHA-256 checks passed for both standalone and bundled renderer files.
- `pi --version` — exit 0, 1.0.3.

Installed renderer files are restored to their original contents; extension code and live heartbeat are unchanged. Restart the Pi process to load the restored renderer. Backups and diagnostic tests remain available. Post-restart comparison is not yet performed.

## Reproduce

Use the [smoke-test guide](SMOKE_TEST.md). Automated checks and coverage expectations are in the [testing guide](IMPLEMENTATION.md).
