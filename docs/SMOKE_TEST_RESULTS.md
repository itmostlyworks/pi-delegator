# Release smoke-test results

## 2026-08-29 — v0.5.0 release candidate

Environment:

- Pi `0.84.3`
- Node.js `v26.5.0`
- macOS
- parent model `openai-codex/gpt-5.6-sol`
- repository base commit `6c2aedea204d18172f350fbdca2e78f9c74765c0`, with the model-visible truncation fix in the working tree
- effective profiles from the user's `pi-delegator.json`; delegated models were `openai-codex/gpt-5.6-luna` for scout, tester, and worker and `openai-codex/gpt-5.6-sol` for reviewer

All Pi sessions were ephemeral. Live checks used `pi --mode json --print --no-session` except cancellation, which used Pi RPC mode so the test harness could send a deterministic parent abort while the marked child was active.

| Check | Exact command/session | Observed outcome | Pass? |
| --- | --- | --- | --- |
| Environment and automated checks | `npm run typecheck`; `npm test`; `npm pack --dry-run` | Typecheck passed; 54/54 tests passed; dry-run package contained 20 files and completed successfully. | Yes |
| Scout known files | `pi --mode json --print --no-session 'Call delegate exactly once with agent scout. Ask it to confirm the purpose of src/index.ts and src/runner.ts, citing both paths. Do not inspect the files yourself.'` | One scout returned in 19 seconds and accurately described both paths. | Yes |
| Reviewer no-write | `pi --mode json --print --no-session 'Call delegate exactly once with agent reviewer. Ask it to review the current uncommitted diff for correctness and report findings without modifying files. Do not review the diff yourself.'` | Reviewer identified the subtraction bug in 21 seconds. Before/after diff hash `8e67cffdefbfbafaf897f03e24180c0c6ae8c86f` and status hash `e36a3a68cf0950467ccb09af6aaf9d64f21d7170` matched. | Yes |
| Tester real-behavior verification | `pi --mode json --print --no-session 'Call delegate exactly once with agent tester. Ask it to verify the double(value) feature by running the existing test suite and directly exercising representative positive, zero, and negative inputs. Require concrete evidence and do not modify source or configuration files. Do not test the feature yourself.'` | Tester reported PASS in 28 seconds. HEAD remained `cbfedad2f253ac17205606cb68e823ac3ed04f59`; clean-status hash remained `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`. | Yes |
| Worker edit and validation | `pi --mode json --print --no-session 'Call delegate exactly once with agent worker. Ask it to add a triple(value) export to double.js, add one focused test, run npm test, and report changed files and validation. Do not make the change yourself.'`; then `npm test` and `git diff --exit-code -- package.json` | Worker changed only `double.js` and `double.test.js`; both test runs passed with two tests; `package.json` was unchanged. Completed in 23 seconds. | Yes |
| Parallel sibling scouts | `pi --mode json --print --no-session 'In one assistant turn, issue two independent delegate tool calls so Pi can run them as siblings. Use scout for both. Ask one to summarize src/protocol.ts and the other to summarize src/process-tree.ts. Do not inspect those files yourself and do not run the calls sequentially.'` | Two `delegate` starts preceded either end. Both returned isolated summaries in 38 seconds. | Yes |
| Parent cancellation/process tree | `pi --mode rpc --no-session`; send the section 7 prompt as a `prompt` request, wait for the marked descendant, then send `{"id":"abort","type":"abort"}` | RPC acknowledged abort, the tool reported `cancelled`, and the descendant disappeared after 33 ms with no survivor after three seconds. | Partial* |
| Descendant-held stdout | Set the three section 8 fixture variables, then run `pi --mode json --print --no-session 'Call delegate exactly once with agent scout and task "exercise the descendant-held-pipe fixture". Report the delegate tool error verbatim.'` | Settled in 10 seconds; reported `missing_terminal_answer` after 358 ms and the descendant PID was gone. | Yes |

`*` The process-tree behavior was exercised through Pi's RPC `abort` command, which drives active-operation cancellation. The exact interactive Escape/`app.interrupt` interaction remains unverified: attempts to drive Pi's TUI through an `expect` pseudo-terminal did not progress beyond startup. A human must perform section 7 once in a real terminal before calling the complete manual smoke suite passed.

Temporary JSONL logs and disposable repositories were kept outside the repository during the run and removed after this report was written.
