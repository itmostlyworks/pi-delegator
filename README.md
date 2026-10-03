# pi-delegator

A [Pi](https://github.com/earendil-works/pi-mono) extension that adds a `delegate` tool. It runs a task in a fresh Pi subprocess and returns the answer to the calling agent, keeping the delegate's working context separate.

## Install

```bash
pi install npm:@mostlyworks/pi-delegator
```

Start a new Pi session. Requires an authenticated model provider, Node.js 22.19.0+, and Linux or macOS. On macOS, Python 3 must also be available as `python3` on PATH. Windows is not supported.

## Demo

https://github.com/user-attachments/assets/05cfbc05-2d72-40ca-b65e-f8cc33a4ef12

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

Delegates do not inherit ambient extensions or skills. Runs are foreground-only, with no nested delegation, saved sessions, or resume. Cancellation performs bounded cleanup of the delegate's captured process session; cleanup failures are reported. Deliberate session escape is not contained, and abrupt parent death does not guarantee cleanup. Returned output is bounded. This is not a sandbox; delegates have local system access through their allowed tools. Reviewer and tester no-edit restrictions are prompt instructions, not enforced write protection.

Run deadlines are optional (`deadlineMs` in a profile). Delegates can recover from Bash command failures and timeouts after command cleanup, then continue working.

See [verification results](docs/RELEASE_CHECK.md) for the exercised lifecycle checks.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests use a fake Pi executable, with no provider calls.

## Releasing

Update `CHANGELOG.md`, bump the package and lockfile versions, and commit. Create an annotated `v<version>` tag matching `package.json`, then push the commit and tag. The [release workflow](.github/workflows/release.yml) runs typecheck, tests, and a package dry-run before publishing to npm and creating a GitHub Release with generated notes.

One-time npm setup: configure the package's GitHub Actions trusted publisher with owner `itmostlyworks`, repository `pi-delegator`, and workflow filename `release.yml`, allowing direct `npm publish`. No npm token secret is needed. Publishing requires this setup before pushing a new release tag.

Failed workflow runs can be rerun: already-published npm versions and existing GitHub Releases are skipped. Never move a published tag or reuse its version for different contents; skipping an existing version does not verify its contents. Registry or GitHub API failures stop the workflow rather than being treated as missing releases. This workflow does not publish existing tags retroactively.

[MIT](LICENSE)
