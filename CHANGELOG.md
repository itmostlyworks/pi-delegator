# Changelog

All notable changes to `pi-delegator` are documented here.

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
