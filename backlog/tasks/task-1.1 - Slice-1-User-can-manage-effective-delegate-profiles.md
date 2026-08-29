---
id: TASK-1.1
title: 'Slice 1: User can manage effective delegate profiles'
status: To Do
assignee: []
created_date: '2026-08-29 10:47'
labels: []
dependencies: []
parent_task_id: TASK-1
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Part of TASK-1.

## What this slice delivers

Users can define the complete effective delegate registry at user scope: add custom profiles, atomically replace bundled profiles, or disable names. The delegate tool exposes that registry and launches profiles with their configured prompt, model, thinking, tools, and bounded deadline.

## Out of scope for this slice

- Project-level profile configuration.
- Loading non-empty custom skill or extension lists; these fields must be present as empty arrays.
- Dynamic configuration reload within a session.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With no configuration, the five bundled profiles remain available with unchanged behavior.
- [ ] #2 User configuration can add, replace, and disable profiles; the delegate tool advertises only the resulting effective names and descriptions and launches each with its complete configured behavior.
- [ ] #3 A per-call model override affects only that invocation; later and concurrent calls retain their profile defaults.
- [ ] #4 Legacy, incomplete, malformed, or unsafe configuration prevents delegation and reports the configuration source, profile, and corrective action.
<!-- AC:END -->
