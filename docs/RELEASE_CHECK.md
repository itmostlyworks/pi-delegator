# Release verification report

Date: 2026-09-09
Checkout: `7977cd434e74281f4dc3708417c69b5589171f7a` (working tree already contained the requested uncommitted Bash-extension fix)

## Environment and commands

- Node: `v26.5.0`
- npm: `11.17.0`
- Pi: `0.85.1`
- Platform: macOS (supported POSIX platform)
- Auth readiness: `pi auth print-bearer-token --provider openai-codex` exited 0; no credential output was recorded. No auth changes were made.
- Live model requested for parent calls: `openai-codex/gpt-5.3-codex-spark`. Pi resolved child calls to available `openai-codex` models (the returned details showed `gpt-5.6-luna`, `gpt-6-astra`, or `gpt-5.6-sol` depending on call).

Commands and exit codes:

```text
npm run typecheck                         0
npm test                                  0 (72 passed, 0 failed)
npm pack --dry-run                        0 (@mostlyworks/pi-delegator@0.5.5)
pi --list-models                          0
```

All live parent calls used this safety shape, from the checkout or disposable fixture cwd:

```text
pi --mode json --print --no-session --no-extensions --no-skills \
  --extension /Users/ludwigbacklund/projects/pi-delegator/src/index.ts \
  --model openai-codex/gpt-5.3-codex-spark '<prompt>'
```

Thus ambient extensions and skills were disabled; no package install/remove or publish was performed.

## Provider-free automated verification

`npm test` exercised the fake-Pi process fixtures, including the current private Bash extension being loaded before conflicting Bash extensions, Bash timeout/abort reserved exit codes, process-group cleanup, descendant cleanup, cancellation, parallel isolation, profiles/tool contracts, protocol limits, typecheck, and tool error semantics. Result: **PASS**, 72/72.

## Authenticated live release smoke tests

All fixtures were created under `/tmp/pi-delegator-release.7kVBsn` and were disposable.

| Scenario | Exact interaction | Observed result | Verdict |
| --- | --- | --- | --- |
| Scout known files | Parent JSON CLI prompt: `Call delegate exactly once with agent scout... confirm the purpose of src/index.ts and src/runner.ts...` | One `delegate` call returned a concise, accurate description citing both paths. | **PASS** |
| Reviewer no-write | Disposable git repo with `math.ts` changed from addition to subtraction; reviewer prompt from `docs/SMOKE_TEST.md` | Reported the subtraction bug. `git diff` and `git status --porcelain -z` hashes were unchanged. | **PASS** |
| Tester no-write | Disposable `double.js` Node test fixture; tester was asked for suite plus positive/zero/negative direct checks | Reported `npm test`: 1 passed/0 failed; direct checks included `3 -> 6`, `0 -> 0`, and `-4.5 -> -9`. HEAD and status were unchanged. | **PASS** |
| Worker scoped edit | Disposable worker repo; worker asked to add `triple(value)` and one test | Only `double.js` and `double.test.js` changed; worker reported 2 passed/0 failed; explicit post-run `npm test` exited 0; `package.json` diff exited 0. | **PASS** |
| Parallel scouts | Second run used exactly two sibling calls in one parent turn, one for `src/protocol.ts`, one for `src/process-tree.ts` | JSON event inspection counted `delegate_starts=2`, `delegate_ends=2`; both returned independently. | **PASS** |
| Descendant-held stdout | Parent used `PI_DELEGATOR_PI_BINARY=/Users/ludwigbacklund/projects/pi-delegator/test/fixtures/fake-pi.mjs`, `FAKE_PI_SCENARIO=descendant-holds-stdout` | Returned in 361 ms with `missing_terminal_answer`, not a hang. Fixture PID existed in the pid file and was no longer alive. | **PASS** |
| Parent cancellation / marked descendant | `timeout -s INT 25 pi ...` with worker task running `node -e 'setInterval(() => {}, 1000)' <unique marker>` | The outer timeout exited 124, but the marked descendant was still alive after 3 seconds. It was then explicitly TERM/KILL cleaned up. | **Not a tool-cancellation test; see follow-up** |

A preliminary parallel prompt caused the model to issue three calls (including a corrective duplicate due to a typo in one generated cwd); it was not counted as the release pass. The constrained repeat issued exactly two calls and passed.

## Classification

