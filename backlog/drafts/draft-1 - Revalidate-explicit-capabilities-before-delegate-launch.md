---
id: DRAFT-1
title: Revalidate explicit capabilities before delegate launch
status: Draft
assignee: []
created_date: '2026-08-29 14:48'
labels:
  - learning
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Friction
Explicit capability paths are canonicalized and validated at session startup, but a writable trusted path can be replaced before a delegate launch.

## Proposed change
Retain each capability's validated filesystem identity and revalidate it immediately before spawning a delegate. Fail with an actionable diagnostic if the path's identity or supported file type changed. Define whether ordinary in-session file-content edits remain allowed.

## Why it matters
A child can otherwise load code different from what configuration validation inspected. This is not currently an authorization bypass, but tightening the check/use seam would make explicit loading more deterministic.

## Rough cost
medium

## Surfaced in
- src/config.ts
- src/runner.ts
- TASK-1 security review
<!-- SECTION:DESCRIPTION:END -->
