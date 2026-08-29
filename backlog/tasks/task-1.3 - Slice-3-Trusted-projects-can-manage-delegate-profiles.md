---
id: TASK-1.3
title: 'Slice 3: Trusted projects can manage delegate profiles'
status: To Do
assignee: []
created_date: '2026-08-29 10:47'
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
- [ ] #1 A trusted project can add, replace, and disable profiles, with complete project entries taking precedence over user and bundled entries.
- [ ] #2 An untrusted project cannot influence the effective profile set or delegated child behavior.
- [ ] #3 Changing a delegate call's cwd does not load configuration from that directory or alter the parent session's effective profiles.
- [ ] #4 Starting or switching to a session in a different trusted project exposes that project's effective profile set without mutating other sessions.
<!-- AC:END -->
