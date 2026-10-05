# Product contract

`pi-delegator` exposes one Pi tool for a focused task in a fresh subprocess, foreground by default with opt-in session-owned background execution. The parent receives compact progress and a final answer or a precise failure. There is no manager process or durable run state.

## Tool interface

```ts
delegate({ agent: "reviewer", task: "Review the current diff" })
```

Optional fields: `model` and `cwd` (strings).

- Each foreground run or background start launches one child; independent runs can execute concurrently.
- `agent` must name an enabled profile. Unknown fields are rejected.
- `task` must be nonblank and at most 32 KiB UTF-8.
- `cwd` defaults to the parent context's directory and must be an existing directory.
- Model precedence: call override → profile model → parent model. Selectors are at most 256 UTF-8 bytes.
- Thinking, prompts, tool access, and optional deadlines belong to profiles, not per-call overrides.
- Children do not save sessions or discover ambient skills and extensions. Explicit profile capabilities are loaded instead.

### Opt-in background actions

With effective configuration `background: true`, the existing tool accepts optional `action` (`"run"`, `"start"`, or `"wait"`) and `runId`. Omitted action means `"run"` and preserves foreground behavior.

- `run` and `start` require `agent` and `task`, accept optional `model` and `cwd`, and reject `runId`.
- `start` returns immediately with a session-owned `runId` (`run-1`, `run-2`, …), not an answer. IDs are not reused within a session.
- `wait` accepts only `action` and a nonblank `runId` (1–64 characters). It collects the answer or throws the failure once. Unknown, collected, or concurrently waited IDs fail.
- At most 32 uncollected background runs are retained, including completed successes and failures. Collection frees a slot; completion alone does not.
- Cancelling `wait` leaves the run session-owned and available for another wait; it does not abort the child or collect usage. The cancellation message identifies the run, says waiting stopped and the delegate was not cancelled, and instructs the caller to wait again for the result.
- Background defaults to disabled, leaving the foreground schema unchanged. Action-specific fields are validated before launch or collection.

### Background presentation

Background runs reuse foreground cards. Foreground presentation is unchanged.

- Start uses `Delegate · Profile · Start` and the foreground terminal-safe task formatting: abbreviated and whitespace-normalized collapsed, full and whitespace-preserving expanded. The task stays in the call, not duplicated in the result.
- The static start result shows profile/model/thinking/Started. Settlement may repaint it once to Completed/Failed and duration, never an answer. No periodic activity, elapsed-time, or usage repaint. Completed means delegation finished, not necessarily task success.
- Wait uses `Delegate · Wait · run-N`; this call identifies the run without repeating IDs or badges in result headings. Pending wait uses exactly foreground activity and elapsed-time formatting. Collection replaces progress with the answer or diagnostics, using foreground result formatting plus Completed/Failed.
- Human cards contain no collection instructions or extra usage/cleanup rows. Model-facing start returns retain retrieval instructions. Uncollected failure notifications identify the run for linkage.
- Historical starts cannot bind to another tool call's reused run ID. Without matching live state or a retained terminal summary they show Started (inactive).

### Active delegate status

The interactive footer shows active foreground and background runs using profile identifiers: `delegates: scout · worker ×2`. Every active profile is listed, with duplicate profiles grouped; there is no overflow counter. Names are terminal-safe and bounded. Pi may clip the status to the available terminal width. Waits do not count separately, and settled uncollected runs are excluded. The status clears when no runs are active and on session replacement. Updates occur on launch and settlement, without polling or animation; display failures cannot affect execution or cleanup.

## Bundled profiles

All bundled profiles inherit the parent's model and have no run deadline.

| Profile | Purpose | Thinking | Tools |
| --- | --- | --- | --- |
| `scout` | Local codebase reconnaissance | low | read, grep, find, ls |
| `reviewer` | Correctness and maintainability review | high | read, grep, find, ls, bash |
| `oracle` | Challenge assumptions and advise | high | read, grep, find, ls |
| `tester` | Exercise real behavior and report evidence | high | read, grep, find, ls, bash |
| `worker` | Implement and verify one bounded task | high | read, grep, find, ls, bash, edit, write |

Reviewer and tester no-edit restrictions are prompt instructions, not enforced write protection. Tester may create bounded test state and short-lived local services, must clean them up, and must not use production credentials or data. Delegation is not a sandbox.

## User profile configuration

