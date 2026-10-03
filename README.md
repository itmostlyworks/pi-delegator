# pi-delegator

A [Pi](https://github.com/earendil-works/pi-mono) extension that adds a `delegate` tool. It runs a task in a fresh Pi subprocess and returns the answer to the calling agent, keeping the delegate's working context separate.

## Install

```bash
pi install npm:@mostlyworks/pi-delegator
```

Start a new Pi session. Requires an authenticated model provider, Node.js 22.19.0+, and Linux or macOS. Windows is not supported.

## Use

Ask Pi:

```text
Use the scout delegate to find the files that implement authentication.
```

Five profiles are included:

| Profile | Task |
| --- | --- |
| `scout` | Find relevant files and understand the codebase |
| `reviewer` | Review correctness and maintainability |
| `oracle` | Give a second opinion on an approach |
| `tester` | Run tests and check actual behavior |
| `worker` | Make a code change and verify it |

The tool accepts `agent`, `task`, and optional `model` and `cwd`:

```ts
delegate({
  agent: "reviewer",
  task: "Review the current diff for bugs"
})
```

By default, delegates use the parent's model and working directory. Independent calls can run concurrently. Pi shows progress, then the returned answer; delegate token usage and cost count toward the parent session's totals.

## Configuration and limits

Add, replace, or disable profiles in `~/.pi/agent/pi-delegator.json`. Trusted projects can override them in `.pi/pi-delegator.json`. Profiles configure the model, thinking level, prompt, tools, and explicit skills or extensions. Restart Pi after changes. See the [configuration reference](docs/REQUIREMENTS.md#user-profile-configuration).

Delegates do not inherit ambient extensions or skills. Runs are foreground-only, with no nested delegation, saved sessions, or resume. Cancelling a call stops the delegate and its owned subprocesses. Cleanup and returned output are bounded. This is not a sandbox; delegates have local system access through their allowed tools.

Optional run deadlines and recovery from Bash command timeouts are implemented in Git but not yet released on npm. See the [changelog](CHANGELOG.md) and [design](docs/DESIGN.md) for details.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests use a fake Pi executable, with no provider calls.

[MIT](LICENSE)
