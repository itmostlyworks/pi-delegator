# pi-delegator

A small, reliability-first delegation extension for [Pi](https://github.com/earendil-works/pi-mono).

`pi-delegator` gives the parent agent one narrow capability: run one bounded task in a fresh Pi subprocess and return its result. It is deliberately not a workflow engine, scheduler, mission manager, or persistent agent fleet.

## Status

The current implementation is complete. The deterministic test suite covers launch, protocol parsing, cancellation, timeouts, process-tree cleanup, profile isolation, configuration, and concurrent calls. Live-provider checks remain a manual release step; see [`docs/SMOKE_TEST.md`](docs/SMOKE_TEST.md).

## Requirements

- Pi with an authenticated model provider
- Node.js 22.19.0 or newer
- macOS or Linux

Windows is rejected before launch because equivalent process-tree termination is not implemented.

## Installation

Pi packages execute with full system access. Review this package before installing it.

Install the current Git repository:

```bash
pi install git:github.com/itmostlyworks/pi-delegator
```

Install the pinned `v0.5.1` release:

```bash
pi install git:github.com/itmostlyworks/pi-delegator@v0.5.1
```

After publication to npm, the equivalent command is:

```bash
pi install npm:@mostlyworks/pi-delegator@0.5.1
```

For local development:

```bash
git clone https://github.com/itmostlyworks/pi-delegator.git
cd pi-delegator
npm install
pi install "$PWD"
```

Start a new Pi session after installation. Remove the package with the matching source, for example:

```bash
pi remove git:github.com/itmostlyworks/pi-delegator
```

## Usage

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

| Profile | Purpose | Tools | Default thinking | Deadline |
| --- | --- | --- | --- | ---: |
| `scout` | Fast codebase reconnaissance | `read`, `grep`, `find`, `ls` | `low` | 3 minutes |
| `reviewer` | Correctness and maintainability review | `read`, `grep`, `find`, `ls`, `bash` | `high` | 10 minutes |
| `oracle` | Challenge assumptions and advise | `read`, `grep`, `find`, `ls` | `high` | 10 minutes |
| `tester` | Exercise real feature behavior and report evidence | `read`, `grep`, `find`, `ls`, `bash` | `high` | 20 minutes |
| `worker` | Implement one bounded change | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | `high` | 20 minutes |

Only `worker` receives the dedicated `edit` and `write` tools. Reviewer receives `bash`, but its fixed role prompt restricts shell use to read-only inspection and validation; reviewer and oracle prompts explicitly forbid modifications. Tester may run bounded application, test, API, CLI, and installed browser-automation commands and create temporary runtime state, but it must not edit source or configuration files and must clean up its processes and test state.

### Inputs and precedence

- `task` is required, must not be blank, and is limited to 32 KiB of UTF-8.
- `cwd` defaults to the parent session directory and must be an existing directory.
- `model` uses a Pi `provider/model` selector and is limited to 256 UTF-8 bytes.
- Deadlines are fixed by the effective profile and cannot be changed by the calling agent.
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
      "deadlineMs": 600000
    },
    "docs": {
      "description": "Inspect and improve documentation",
      "model": null,
      "thinking": "medium",
      "prompt": "prompts/docs.md",
      "tools": ["read", "grep", "find", "ls", "edit", "write"],
      "skills": [],
      "extensions": [],
      "deadlineMs": 1200000
    }
  }
}
```

`null` disables a name. An object atomically replaces any bundled profile of the same name and must contain every field shown; profiles never inherit or merge fields. `model: null` inherits the parent model. Prompt and capability paths resolve relative to the configuration file. `skills` accepts explicit local Markdown skill files or skill directories; `extensions` accepts explicit local JavaScript or TypeScript extension files. Remote package sources are not supported. Deadlines are positive integers capped at 20 minutes. `delegate` cannot appear in `tools`, and `extensions` cannot load pi-delegator itself.

Configuration is validated and loaded once per session. Missing, unreadable, unsupported, or duplicate capability paths and invalid or legacy partial configuration prevent delegation with an actionable source/profile diagnostic. Start a new Pi session after editing it.

Trusted projects may provide the same complete document at `.pi/pi-delegator.json`. Project entries take precedence over user entries, including `null` disables; untrusted project configuration is ignored. Project discovery is fixed to the parent session directory and trust context—a delegate call's `cwd` cannot select another configuration source.

### TUI output

Delegate results show the selected profile, model selector, thinking level, and duration above the returned text. The model reflects call, effective-profile, and parent-session precedence; thinking comes from the effective profile. Pi may still resolve a fuzzy model selector or clamp thinking to the selected model's capabilities. The collapsed view uses the model ID and bounds the output preview by both lines and text length; expand the tool result to see the full provider/model selector and complete returned text.

This metadata is display-only. The model-visible tool result remains the delegate's bounded response text.

## Lifecycle and limits

Each call launches exactly one foreground child in a dedicated POSIX process group. The child uses an ephemeral session and disables ambient extension and skill discovery; only the selected profile's explicit local capabilities are added back. This prevents ambient child behavior and direct reloading of pi-delegator through configured tools or extension paths. Explicit extensions remain trusted executable code and may launch their own subprocesses. The child still receives Pi's normal coding prompt and trusted project instructions.

The runner enforces a hard wall-clock deadline and propagates parent cancellation to the entire process group using bounded TERM → KILL cleanup. It does not wait exclusively for stdio to close, so descendants holding pipes open cannot leave the tool pending indefinitely. A validated terminal answer remains successful if forced post-answer cleanup is required, and cleanup details are returned with the tool result.

Model-visible output is bounded:

- final response: 50 KiB, with explicit truncation metadata
- stderr tail: 64 KiB
- pending JSONL line: 1 MiB; oversized tool-result events are discarded without discarding the run
- progress: compact accumulating tool-call count and recent tool-start order

## Deliberate limitations

v0.5.1 does not provide background runs, resume or fork, chains, retries, workflow DSLs, inter-agent communication, nested delegation, worktrees, provider fallback, durable registries, or Windows support.

## Development

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The automated tests use a fake Pi executable and make no provider calls. Run the [manual smoke test](docs/SMOKE_TEST.md) separately before a release.

## Documentation

- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — scope and acceptance criteria
- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and lifecycle contract
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — staged implementation and lifecycle matrix
- [`docs/SMOKE_TEST.md`](docs/SMOKE_TEST.md) — manual real-Pi release checks
- [`docs/SMOKE_TEST_RESULTS.md`](docs/SMOKE_TEST_RESULTS.md) — recorded release-candidate smoke runs
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## License

[MIT](LICENSE)
