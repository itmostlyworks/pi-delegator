# pi-delegator

A small, reliability-first delegation extension for [Pi](https://github.com/earendil-works/pi-mono).

`pi-delegator` gives the parent agent one narrow capability: run one bounded task in a fresh Pi subprocess and return its result. It is deliberately not a workflow engine, scheduler, mission manager, or persistent agent fleet.

## Status

The v0.1.0 implementation is complete. The deterministic test suite covers launch, protocol parsing, cancellation, timeouts, process-tree cleanup, profile isolation, configuration, and concurrent calls. Live-provider checks remain a manual release step; see [`docs/SMOKE_TEST.md`](docs/SMOKE_TEST.md).

## Requirements

- Pi with an authenticated model provider
- Node.js 22.19.0 or newer
- macOS or Linux

Windows is rejected before launch because equivalent process-tree termination is not implemented.

## Installation

Pi packages execute with full system access. Review this package before installing it.

Install the current Git repository:

```bash
pi install git:github.com/ludwigbacklund/pi-delegator
```

Install a pinned release after the `v0.1.0` tag is available:

```bash
pi install git:github.com/ludwigbacklund/pi-delegator@v0.1.0
```

After publication to npm, the equivalent command is:

```bash
pi install npm:pi-delegator@0.1.0
```

For local development:

```bash
git clone https://github.com/ludwigbacklund/pi-delegator.git
cd pi-delegator
npm install
pi install "$PWD"
```

Start a new Pi session after installation. Remove the package with the matching source, for example:

```bash
pi remove git:github.com/ludwigbacklund/pi-delegator
```

## Usage

Ask Pi to delegate a focused task:

```text
Use the scout delegate to identify the files that implement authentication.
```

The extension registers one model-facing tool:

```ts
delegate({
  agent: "scout" | "reviewer" | "oracle" | "worker",
  task: "Inspect the authentication flow and identify the relevant files",
  model: "anthropic/claude-sonnet-4-5", // optional
  thinking: "medium",                  // optional
  cwd: "/path/to/project",             // optional
  timeoutMs: 120_000                    // optional; may only shorten the profile limit
})
```

The parent agent may issue independent `delegate` calls in the same turn to run them concurrently. There is intentionally no package-specific parallel or workflow API.

### Profiles

| Profile | Purpose | Tools | Default thinking | Maximum deadline |
| --- | --- | --- | --- | ---: |
| `scout` | Fast codebase reconnaissance | `read`, `grep`, `find`, `ls` | `low` | 3 minutes |
| `reviewer` | Correctness and maintainability review | `read`, `grep`, `find`, `ls`, `bash` | `high` | 10 minutes |
| `oracle` | Challenge assumptions and advise | `read`, `grep`, `find`, `ls` | `high` | 10 minutes |
| `worker` | Implement one bounded change | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | `high` | 20 minutes |

Only `worker` receives the dedicated `edit` and `write` tools. Reviewer receives `bash`, but its fixed role prompt restricts shell use to read-only inspection and validation; reviewer and oracle prompts explicitly forbid modifications.

### Inputs and precedence

- `task` is required, must not be blank, and is limited to 32 KiB of UTF-8.
- `cwd` defaults to the parent session directory and must be an existing directory.
- `model` uses a Pi `provider/model` selector and is limited to 256 UTF-8 bytes.
- `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `timeoutMs` must be positive and can only shorten the selected profile's deadline.
- Model precedence is call override → user profile default → parent session model.
- Thinking precedence is call override → user profile default → built-in profile default.

## User defaults

Optional per-profile defaults live at `~/.pi/agent/pi-delegator.json`, or under the directory selected by `PI_CODING_AGENT_DIR`:

```json
{
  "scout": {
    "model": "anthropic/claude-sonnet-4-5",
    "thinking": "medium"
  },
  "reviewer": {
    "thinking": "high"
  }
}
```

Only the four built-in profile names and the `model` and `thinking` fields are accepted. Invalid configuration prevents the extension from starting with an actionable error. Configuration is loaded once at extension startup; start a new Pi session after editing it.

Project-local delegate configuration and custom profiles are not discovered.

### TUI output

Delegate results show the selected profile, model selector, thinking level, and duration above the returned text. These are the effective launch settings after call, user-default, and parent-session precedence; Pi may still resolve a fuzzy model selector or clamp thinking to the selected model's capabilities. The collapsed view uses the model ID and bounds the output preview by both lines and text length; expand the tool result to see the full provider/model selector and complete returned text.

This metadata is display-only. The model-visible tool result remains the delegate's bounded response text.

## Lifecycle and limits

Each call launches exactly one foreground child in a dedicated POSIX process group. The child uses an ephemeral session and disables extension and skill discovery, preventing recursive delegation and ambient child behavior. It still receives Pi's normal coding prompt and trusted project instructions.

The runner enforces a hard wall-clock deadline and propagates parent cancellation to the entire process group using bounded TERM → KILL cleanup. It does not wait exclusively for stdio to close, so descendants holding pipes open cannot leave the tool pending indefinitely. A validated terminal answer remains successful if forced post-answer cleanup is required, and cleanup details are returned with the tool result.

Model-visible output is bounded:

- final response: 50 KiB, with explicit truncation metadata
- stderr tail: 64 KiB
- pending JSONL line: 1 MiB
- progress: compact tool-start and assistant-message summaries

## Deliberate limitations

v0.1.0 does not provide background runs, resume or fork, chains, retries, workflow DSLs, inter-agent communication, nested delegation, project-defined profiles, worktrees, provider fallback, durable registries, or Windows support.

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
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## License

[MIT](LICENSE)
