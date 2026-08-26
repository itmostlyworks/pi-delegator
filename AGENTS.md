# Agent instructions

## Start here

Before changing code, read completely:

1. `README.md`
2. `docs/REQUIREMENTS.md`
3. `docs/DESIGN.md`
4. `docs/IMPLEMENTATION.md`

The scope exclusions are part of the product contract. Do not add features merely because another subagent package has them.

## Product charter

`pi-delegator` is a bounded subprocess runner exposed as one Pi tool. Keep it understandable enough that one engineer can audit the complete launch, timeout, cancellation, parsing, and cleanup path in one sitting.

Optimize in this order:

1. deterministic termination
2. correct success/failure classification
3. small surface area
4. useful diagnostics
5. presentation

Do not trade lifecycle reliability for richer orchestration.

## Pi references

Read Pi documentation and examples before using an API; do not guess extension behavior.

- Extension documentation:
  `/Users/ludwigbacklund/.nodenv/versions/26.5.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Official subagent example:
  `/Users/ludwigbacklund/.nodenv/versions/26.5.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`

The official example demonstrates discovery, child invocation, JSON-mode parsing, and tool registration. Its process lifecycle is not sufficient for this project: it has no mandatory wall-clock timeout and only signals the direct child. Reuse ideas, not those failure semantics.

For targeted lifecycle reference only, inspect these installed `pi-subagents` files when needed:

- `/Users/ludwigbacklund/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/subagent-runner.ts`
- `/Users/ludwigbacklund/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/owned-process-tree.ts`
- `/Users/ludwigbacklund/.pi/agent/npm/node_modules/pi-subagents/src/shared/post-exit-stdio-guard.ts`

Do not copy its workflow, persistence, reconciliation, intercom, or artifact architecture.

## Engineering rules

- TypeScript, ESM, strict typing.
- Prefer Node built-ins and Pi exports. Add dependencies only when their value is clear.
- Use `node:test` unless the repository establishes another test runner before implementation begins.
- Spawn with `shell: false` and argument arrays.
- Child runs must disable extension and skill discovery to prevent recursion and ambient behavior.
- Never wait exclusively on the child `close` event; descendants may keep pipes open.
- Bound pending JSONL lines, returned output, and stderr diagnostics.
- Use one idempotent finalization path for normal completion, timeout, parent abort, spawn error, protocol error, and forced cleanup.
- Timers and abort listeners must always be removed during finalization.
- Errors from the model-facing tool must be thrown or returned using Pi's actual error semantics; do not invent an `isError` return field and assume it works.
- Do not claim Windows support until process-tree termination is implemented and tested there. Fail early with an actionable message instead.
- Do not create sessions or write run artifacts in the target repository.
- Keep temporary prompts private (`0600`) and clean them up best-effort.

## Scope guard

V1 must not include:

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
- project-controlled custom agent profiles

If implementation seems to require one of these, stop and explain the requirement before expanding scope.

## Change discipline

- Search before reading large files.
- Make the smallest coherent change.
- Add or update tests for lifecycle behavior.
- Run typecheck and tests before declaring completion.
- Review the final diff for feature creep and unbounded waits.
- Report commands run with exit codes and any behavior that remains unverified.
