---
id: TASK-1.2
title: 'Slice 2: User can explicitly load profile capabilities'
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

Users can grant a profile explicit local skills and extensions while ambient discovery stays disabled. Delegated children receive only the configured, allowlisted capabilities, preserving per-call isolation and the nested-delegation boundary.

## Out of scope for this slice

- Project-level profile configuration.
- Remote npm or git capability sources and automatic installation.
- Static auditing of arbitrary third-party extension internals.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A profile can load its configured local skills and extensions, and their allowlisted capabilities are available to that delegate.
- [ ] #2 Unconfigured ambient skills and extensions remain unavailable, and a profile cannot expose the delegate tool or explicitly load pi-delegator.
- [ ] #3 Missing, invalid, duplicate, or unsupported capability paths fail before the delegate launches with a precise diagnostic.
- [ ] #4 Concurrent delegates receive only their own configured skills, extensions, and tool allowlists.
<!-- AC:END -->
