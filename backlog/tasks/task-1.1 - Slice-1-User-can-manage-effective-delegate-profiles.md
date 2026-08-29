---
id: TASK-1.1
title: 'Slice 1: User can manage effective delegate profiles'
status: Done
assignee: []
created_date: '2026-08-29 10:47'
updated_date: '2026-08-29 14:06'
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
- [x] #1 With no configuration, the five bundled profiles remain available with unchanged behavior.
- [x] #2 User configuration can add, replace, and disable profiles; the delegate tool advertises only the resulting effective names and descriptions and launches each with its complete configured behavior.
- [x] #3 A per-call model override affects only that invocation; later and concurrent calls retain their profile defaults.
- [x] #4 Legacy, incomplete, malformed, or unsafe configuration prevents delegation and reports the configuration source, profile, and corrective action.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built
Added an immutable user-scoped effective profile registry across `src/agents.ts`, `src/config.ts`, and `src/index.ts`. Complete profiles can now add, replace, or disable names, drive the advertised tool schema, and launch with configured prompt, model, thinking, tools, and bounded deadline; tests and public documentation cover the new contract.

## Decisions
- Retained 20 minutes as the package-controlled maximum configured deadline and bounded custom prompts at 64 KiB.
- Complete profile definitions never merge; `model: null` inherits the parent model, while per-call model overrides remain invocation-local.
- Tool names remain open to future extension tools but must be bounded identifiers, unique, non-empty, and cannot include `delegate`.

## Deferrals
- Non-empty explicit skill and extension loading remains TASK-1.2.
- Trusted project-level profile precedence and session switching remain TASK-1.3.
<!-- SECTION:NOTES:END -->