- **Provider-free:** automated unit/integration suite, typecheck, and pack dry run.
- **Authenticated live:** scout, reviewer, tester, worker, parallel scouts, and descendant-held-pipe fixture via the real local Pi CLI and checkout extension.
- **TUI:** unverified; checks used Pi JSON CLI rather than interactive TUI.
- **Cancellation:** authenticated SDK cancellation returned `cancelled`, but no descendant PID was observed before the test guard. Live descendant removal remains blocked. The earlier `timeout -s INT` test exercised abrupt parent death, not the tool AbortSignal contract; its lingering marker process was cleaned up and verified absent.

## Cleanup and side effects

- Removed the live cancellation marker process with TERM then KILL and verified it was absent.
- Disposable fixture tree `/tmp/pi-delegator-release.7kVBsn` was removed after testing.
- No repository source/configuration files were edited by verification. This report is the only repository edit from this verification run.
- No production credentials, valuable repository data, package installation/removal, publish, or commit was used.

## Release packaging recheck

After bumping the package to `0.5.6`, `npm run typecheck`, `npm test` (72 passed), `npm pack --dry-run`, and `git diff --check` each exited 0. This recheck does not close the live cancellation, TUI, or Linux verification gaps below.

## Verdict

**Not fully release-cleared:** automated descendant cleanup tests pass and authenticated SDK cancellation returns the correct failure, but live cancellation with an observed descendant and interactive TUI Escape cancellation remain unverified. Other exercised live scenarios passed. Linux-specific verification was not performed.


## Follow-up: authenticated SDK cancellation (2026-09-09)

The earlier `timeout -s INT 25 pi ...` check does **not establish** Pi tool cancellation: it signals the parent process without evidence that Pi delivered the tool's `AbortSignal`. It is therefore classified as abrupt-parent-death behavior (**unsupported/unverified**, not evidence about `session.abort()`).

The reproducible authenticated check used the Pi SDK directly, with a bounded guard:

1. Create a disposable temp cwd with `mkdtemp`.
2. Create `DefaultResourceLoader({ cwd, agentDir: "/Users/ludwigbacklund/.pi/agent", noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: ["/Users/ludwigbacklund/projects/pi-delegator/src/index.ts"] })`, then `await loader.reload()`.
3. Create `ModelRuntime` with `/Users/ludwigbacklund/.pi/agent/auth.json` and `models.json`; select parent model `openai-codex/gpt-5.3-codex-spark` explicitly. Create an in-memory session with `tools: ["delegate"]`, then call `await session.bindExtensions({ mode: "print" })`.
4. Prompt: `Call delegate exactly once with agent worker, model openai-codex/gpt-5.3-codex-spark, cwd <temp>, and pass this task verbatim: MANDATORY FIRST ACTION: use bash to run exactly this command: node -e 'require("fs").writeFileSync("<temp>/delegate-started.pid", String(process.pid)); setInterval(() => {}, 1000)'. Do not do anything before it. After it starts, do not run another tool and do not provide a final answer.`
5. Poll the marker for at most 90 seconds. Only after reading its PID, wait 500 ms, call `await session.abort()`, await the prompt with a 10-second guard, and poll `process.kill(pid, 0)` for at most 3 seconds. Always `session.dispose()`, TERM/KILL any remaining marker PID, and remove the temp cwd in `finally`.

Observed SDK run: the real checkout extension loaded once with no extension errors; the parent used `openai-codex/gpt-5.3-codex-spark` at thinking `low`; the delegate tool started and returned `Delegate failed [cancelled] ... Parent cancelled the delegate` after 88,877 ms. `session.abort()` was the explicit cancellation call (not SIGINT). However, the worker never created `delegate-started.pid` before the 90-second guard, so no descendant PID was observed and descendant disappearance could not be asserted. This is **BLOCKED**, not a passing process-tree result. The guard cancelled the delegate and cleaned the disposable state.

Effective profile configuration was not silently assumed: `/Users/ludwigbacklund/.pi/agent/pi-delegator.json` was present and defined custom `worker` as model `openai-codex/gpt-5.6-sol`, thinking `medium`, tools `read, grep, find, ls, bash, edit, write`, no skills/extensions, and a 1,200,000 ms deadline. The test explicitly overrode the child model to `openai-codex/gpt-5.3-codex-spark`; no project config existed in the disposable cwd. Thus the observed cancellation is authenticated and contract-correct, but the required descendant-PID assertion remains unverified.
