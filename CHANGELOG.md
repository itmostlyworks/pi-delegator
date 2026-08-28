# Changelog

All notable changes to `pi-delegator` are documented here.

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

[0.3.1]: https://github.com/ludwigbacklund/pi-delegator/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ludwigbacklund/pi-delegator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ludwigbacklund/pi-delegator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ludwigbacklund/pi-delegator/releases/tag/v0.1.0
