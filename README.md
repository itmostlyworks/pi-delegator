# pi-delegator

A small, reliability-first delegation extension for [Pi](https://github.com/earendil-works/pi-mono).

[Pi package page](https://pi.dev/packages/@mostlyworks/pi-delegator) · [npm](https://www.npmjs.com/package/@mostlyworks/pi-delegator) · [Source](https://github.com/itmostlyworks/pi-delegator)

`pi-delegator` gives the parent agent one narrow capability: run one focused task in a fresh Pi subprocess and return its result. It is deliberately not a workflow engine, scheduler, mission manager, or persistent agent fleet.

- Five focused profiles: scout, reviewer, oracle, tester, and worker
- Optional configured run deadlines, parent cancellation, and bounded session cleanup
- Fresh child sessions with ambient extension and skill discovery disabled
- Bounded model-visible output and stderr diagnostics

## Status

`pi-delegator` is publicly available on npm. Optional deadlines and command recovery are implemented locally but not yet released on npm. Its deterministic test suite covers launch, protocol parsing, cancellation, timeouts, session cleanup, profile isolation, configuration, and concurrent calls. See the [changelog](CHANGELOG.md) for release history.

## Requirements

- Pi with an authenticated model provider
- Node.js 22.19.0 or newer
- macOS or Linux

Windows is rejected before launch because equivalent process-tree termination is not implemented.

## Installation

Pi packages execute with full system access. Review the [source](https://github.com/itmostlyworks/pi-delegator) before installing it.

Install the latest release from npm:

```bash
pi install npm:@mostlyworks/pi-delegator
```

Start a new Pi session after installation. To update or remove the package later:

```bash
pi update npm:@mostlyworks/pi-delegator
pi remove npm:@mostlyworks/pi-delegator
```

Version-pinned npm installs are supported by appending `@<version>` to the package name. General package updates intentionally skip pinned versions.

### Install from Git

Install the current Git repository:

```bash
pi install git:github.com/itmostlyworks/pi-delegator
```

Append `@<tag>` to pin a Git release. For local development:

```bash
git clone https://github.com/itmostlyworks/pi-delegator.git
cd pi-delegator
npm install
pi install "$PWD"
```

## Quick start

Ask Pi to delegate a focused task:

```text
Use the scout delegate to identify the files that implement authentication.
```

The extension registers one model-facing tool:

```ts
delegate({
  agent: "scout", // any currently effective profile name
  task: "Inspect the authentication flow and identify the relevant files",
  model: "anthropic/claude-sonnet-4-5", // optional per-call override
  cwd: "/path/to/project"              // optional
})
```

The parent agent may issue independent `delegate` calls in the same turn to run them concurrently. There is intentionally no package-specific parallel or workflow API.

### Profiles

| Profile | Purpose | Tools | Default thinking | Run deadline |
| --- | --- | --- | --- | --- |
| `scout` | Fast codebase reconnaissance | `read`, `grep`, `find`, `ls` | `low` | none |
| `reviewer` | Correctness and maintainability review | `read`, `grep`, `find`, `ls`, `bash` | `high` | none |
| `oracle` | Challenge assumptions and advise | `read`, `grep`, `find`, `ls` | `high` | none |
| `tester` | Exercise real feature behavior and report evidence | `read`, `grep`, `find`, `ls`, `bash` | `high` | none |
| `worker` | Implement one bounded change | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | `high` | none |

Only `worker` receives the dedicated `edit` and `write` tools. Reviewer receives `bash`, but its fixed role prompt restricts shell use to read-only inspection and validation; reviewer and oracle prompts explicitly forbid modifications. Tester may run bounded application, test, API, CLI, and installed browser-automation commands and create temporary runtime state, but it must not edit source or configuration files and must clean up its processes and test state.

### Inputs and precedence

- `task` is required, must not be blank, and is limited to 32 KiB of UTF-8.
- `cwd` defaults to the parent session directory and must be an existing directory.
- `model` uses a Pi `provider/model` selector and is limited to 256 UTF-8 bytes.
- The calling agent cannot set a deadline. Only an explicit positive `deadlineMs` in the effective profile enables an overall run timer.
- Model precedence is call override → effective profile default → parent session model.
- Thinking is not a tool input; it comes from the effective profile.

## Profile configuration

The five bundled profiles above remain available without configuration. To add, completely replace, or disable profiles, create `~/.pi/agent/pi-delegator.json` (or the equivalent under `PI_CODING_AGENT_DIR`):

```json
{
  "profiles": {
    "scout": null,
    "reviewer": {
      "description": "Review with our preferred model",
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "high",
      "prompt": "prompts/reviewer.md",
      "tools": ["read", "grep", "find", "ls", "bash"],
      "skills": [],
      "extensions": [],
      "deadlineMs": null
    },
    "docs": {
      "description": "Inspect and improve documentation",
      "model": null,
      "thinking": "medium",
      "prompt": "prompts/docs.md",
      "tools": ["read", "grep", "find", "ls", "edit", "write"],
      "skills": [],
      "extensions": [],
      "deadlineMs": null
    }
  }
}
```

`null` disables a name. An object atomically replaces any bundled profile of the same name and must contain all fields shown except optional `deadlineMs`; profiles never inherit or merge fields. `model: null` inherits the parent model. Prompt and capability paths resolve relative to the configuration file. `skills` accepts explicit local Markdown skill files or skill directories; `extensions` accepts explicit local JavaScript or TypeScript extension files. Remote package sources are not supported. Omit `deadlineMs` or set it to `null` to disable the overall run timer. Explicit positive integer values (including those in existing configurations) remain active, up to Node's timer maximum of 2,147,483,647 ms. `delegate` cannot appear in `tools`, and `extensions` cannot load pi-delegator itself.

Configuration is validated and loaded once per session. Missing, unreadable, unsupported, or duplicate capability paths and invalid or legacy partial configuration prevent delegation with an actionable source/profile diagnostic. Start a new Pi session after editing it.

Trusted projects may provide the same complete document at `.pi/pi-delegator.json`. Project entries take precedence over user entries, including `null` disables; untrusted project configuration is ignored. Project discovery is fixed to the parent session directory and trust context—a delegate call's `cwd` cannot select another configuration source.

### TUI output

Delegate results show the selected profile, model selector, thinking level, and duration above the returned text. The model reflects call, effective-profile, and parent-session precedence; thinking comes from the effective profile. Pi may still resolve a fuzzy model selector or clamp thinking to the selected model's capabilities. The collapsed view uses the model ID and bounds the output preview by both lines and text length; expand the tool result to see the full provider/model selector and complete returned text.

While running, the chat shows a readable task preview (the complete task when expanded), the same model/thinking header, up to four recent tool starts when collapsed or eight when expanded with bounded relative file targets, and a bounded preview of the latest visible assistant commentary. The arrow marks the latest observed start, not proof that the tool is still executing. Shell commands are classified rather than displayed verbatim; search patterns and unknown-tool arguments are omitted. The display appears immediately, then refreshes once per second with elapsed time and the latest observed activity. Tool starts and completed assistant messages update stored progress without triggering extra renders between ticks. The final result appears immediately when the call settles, and the heartbeat stops. This is not a child/provider health check: silence does not imply a stalled run.

This metadata is display-only. The model-visible tool result remains the delegate's bounded response text. Delegated model usage is attached to Pi's tool result, so its tokens and cost are included in the parent session's footer and usage totals.

## Lifecycle and limits

Each call launches one foreground Pi child in its own POSIX session, with ephemeral conversation state and ambient extension/skill discovery disabled. Only the selected profile's explicit local capabilities and a private Bash extension are loaded. Pi's normal coding prompt and trusted project instructions still apply.

**No overall deadline applies by default.** A positive configured `deadlineMs` opts into one. Command failures and supplied Bash timeouts are recoverable: after the timed-out command group is cleaned up, the same delegate can retry or adapt. Earlier background commands are not stopped by that timeout. Parent cancellation and Bash abort remain terminal.

Completion, cancellation, and an opted-in run deadline clean up all owned same-session process groups with bounded TERM → KILL escalation. Cleanup/drain waits and output stay bounded even without a run deadline. Unsafe or unverifiable cleanup prevents successful recovery. It reports `cleanup_failed`, or accompanies an existing run failure with cleanup diagnostics. The private Bash extension takes precedence over configured Bash overrides and uses `/bin/bash` (or `bash` from `PATH`), not Pi's custom `shellPath`. Post-exit Bash output drains for at most 100 ms; later output is discarded.

This is not a sandbox: deliberately escaping the POSIX session is outside containment, and regrouping inside a command can escape command-local cleanup. Abruptly killing the parent is not equivalent to cancellation. The runner requires usable `ps sess` identifiers and fails early without them. Native macOS verification remains outstanding; see the [design](docs/DESIGN.md) and [smoke checks](docs/SMOKE_TEST.md).

### Output bounds

Model-visible output is bounded:

- final response: 50 KiB, with explicit truncation metadata
- stderr tail: 64 KiB
- pending JSONL line: 1 MiB; oversized tool-result events are discarded without discarding the run
- progress: accumulating tool-start count, eight retained recent starts (four displayed when collapsed) with bounded file targets, and a bounded preview of the latest visible assistant commentary

## Deliberate limitations

`pi-delegator` intentionally does not provide background runs, resume or fork, chains, package-orchestrated whole-run retries, workflow DSLs, inter-agent communication, nested delegation, worktrees, provider fallback, durable registries, or Windows support.

## Development

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The automated tests use a fake Pi executable and make no provider calls.

## Documentation

- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — scope and acceptance criteria
- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and lifecycle contract
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — staged implementation and lifecycle matrix
- [`docs/SMOKE_TEST.md`](docs/SMOKE_TEST.md) — manual real-Pi release checks
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## License

[MIT](LICENSE)
