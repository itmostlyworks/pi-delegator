# First implementation agent handover

Copy the prompt below into the first coding-agent session.

---

You are implementing the first version of `pi-delegator` in:

`/Users/ludwigbacklund/projects/pi-delegator`

The repository currently contains design documentation but no implementation. Build v0.1.0 as a small, reliability-first Pi extension.

Before writing code, read these files completely in order:

1. `AGENTS.md`
2. `README.md`
3. `docs/REQUIREMENTS.md`
4. `docs/DESIGN.md`
5. `docs/IMPLEMENTATION.md`

Then inspect the official Pi extension documentation and subagent example referenced by `AGENTS.md`. Follow the current installed Pi APIs rather than guessing them. The official example is a mechanism reference only: do not reproduce its unbounded process wait or direct-child-only cancellation.

Your task is to implement the documented V1 end-to-end:

- initialize the TypeScript/npm Pi package;
- register the single `delegate` tool;
- implement the documented fixed profiles;
- spawn fresh foreground Pi children with extensions, skills, and sessions disabled;
- parse bounded JSONL output;
- enforce profile wall-clock deadlines;
- propagate parent cancellation;
- terminate the complete POSIX process group with bounded TERM → KILL escalation;
- prevent descendants holding pipes open from hanging the tool;
- preserve a valid terminal answer when forced post-completion cleanup is needed;
- return compact bounded results and diagnostics;
- add deterministic process-based tests using a fake Pi executable;
- document installation, usage, supported platforms, and verification commands.

Work in stages from `docs/IMPLEMENTATION.md`, but continue through the complete V1 unless blocked by a real API or product decision. Keep the implementation small. Do not add async runs, workflow scripts, resume/fork, intercom, worktrees, custom project profiles, agent management, external runners, dashboards, or persistence.

Important constraints:

- One delegate call launches exactly one child.
- `timeoutMs` may shorten but never lengthen the role default.
- Scout uses low thinking and has no `bash` or write tools.
- Tester may exercise bounded runtime behavior through `bash` but has no `edit` or `write` tools.
- Worker is the only source-mutating role.
- Use `shell: false` and explicit argument arrays.
- Never await only the child `close` event.
- All completion paths must pass through one idempotent finalizer.
- Bound task size, pending protocol lines, stderr, and returned output.
- Fail clearly on Windows rather than silently weakening process-tree guarantees.
- Do not write run artifacts into the delegated repository.

Verification requirements:

1. Run typecheck and all tests.
2. Exercise the lifecycle matrix in `docs/IMPLEMENTATION.md` as far as deterministic local fixtures allow.
3. Review the final diff for unbounded waits, leaked listeners/timers, shared mutable run state, and feature creep.
4. Report files changed, commands run with exit codes, tests added, manual checks performed, and any remaining unverified behavior.

If current Pi behavior contradicts the design, pause only for a material public-API or safety decision. For a normal implementation detail, choose the smaller reliable option, document it, and continue.

---
