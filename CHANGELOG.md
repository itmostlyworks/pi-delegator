# Changelog

All notable changes to `pi-delegator` are documented here.

## [Unreleased]

### Fixed

- macOS launch and same-session cleanup now use POSIX session IDs via Python 3 instead of the potentially masked `ps sess` field. Requires `python3` on PATH; queries and cleanup remain bounded. Linux keeps its existing session lookup.

## [0.6.5] - 2026-10-03

### Changed

- Launch-gate failures include bounded process/session and platform context plus the failed safety checks, without command lines or environment data.
- Process-group cleanup diagnostics identify the affected group and distinguish verified termination from unverified cleanup.
- Simplified the README around installation, usage, configuration, and limits.

## [0.6.4] - 2026-10-01

### Added

- Optional profile `displayName` for human-facing delegate labels, preserved in progress and result details without changing tool identifiers.

### Changed

- Hyphenated profile identifiers display as readable titles by default (for example, `interaction-designer` becomes `Interaction Designer`).
- Delegate call headers and runner diagnostics use the same profile labels as results.

## [0.6.3] - 2026-09-30

### Changed

- Expanded delegate calls show the full task prompt, preserving line breaks; collapsed calls retain the compact preview.
- Running activity shows eight recent tool starts when expanded and four when collapsed, with earlier-start counts matching the visible window.

## [0.6.2] - 2026-09-30

### Changed

- Running delegate displays refresh on a steady one-second cadence, coalescing tool activity and commentary between ticks while refreshing elapsed time. Initial display and final results remain immediate.
- Display timers are isolated per call and cleared on every settlement path; observer failures do not affect delegation lifecycle. No activity-age indicator or inferred liveness state is shown.

## [0.6.1] - 2026-09-30

### Changed

- Replaced raw delegate invocation rendering with a readable, bounded task preview and spacing after the prompt.
- Running results retain model and thinking metadata above a four-row recent tool-start window with bounded file targets and separated visible assistant commentary. The latest-start marker does not imply that a tool is still executing.
- Sanitized terminal display text; shell commands remain classified, and search patterns and unknown-tool arguments are omitted. Final model-visible responses and subprocess lifecycle behavior are unchanged.

## [0.6.0] - 2026-09-30

### Changed

- Bundled profiles no longer impose a run clock (`timeoutMs: null`). Configured `deadlineMs` may be omitted or `null` to disable the timer; existing positive values remain active, now up to Node's 2,147,483,647 ms timer maximum. No caller deadline input was added.
- A detached `/bin/sh` launch gate captures a distinct, unmasked opaque `ps sess` key before execing Pi. Completion, parent cancellation, and opted-in deadlines scan and signal all live same-session groups with bounded `ps` calls/output and TERM → KILL windows; unusable keys fail early.
- Each Bash operation uses a non-detached privileged supervisor with monitor mode enabled to launch a normal Bash job (`+m`) in its own PGID within the session, identified by a private fd 3 handshake bounded to 1 second. Command timeout cleans up only that job group and returns a recoverable Pi tool error; earlier background groups remain until whole-session cleanup. Parent abort remains terminal. Post-exit drainage remains bounded to 100 ms.
- Unverified command containment/cleanup exits with reserved code 86 (`cleanup_failed`); abort exits 87 (`cancelled`). There is no delegate `tool_timeout` failure code. Command-local cleanup does not cover deliberate regrouping within a command, and session escape remains excluded.

At release time, native macOS session-key behavior and live-provider smoke tests had not been verified. Current results are in [the verification report](docs/RELEASE_CHECK.md).

## [0.5.6] - 2026-09-09

### Fixed

- Keep ordinary Bash subprocesses in the delegate-owned process group so background commands are cleaned up after completion, timeout, and cancellation.
- Bound Bash post-exit output drainage and remove stream listeners at settlement.

### Changed

- A private Bash implementation takes precedence over configured Bash overrides. Bash-supplied timeout or abort now ends the whole delegation to ensure cleanup; custom Pi `shellPath` is not applied.

## [0.5.5] - 2026-09-05

### Changed

