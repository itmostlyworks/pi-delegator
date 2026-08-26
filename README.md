# pi-delegator

A small, reliability-first delegation extension for [Pi](https://github.com/earendil-works/pi-mono).

`pi-delegator` gives the parent agent one narrow capability: run a bounded task in a fresh Pi subprocess and return its result. It is deliberately not a workflow engine, scheduler, mission manager, or persistent agent fleet.

## Status

Stages 1 and 2 are implemented: the package registers a bounded Scout-only `delegate` path with deterministic POSIX process-tree cleanup and process-based lifecycle tests. The remaining profiles, progress polish, and package release polish are still planned in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

Read these before implementing later stages:

1. [`AGENTS.md`](AGENTS.md) — repository rules for coding agents
2. [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — product scope and acceptance criteria
3. [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and lifecycle contract
4. [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — staged implementation and test plan
5. [`HANDOVER.md`](HANDOVER.md) — copy-paste prompt for the first implementation agent

## Intended interface

The extension registers one model-facing tool:

```ts
delegate({
  agent: "scout" | "reviewer" | "oracle" | "worker",
  task: "Inspect the authentication flow and identify the relevant files",
  cwd: "/path/to/project",
  timeoutMs: 120_000
})
```

One call launches one child. Pi already supports parallel sibling tool execution, so the parent can launch multiple independent delegates without a second workflow language.

## V1 principles

- Fresh subprocess context only
- Foreground tool calls only
- Every run has a hard wall-clock deadline
- Parent cancellation terminates the whole child process group
- A valid terminal answer is not discarded merely because the child process fails to drain
- Compact output and bounded diagnostics
- No recursive extension loading
- No durable background state
- macOS and Linux first; fail clearly on unsupported process-control platforms

## Planned package shape

```text
pi-delegator/
├── agents/
│   ├── oracle.md
│   ├── reviewer.md
│   ├── scout.md
│   └── worker.md
├── docs/
├── src/
│   ├── agents.ts
│   ├── index.ts
│   ├── process-tree.ts
│   ├── protocol.ts
│   └── runner.ts
├── test/
├── AGENTS.md
├── HANDOVER.md
├── package.json
└── README.md
```

This layout is guidance, not a requirement. Prefer fewer modules when boundaries do not earn their keep.
