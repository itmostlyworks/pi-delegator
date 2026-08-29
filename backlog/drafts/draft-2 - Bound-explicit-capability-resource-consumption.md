---
id: DRAFT-2
title: Bound explicit capability resource consumption
status: Draft
assignee: []
created_date: '2026-08-29 14:50'
labels:
  - learning
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Friction
Explicit extension file size and skill-directory contents are not bounded, so trusted capabilities may cause high startup CPU or memory use despite the wall-clock deadline.

## Proposed change
Define package-controlled size and count limits for explicit extension files and skill-directory contents. Validate those limits before launch and report the source path, profile, exceeded limit, and corrective action.

## Why it matters
The run deadline bounds elapsed time but not peak memory or CPU during capability discovery and loading. Accidentally oversized trusted capabilities can undermine predictable startup behavior.

## Rough cost
medium

## Surfaced in
- src/config.ts
- TASK-1 security review
<!-- SECTION:DESCRIPTION:END -->
