# Practical smoke test

Use an authenticated Pi installation and disposable fixtures. Record outcomes in [RELEASE_CHECK.md](RELEASE_CHECK.md); these live checks are separate from the provider-free test suite.

## 1. Prepare

From the checkout:

```bash
npm run typecheck
npm test
npm pack --dry-run

export ROOT="$PWD"
export SMOKE="$(mktemp -d /tmp/pi-delegator-smoke.XXXXXX)"
export MARKER="PI_DELEGATOR_$(basename "$SMOKE")"
printf 'Fixture: %s\nMarker: %s\n' "$SMOKE" "$MARKER"
pi --version
node --version
```

Check the effective scout/worker profiles in the Pi agent directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`) and any trusted project override. Record models and configured deadlines; don't assume bundled defaults. On macOS, `python3` must be on PATH.

Start a fresh Pi with the checkout explicitly loaded, without installing or removing packages:

```bash
cd "$SMOKE"
pi --no-session --no-extensions --no-skills --extension "$ROOT/src/index.ts"
```

Keep an observation terminal open. In prompts below, replace `<ROOT>` and `<MARKER>` with the printed values. Worker commands run in the disposable directory.

## 2. Scout

```text
Call delegate exactly once with agent scout and cwd <ROOT>. Ask it to confirm the purpose of src/index.ts and src/runner.ts, citing both paths. Do not inspect the files yourself.
```

Pass: one delegate completes and accurately describes both files.

## 3. Timeout recovery in the same delegate

```text
Call delegate exactly once with agent worker. First run this Bash command with the tool timeout set to 2 seconds:
node -e 'require("fs").writeFileSync("timeout.pid",String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),180000)' <MARKER>_timeout
Expect a timeout error. In the SAME delegate, then run: printf 'RECOVERED_AFTER_TIMEOUT\n'
Finish by reporting both outcomes. Do not use a second delegate.
```

Pass: the timeout is reported, the next command succeeds, the delegate finishes, and the recorded process is gone.

## 4. Background cleanup on normal completion

```text
Call delegate exactly once with agent worker. Run this Bash command without a tool timeout:
node -e 'require("fs").writeFileSync("background.pid",String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),180000)' <MARKER>_background > /dev/null 2>&1 & sleep 15
Then finish. Do not kill the background job yourself; the parent runner should clean it up.
```

While the job is active, record its identity as described below. Pass: the job has a distinct PGID but shares the delegate's SID, and both disappear when the delegate finishes.

## 5. Interactive Escape cancellation

```text
Call delegate exactly once with agent worker. Run this Bash command without a tool timeout and wait for completion:
node -e 'require("fs").writeFileSync("cancel.pid",String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),180000)' <MARKER>_cancel
```

Observe the live PID first, then press **Escape** in Pi. Pass: the tool settles as `cancelled`, and the delegate and marked descendant disappear. The fixture's three-minute safety exit is only a backstop, not a cancellation pass. Killing the parent with SIGINT or an outer timeout is not this test.

## Observe and clean up

In the observation terminal, set `SMOKE` to the printed fixture directory. Choose `timeout.pid`, `background.pid`, or `cancel.pid`:

```bash
export SMOKE=/tmp/pi-delegator-smoke.REPLACE_ME
pid="$(<"$SMOKE/cancel.pid")"
ps -p "$pid" -o pid=,ppid=,pgid=,sess=,command=
# macOS ps masks sess; use the POSIX API for the actual session ID.
python3 -I -S -c 'import os,sys; p=int(sys.argv[1]); print("PID",p,"PGID",os.getpgid(p),"SID",os.getsid(p))' "$pid"
```

Record the SID as `delegate_pid` and inspect it with `ps` too. After completion or cancellation, this should return no rows (exit 1):

```bash
ps -p "$pid,$delegate_pid" -o pid=,pgid=,sess=,stat=,command=
```

Bound observation to 90 seconds for startup and 5 seconds after cancellation. If a check stalls, cancel with Escape and record what happened. If a fixture survives, record failure and clean up only its recorded PID after confirming the command still contains your unique marker; never kill by a broad process-name match. Exit the test Pi session before removing the disposable directory:

```bash
rm -rf -- "$SMOKE"
```

For profile or UI changes, also exercise the affected role in a disposable repository: reviewer/tester should follow their no-edit instructions, worker should make only the requested edit, and two sibling scouts should return independently. The standard release check need not repeat every role scenario.
