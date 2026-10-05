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
- `start` returns a session-local `runId` immediately, not a final answer. IDs increase monotonically within the registry as `run-1`, `run-2`, etc.; collection and `cancelAll` do not reset the counter. A fresh session registry starts at `run-1`. The session owns the child after the call returns.
- `wait` accepts only `action` and a nonblank `runId` (schema length 1–64), and collects the final answer or throws the failure once. Unknown/already-collected IDs and concurrent waits for the same ID fail.
- At most 32 uncollected background runs are retained, including completed successes and failures. Collection frees a slot; completion alone does not.
- Cancelling `wait` leaves the run session-owned and available for another wait; it does not abort the child or collect usage.
- With background disabled (the default), the original closed foreground schema is unchanged. When enabled, the schema remains one closed root object, not a union; action-dependent field combinations are validated at execution before launch or collection.

### Background presentation

Background execution uses existing Pi tool/result cards and custom failure messages, not a dashboard. Background call rows are operation-only (`Delegate · Start` or `Delegate · Wait`). The already-returned start card is static while work runs: profile display name, short badge (`#1` for `run-1`), model/thinking, and Started status use foreground-equivalent heading formatting, without live activity, elapsed time, or usage repaint. Both collapsed and expanded starts show the full original terminal-safe task, preserving whitespace and line breaks without compression or truncation, with a blank line separating heading and task. Original task text comes from Pi's saved call arguments, bounded by the input limit, not a second registry copy. Model selectors use the same compact/expanded formatting. There is no periodic start invalidation; the start tool itself is finished, not pending. One settlement invalidation replaces the start with a compact Completed/Failed summary and duration, never a second answer. Completed means delegation finished, not that the requested task necessarily succeeded.

An admitted pending wait owns foreground-equivalent bounded tool/activity progress and an elapsed-time heartbeat through `onUpdate`, using the profile/badge/model/thinking heading and compact or expanded activity layout without duplicating the original task prompt. Without a pending wait there is no live activity. Wait collects once and alone displays the answer or diagnostics; successful collected headers show duration and failed ones say Failed. Collected expanded results show model/thinking, usage, and cleanup. Start cards and custom failure messages show exact collection instructions only when expanded and applicable. Model-facing content retains the full run ID. Saved details retain identity and a terminal-safe task preview capped at 240 codepoints plus a truncation ellipsis, preserving whitespace and line breaks. This bounded preview is used only when original call arguments are unavailable. Without matching live state or a card-local terminal summary, historical starts show Started (inactive) with the saved call's original task or that fallback preview, never fabricated live status. The settlement observer and admitted-wait progress subscription are separate and bounded within the existing registry. The start observer only invalidates once on settlement and is then released; wait progress and heartbeat stop on settlement or wait cancellation. Collection, navigation, and shutdown also release observers, subscriptions, and timers. Observers cannot affect lifecycle, collection, or billing; runner cleanup is unchanged. Foreground presentation is unchanged.

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

The only top-level fields are `profiles` and optional boolean `background`. Background defaults to `false`; omission inherits the lower-precedence setting, while explicit `true` or `false` overrides it. Profiles and background resolve independently with trusted project → user → bundled precedence. A background-only file such as `{"background": true}` is supported and preserves inherited profiles. An empty root object, unknown top-level fields, or a nonboolean background value is invalid.

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
- Progress is observational, not completion authority. Foreground usage and cost are included in parent totals. Background usage is included only on collection by `wait`, once, for both successful and failed results; `start`, failure notifications, and uncollected results do not add usage.
- Uncollected background failures send a displayable custom diagnostic with `triggerTurn: false`, including without an interactive UI. An active waiter owns failure reporting instead. Diagnostics never control lifecycle.
- Before session switch, fork, or tree navigation, all owned background runs are cancelled, runner finalizers are awaited, and the registry is cleared. If another extension cancels the transition, the current session can start new runs without another session-start event; previous IDs are gone.
- Session shutdown cancels owned runs, awaits bounded runner cleanup, and clears the registry. Ordinary lifecycle cancellation is not announced as an uncollected failure; cleanup and other non-cancellation failures are still reported while closing. Results are session-local and never persisted or resumed.

Returned final text is bounded to 50 KiB with explicit truncation metadata; stderr to a 64 KiB tail; pending JSONL lines to 1 MiB. Progress is a compact summary, not a saved transcript. No full-output artifact is written.

Linux and macOS are supported; macOS requires Python 3 for session identification. Windows fails before launch. Deliberate session escape is outside containment, and abrupt parent death does not guarantee cleanup.

## Scope

Opt-in session-owned background start/wait is supported, not broader orchestration. No delegate resume/fork, nested delegation, workflow DSL or chains, scheduling, inter-agent communication, automatic worktrees, external runners, provider fallback orchestration, acceptance frameworks, fleet dashboards, or durable run registries. Trusted project profiles are supported; untrusted project profiles are not.

See [architecture](DESIGN.md), [testing](IMPLEMENTATION.md), and [verification results](RELEASE_CHECK.md).
