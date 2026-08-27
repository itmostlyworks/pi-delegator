# Manual release smoke test

Run these checks from a clean `pi-delegator` checkout on macOS or Linux with an authenticated Pi installation. They make live provider calls and are intentionally not part of `npm test`.

## 1. Prepare and record the environment

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run

export PI_DELEGATOR_ROOT="$PWD"
export PI_DELEGATOR_SMOKE_ROOT="$(mktemp -d)"
pi install "$PI_DELEGATOR_ROOT"

pi --version
node --version
git rev-parse HEAD
```

Start a new Pi process after installation. Record the exact model/provider used, the commands run, elapsed behavior, and result in the report template below. Never use a valuable working tree for worker checks.

## 2. Scout two known files

From the package checkout, start Pi:

```bash
cd "$PI_DELEGATOR_ROOT"
pi
```

Send this prompt:

```text
Call delegate exactly once with agent scout. Ask it to confirm the purpose of src/index.ts and src/runner.ts, citing both paths. Do not inspect the files yourself.
```

Pass conditions:

- one scout call starts and returns within its three-minute profile deadline;
- the response identifies both files accurately;
- progress is compact rather than a full child transcript.

## 3. Reviewer does not modify a small diff

Create a disposable repository with one uncommitted diff:

```bash
mkdir -p "$PI_DELEGATOR_SMOKE_ROOT/reviewer"
cd "$PI_DELEGATOR_SMOKE_ROOT/reviewer"
git init -q
printf 'export function add(a: number, b: number) { return a + b; }\n' > math.ts
git add math.ts
git -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm base
printf 'export function add(a: number, b: number) { return a - b; }\n' > math.ts
before_diff="$(git diff --binary | git hash-object --stdin)"
before_status="$(git status --porcelain=v1 -z | git hash-object --stdin)"
pi
```

Send this prompt:

```text
Call delegate exactly once with agent reviewer. Ask it to review the current uncommitted diff for correctness and report findings without modifying files. Do not review the diff yourself.
```

After Pi returns, exit it and verify the working tree is byte-for-byte unchanged:

```bash
after_diff="$(git diff --binary | git hash-object --stdin)"
after_status="$(git status --porcelain=v1 -z | git hash-object --stdin)"
test "$before_diff" = "$after_diff"
test "$before_status" = "$after_status"
```

Pass conditions: the reviewer reports the subtraction bug and both `test` commands exit 0.

## 4. Worker edits a disposable repository

```bash
mkdir -p "$PI_DELEGATOR_SMOKE_ROOT/worker"
cd "$PI_DELEGATOR_SMOKE_ROOT/worker"
git init -q
printf '{"scripts":{"test":"node --test"},"type":"module"}\n' > package.json
printf 'export const double = (value) => value * 2;\n' > double.js
printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { double } from "./double.js";\ntest("double", () => assert.equal(double(3), 6));\n' > double.test.js
git add package.json double.js double.test.js
git -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm base
pi
```

Send this prompt:

```text
Call delegate exactly once with agent worker. Ask it to add a triple(value) export to double.js, add one focused test, run npm test, and report changed files and validation. Do not make the change yourself.
```

After Pi returns, exit it and verify:

```bash
npm test
git status --short
git diff --exit-code -- package.json
```

Pass conditions: only the requested fixture files change, the new test exists, and both the worker's validation and the explicit `npm test` pass.

## 5. Two sibling scouts

From the package checkout:

```bash
cd "$PI_DELEGATOR_ROOT"
pi
```

Send this prompt:

```text
In one assistant turn, issue two independent delegate tool calls so Pi can run them as siblings. Use scout for both. Ask one to summarize src/protocol.ts and the other to summarize src/process-tree.ts. Do not inspect those files yourself and do not run the calls sequentially.
```

Pass conditions:

- both tool calls are visibly active at the same time;
- each result describes only its requested file;
- neither result or lifecycle outcome overwrites the other.

## 6. Cancel an active process tree

Generate a unique marker, start Pi interactively, and keep the shell open for the post-cancel check:

```bash
export PI_DELEGATOR_CANCEL_MARKER="PI_DELEGATOR_CANCEL_$(date +%s)_$$"
cd "$PI_DELEGATOR_SMOKE_ROOT/worker"
pi
```

Send the prompt below after replacing `<MARKER>` with the value printed by `printf '%s\n' "$PI_DELEGATOR_CANCEL_MARKER"`:

```text
Call delegate exactly once with agent worker. Ask it to run this exact validation command and wait for it to finish before answering: node -e 'setInterval(() => {}, 1000)' <MARKER>
```

Wait until the worker starts the command, then press Escape (Pi's default `app.interrupt` binding) to cancel the active tool call. Exit Pi if needed and check:

```bash
sleep 3
if ps -axo command= | grep -F "$PI_DELEGATOR_CANCEL_MARKER" | grep -v grep; then
  echo "FAIL: marked descendant still exists" >&2
  exit 1
fi
```

Pass conditions: cancellation settles after bounded cleanup and the marked descendant is absent.

## 7. Descendant-held-pipe cleanup fixture

This check uses a real parent Pi process and the repository's fixture as the delegated child. It makes no child provider call. The fixture exits after starting a descendant that inherits stdout, reproducing the pipe-drain failure mode.

```bash
export PI_DELEGATOR_PI_BINARY="$PI_DELEGATOR_ROOT/test/fixtures/fake-pi.mjs"
export FAKE_PI_SCENARIO="descendant-holds-stdout"
export FAKE_PI_DESCENDANT_PID_PATH="$PI_DELEGATOR_SMOKE_ROOT/descendant.pid"
cd "$PI_DELEGATOR_ROOT"
pi
```

Send this prompt:

```text
Call delegate exactly once with agent scout and task "exercise the descendant-held-pipe fixture". Report the delegate tool error verbatim.
```

The call should settle with a bounded `missing_terminal_answer` failure rather than hang. Exit Pi, then verify the descendant is gone:

```bash
pid="$(cat "$FAKE_PI_DESCENDANT_PID_PATH")"
if kill -0 "$pid" 2>/dev/null; then
  echo "FAIL: fixture descendant $pid still exists" >&2
  exit 1
fi
unset PI_DELEGATOR_PI_BINARY FAKE_PI_SCENARIO FAKE_PI_DESCENDANT_PID_PATH
```

## 8. Record the release result

Copy this table into the release notes or implementation report and fill every row. Do not mark v0.1.0 smoke-tested without recording actual outcomes.

| Check | Exact command/session | Observed outcome | Pass? |
| --- | --- | --- | --- |
| Environment and automated checks |  |  |  |
| Scout known files |  |  |  |
| Reviewer no-write |  |  |  |
| Worker edit and validation |  |  |  |
| Parallel sibling scouts |  |  |  |
| Parent cancellation/process tree |  |  |  |
| Descendant-held stdout |  |  |  |

Clean up when finished:

```bash
rm -rf "$PI_DELEGATOR_SMOKE_ROOT"
pi remove "$PI_DELEGATOR_ROOT"
```
