---
id: TASK-1.2
title: 'Slice 2: User can explicitly load profile capabilities'
status: Done
assignee: []
created_date: '2026-08-29 10:47'
updated_date: '2026-08-29 14:19'
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
- [x] #1 A profile can load its configured local skills and extensions, and their allowlisted capabilities are available to that delegate.
- [x] #2 Unconfigured ambient skills and extensions remain unavailable, and a profile cannot expose the delegate tool or explicitly load pi-delegator.
- [x] #3 Missing, invalid, duplicate, or unsupported capability paths fail before the delegate launches with a precise diagnostic.
- [x] #4 Concurrent delegates receive only their own configured skills, extensions, and tool allowlists.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built
Added validated explicit local skill and extension loading in `src/config.ts` and repeated Pi capability flags in `src/runner.ts`, while retaining ambient discovery isolation. Updated deterministic configuration/concurrency coverage and the public design and usage documentation.

## Decisions
- Capability paths resolve relative to the source config, canonicalize through realpath, and must be readable local Markdown skill files/directories or JavaScript/TypeScript extension files.
- Duplicate aliases and symlinks are rejected after canonicalization; pi-delegator self-loading is rejected by canonical path and filesystem identity to cover hard links.
- The profile tool allowlist remains the final model-facing boundary for explicitly loaded extension tools.

## Deferrals
- Project-level profile configuration remains TASK-1.3.
- Remote package capability sources and static auditing of third-party extension internals remain out of scope.
<!-- SECTION:NOTES:END -->
