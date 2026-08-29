---
id: TASK-1.3
title: 'Slice 3: Trusted projects can manage delegate profiles'
status: Done
assignee: []
created_date: '2026-08-29 10:47'
updated_date: '2026-08-29 14:32'
labels: []
dependencies:
  - TASK-1.1
parent_task_id: TASK-1
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Part of TASK-1.

## What this slice delivers

Trusted parent projects can add, atomically replace, or disable profiles with project → user → bundled precedence. Project configuration is scoped to the parent session and cannot be selected through a delegate call's working directory.

## Out of scope for this slice

- Loading profile configuration from the delegate call's cwd.
- In-session dynamic configuration reload.
- Per-call prompt, capability, thinking, or deadline overrides.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A trusted project can add, replace, and disable profiles, with complete project entries taking precedence over user and bundled entries.
- [x] #2 An untrusted project cannot influence the effective profile set or delegated child behavior.
- [x] #3 Changing a delegate call's cwd does not load configuration from that directory or alter the parent session's effective profiles.
- [x] #4 Starting or switching to a session in a different trusted project exposes that project's effective profile set without mutating other sessions.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built
Trusted parent sessions now load `.pi/pi-delegator.json` after Pi resolves project trust, applying complete project entries over user and bundled profiles. Session-scoped tool schemas and tests cover trusted precedence, untrusted isolation, delegate-cwd isolation, and independent project sessions; user-facing and design documentation now describe the behavior.

## Decisions
- Project configuration is resolved only from the parent session's `ctx.cwd` using Pi's `CONFIG_DIR_NAME`; delegate-call `cwd` remains execution-only.
- User profiles are loaded at extension construction, while project profiles and the effective tool schema are resolved during `session_start`, when `ctx.isProjectTrusted()` is authoritative.

## Deferrals
- Dynamic configuration reload within an active session remains out of scope.
<!-- SECTION:NOTES:END -->
