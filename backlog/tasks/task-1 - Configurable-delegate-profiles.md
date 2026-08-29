---
id: TASK-1
title: Configurable delegate profiles
status: To Do
assignee: []
created_date: '2026-08-29 09:29'
updated_date: '2026-08-29 09:40'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Pi-delegator’s five fixed profiles are suitable defaults, but they prevent public users and projects from adapting delegates to their models, prompts, tools, skills, extensions, and runtime needs.

## Why now

A public release needs to support different user environments and workflows without requiring forks, while retaining the extension’s reliability-first execution model.

## Success criteria

- Users can override, disable, and add profiles through user-level configuration.
- Trusted projects can override, disable, and add profiles through project-level configuration.
- Profile precedence is project → user → bundled, with complete profile definitions rather than inheritance or field merging.
- Profiles can configure their description, model, thinking, prompt, tool allowlist, explicit skills, explicit extensions, and finite deadline.
- The five current profiles remain available as bundled defaults unless overridden or disabled.
- The `delegate` tool exposes the effective profile set and continues accepting only profile, task, optional model, and optional cwd.
- Invalid configuration fails early with precise, actionable diagnostics.
- Custom skills and extensions load explicitly and cannot enable nested delegation.
- Automated tests cover precedence, overrides, disabling, custom profiles, capability isolation, validation, and concurrent execution.

## Constraints

- Lifecycle reliability remains non-configurable: one foreground child, process-group isolation, cancellation propagation, bounded TERM → KILL cleanup, finite hard deadline ceilings, bounded protocol/output, private prompt handling, and deterministic finalization.
- Children must not load pi-delegator or otherwise gain nested delegation.
- Project profiles load only through Pi’s existing project-trust boundary.
- Custom profiles are complete and explicit; there is no `extends` mechanism.
- Per-call model overrides continue to affect only that invocation.

## Non-goals

- Profile inheritance, composition, or prompt merging.
- Background execution, workflows, retries, chains, resume/fork, or durable state.
- Making lifecycle safety limits arbitrarily removable.
- Exposing every profile property as a per-call override.

## Design

### Data model

- A profile source is a bounded JSON document containing a `profiles` map.
- Each profile name maps to either:
  - `null`, which disables that name and masks lower-precedence definitions; or
  - a complete profile definition containing `description`, `model`, `thinking`, `prompt`, `tools`, `skills`, `extensions`, and `deadlineMs`.
- `model: null` means the delegate inherits the parent session model unless the invocation supplies its existing per-call model override.
- Profile definitions never inherit or merge fields. For each name, the highest-precedence entry replaces or disables the complete lower-precedence entry.
- Effective precedence is project → user → bundled.
- The resolved effective registry is immutable for each session. Deadlines must be finite, positive, and no greater than a package-controlled hard ceiling; lifecycle and cleanup limits are not configurable.

### Contracts

- User configuration remains at the Pi agent directory’s `pi-delegator.json`.
- Project configuration is read from the parent Pi session’s project configuration directory only when `ctx.isProjectTrusted()` is true.
- Delegate `cwd` does not affect profile discovery, precedence, or trust.
- Relative prompt, skill, and extension paths resolve from the configuration file’s directory. Only explicit local filesystem paths are supported.
- `prompt` identifies a non-empty Markdown file. `skills` and `extensions` are explicit path arrays.
- The `delegate` tool continues accepting only `agent`, `task`, optional `model`, and optional `cwd`.
- The tool exposes the current effective profile names and descriptions; `agent` accepts only an effective profile name.
- Per-call `model` overrides only the selected invocation and does not mutate the effective registry.
- Invalid source documents, complete definitions, paths, names, thinking levels, tool lists, or deadlines fail before a delegate launches, with the source path and profile name in the diagnostic.

### Architecture

- Profile resolution is session-scoped and occurs after Pi resolves project trust. Session changes rebuild and expose a new immutable effective registry.
- Child capability discovery remains disabled with `--no-extensions` and `--no-skills`. Configured extensions and skills are then added through Pi’s explicit CLI flags.
- A profile’s tool allowlist remains the final model-facing capability boundary across built-in and explicitly loaded extension tools.
- Profiles may not allowlist `delegate`, and configured extensions may not explicitly load pi-delegator itself.
- Arbitrary extension internals are trusted executable code and are not statically audited for subprocess behavior.
- Existing process-group isolation, cancellation, TERM → KILL cleanup, bounded protocol/output, private prompt handling, deterministic finalization, and package-controlled hard ceilings remain unchanged.

### Migration & compatibility

- The existing partial `{ model, thinking }` configuration format is replaced without a compatibility window.
- Legacy configuration fails with an actionable diagnostic describing the required complete-profile format.
- The migration is reversible by restoring or editing the user configuration file; it does not modify stored data or run artifacts.

### Out of scope for the skeleton

- Profile inheritance, `extends`, composition, and field-level merging.
- Remote npm/git capability sources or automatic installation.
- Profile configuration selected from the delegate call’s `cwd`.
- Dynamic configuration reload within a session.
- Per-call prompt, tools, skills, extensions, thinking, or deadline overrides.
- Static auditing of arbitrary third-party extension implementation behavior.
<!-- SECTION:DESCRIPTION:END -->
