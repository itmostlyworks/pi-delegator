# Agent instructions

## Start here

Before changing code, read completely:

1. `README.md`
2. `docs/REQUIREMENTS.md`
3. `docs/DESIGN.md`
4. `docs/IMPLEMENTATION.md`

The scope exclusions are part of the product contract. Do not add features merely because another subagent package has them.

## Product charter

`pi-delegator` is a focused subprocess runner exposed as one Pi tool. Keep it understandable enough that one engineer can audit the complete launch, cancellation, parsing, recovery, and cleanup path in one sitting.

Bound cleanup waits and output, not useful work by default. Subcommand failures and timeouts should be recoverable after safe cleanup. Overall run deadlines are optional user-controlled safeguards, not mandatory profile budgets. Keep verification outcomes in `docs/RELEASE_CHECK.md`, not repeated throughout the product documentation.

Optimize in this order:

1. reliable cancellation and bounded cleanup
2. correct success/failure classification, including recoverable tool errors
3. small surface area
4. useful diagnostics
5. presentation

Do not trade lifecycle reliability for richer orchestration.

## Pi references

Read Pi documentation and examples before using an API; do not guess extension behavior.

Locate `docs/extensions.md` and `examples/extensions/subagent/` in the installed `@earendil-works/pi-coding-agent` package. Use the example for API patterns, not process containment: direct-child signalling is insufficient for this project's cleanup guarantees.

## Engineering rules

- TypeScript, ESM, strict typing.
- Prefer Node built-ins and Pi exports. Add dependencies only when their value is clear.
- Use `node:test`.
- Spawn with `shell: false` and argument arrays.
- Child runs must disable extension and skill discovery to prevent recursion and ambient behavior.
- Never wait exclusively on the child `close` event; descendants may keep pipes open.
- Bound pending JSONL lines, returned output, and stderr diagnostics.
- Use one idempotent finalization path for normal completion, an explicitly enabled run deadline, parent abort, spawn error, protocol error, and forced cleanup. Do not turn a recoverable command timeout into whole-run finalization.
- Timers and abort listeners must always be removed during finalization.
- Errors from the model-facing tool must be thrown or returned using Pi's actual error semantics; do not invent an `isError` return field and assume it works.
- Do not claim Windows support until process-tree termination is implemented and tested there. Fail early with an actionable message instead.
- Do not create sessions or write run artifacts in the target repository.
- Keep temporary prompts private (`0600`) and clean them up best-effort.

## Scope guard

Do not add:

- async/background runs
- resume or fork
- chains or a workflow DSL
- missions or schedules
- inter-agent communication
- nested delegation
- worktree management
- external runners
- acceptance/gate frameworks
- provider fallback orchestration
- fleet dashboards
- durable run registries
- untrusted project-controlled agent profiles

If implementation seems to require one of these, stop and explain the requirement before expanding scope.

## Change discipline

- Search before reading large files.
- Make the smallest coherent change.
- Add or update tests for lifecycle behavior.
- Run typecheck and tests before declaring completion.
- Review the final diff for feature creep and unbounded cleanup or drainage waits. An active run without an opted-in deadline is not itself a lifecycle bug. Same-session groups must be cleaned on completion, cancellation, and opted-in deadline; deliberate session escape remains outside containment.
- Report commands run with exit codes and any behavior that remains unverified.