The user configuration is `pi-delegator.json` in Pi's agent directory (normally `~/.pi/agent`). Trusted projects may override it with `.pi/pi-delegator.json` in the parent session's directory. Precedence is project → user → bundled.

Top-level fields are `profiles` and boolean `background` (default `false`). They inherit independently; an explicit background value overrides the lower-precedence setting. `{"background": true}` alone is valid and preserves inherited profiles. Empty objects, unknown fields, and nonboolean background values are invalid.

Each entry in `profiles` is either `null` to disable a name or a complete profile definition. Entries replace whole profiles; fields are not merged. For example:

```json
{
  "profiles": {
    "oracle": null,
    "reviewer": {
      "description": "Review correctness and maintainability",
      "model": null,
      "thinking": "high",
      "prompt": "prompts/reviewer.md",
      "tools": ["read", "grep", "find", "ls", "bash"],
      "skills": [],
      "extensions": []
    }
  }
}
```

Required fields are `description`, `model`, `thinking`, `prompt`, `tools`, `skills`, and `extensions`.

- `model`: a selector or `null` to inherit the parent model.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`; Pi may clamp it for the selected model.
- `prompt`: a readable, nonempty UTF-8 Markdown file, at most 64 KiB.
- `tools`: a nonempty list of unique tool names; `delegate` is forbidden.
- `skills`: explicit local Markdown files or directories.
- `extensions`: explicit local JavaScript or TypeScript files.
- Optional `displayName`: trimmed, nonblank, at most 256 UTF-8 bytes. Labels fall back to title-cased hyphen-separated identifiers; tool and result identifiers do not change.
- Optional `deadlineMs`: a positive integer up to 2,147,483,647. Omission or `null` disables the overall run timer.

Paths resolve relative to the configuration file. Capability paths must be readable, supported, canonicalized, and unique; remote sources and pi-delegator itself are rejected. Configuration files are bounded to 16 KiB. Invalid sources prevent registration with corrective diagnostics.

Configuration is immutable for a session; restart Pi after changes. Untrusted project configuration is ignored. Per-call working directories do not select configuration sources.

## Lifecycle and results

- Useful work has no duration limit unless the user configures an overall deadline. Silence alone is not failure.
- Bash command failures and supplied timeouts are recoverable tool errors after safe command-local cleanup. The same delegate may retry or adapt. Earlier background groups remain until whole-session cleanup.
- Cancellation and overall deadline expiry are terminal. Recovery cannot extend a deadline.
- Completion, cancellation, and deadline expiry clean up the captured POSIX session with bounded waits. Unsafe command cleanup is a terminal failure, not a recovered timeout.
- A valid terminal assistant answer can succeed even if the runner must stop a child or drain its pipes afterward. Forced cleanup and verification failures are disclosed.
- Success means the delegation completed, not that every command or the requested task succeeded. Assistant errors, aborts, and protocol violations cannot be disguised as successful answers.
- Failures distinguish invalid input/cwd, unsupported platform, spawn failure, cancellation, overall timeout, cleanup failure, child/model error, missing terminal answer, and protocol error.
- Progress and display observers never control lifecycle or billing. Foreground usage counts toward parent totals; background usage counts once on collection, including failures.
- Uncollected failures send visible diagnostics without triggering a model turn, including without UI. An active waiter owns failure reporting. Ordinary navigation/shutdown cancellation is silent; cleanup failures are still reported.
- Before session switch, fork, tree navigation, or shutdown, cancel owned runs, await bounded cleanup, and clear results. Cancelled navigation leaves the session usable for new runs. Nothing is persisted or resumed.

Returned final text is bounded to 50 KiB with explicit truncation metadata; stderr to a 64 KiB tail; pending JSONL lines to 1 MiB. Progress is a compact summary, not a saved transcript. No full-output artifact is written.

Linux and macOS are supported; macOS requires Python 3 for session identification. Windows fails before launch. Deliberate session escape is outside containment, and abrupt parent death does not guarantee cleanup.

## Scope

Opt-in session-owned background start/wait is supported, not broader orchestration. No delegate resume/fork, nested delegation, workflow DSL or chains, scheduling, inter-agent communication, automatic worktrees, external runners, provider fallback orchestration, acceptance frameworks, fleet dashboards, or durable run registries. Trusted project profiles are supported; untrusted project profiles are not.

See [architecture](DESIGN.md), [testing](IMPLEMENTATION.md), and [verification results](RELEASE_CHECK.md).