- Delegate progress now includes a bounded, whitespace-normalized preview of the latest non-empty assistant text alongside accumulated tool activity.

## [0.5.4] - 2026-09-05

### Fixed

- Delegated model tokens and cost, including usage incurred before a failed run, now contribute to Pi's parent session and footer totals.

## [0.5.3] - 2026-08-30

### Changed

- Reworked the README around the public npm release with package links, npm-first installation, update and removal commands, a shorter quick start, and version-neutral release guidance.

## [0.5.2] - 2026-08-30

### Fixed

- Transient assistant errors no longer trigger delegate cleanup while Pi is waiting to retry the provider call; a later successful retry now supersedes the failed attempt.
- Queued continuations invalidate stale terminal candidates and semantic-drain timers so later turns are not interrupted or replaced by earlier output.

## [0.5.1] - 2026-08-30

### Fixed

- Final responses truncated at the 50 KiB output limit now include explicit truncation metadata and the original byte size.
- Oversized tool-result JSONL events are now drained and discarded within the existing 1 MiB pending-line bound, allowing later terminal answers to survive large browser, image, or command results.

### Changed

- Moved the npm package to `@mostlyworks/pi-delegator` and the repository to the `itmostlyworks` GitHub organization.

## [0.5.0] - 2026-08-29

### Added

- Added complete user-level and trusted-project delegate profiles with project → user → bundled precedence, atomic replacement, custom names, and explicit disabling.
- Added validated explicit local skills and extensions while retaining ambient capability isolation and the model-facing tool allowlist boundary.
- Added configurable profile descriptions, models, thinking levels, prompts, tools, capabilities, and package-bounded deadlines.

### Changed

- Replaced the legacy partial `{ model, thinking }` user configuration with complete profile definitions. Legacy configuration now fails early with migration guidance.
- Made effective profile registries immutable per session and isolated project discovery from delegate-call working directories.

## [0.4.0] - 2026-08-29

### Added

- Added a fixed `tester` profile for bounded real-behavior verification with high thinking, bash-based runtime exercise, no edit/write tools, and explicit side-effect cleanup requirements.

## [0.3.1] - 2026-08-29

### Changed

- Replaced transient assistant and tool-start progress messages with a compact accumulating tool-call count and bounded recent tool-start order.

## [0.3.0] - 2026-08-29

### Changed

- Removed the model-facing per-call `timeoutMs` input. Every delegate now receives its fixed profile deadline, preventing guessed short deadlines from discarding useful work.

## [0.2.0] - 2026-08-28

### Changed

- Removed the model-facing per-call `thinking` input. Delegate thinking now comes only from user-level profile configuration or the built-in profile default.

## [0.1.0] - 2026-08-27

### Added

- One foreground `delegate` tool with fixed scout, reviewer, oracle, and worker profiles.
- Per-call and user-level model and thinking defaults with strict precedence and validation.
- Optional per-call deadlines that may shorten, but never extend, profile limits.
- Fresh Pi subprocesses with sessions, extension discovery, and skill discovery disabled.
- Bounded JSONL parsing, progress updates, usage aggregation, stderr capture, and final-output truncation.
- Compact TUI result metadata showing the selected delegate profile, model, thinking level, and duration.
- Deterministic POSIX process-group cleanup with cancellation, wall-clock deadlines, TERM-to-KILL escalation, and post-exit/semantic-completion drainage guards.
- Process-based lifecycle, protocol, configuration, profile, and concurrency tests using a fake Pi executable.
- Installation, usage, limitations, and manual real-Pi smoke-test documentation.

[0.5.6]: https://github.com/itmostlyworks/pi-delegator/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/itmostlyworks/pi-delegator/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/itmostlyworks/pi-delegator/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/itmostlyworks/pi-delegator/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/itmostlyworks/pi-delegator/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/itmostlyworks/pi-delegator/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/itmostlyworks/pi-delegator/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/itmostlyworks/pi-delegator/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/itmostlyworks/pi-delegator/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/itmostlyworks/pi-delegator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/itmostlyworks/pi-delegator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/itmostlyworks/pi-delegator/releases/tag/v0.1.0
