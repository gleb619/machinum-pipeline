# @mt/core

← [Architecture](../architecture.md)

Path: `packages/core/`

Core is the engine library — it contains all types, the DSL, the URI registry, and the Runner. Nothing in `core/` may import from any other `@mt/*` package.

## Public API (`src/index.ts`)

Re-exports everything needed by consumers:
- `definePipeline`, `defineTool`, `defineSource`, `defineTarget` (DSL builders)
- `Envelope`, `Source`, `Target`, `Tool`, `Pipeline`, `Lifecycle`, `RunState` (types)
- `GlobalContext`, `RunContext`, `ToolContext`, `SourceContext`, `TargetContext` (contexts)
- `UriRegistry`, `registry`, `registerSource`, `registerTarget`, `resolveSource`, `resolveTarget` (URI)
- `Runner`, `Store`, `Cache`

## Key Modules

### `domain.ts`
Plain interfaces only: `Book`, `Chapter`, `Paragraph`, `Line`. No classes, no methods. Sources provide stable IDs.

### `types.ts`
Core interface shapes:
```typescript
interface Envelope<T> { item: T; items?: T[]; meta: { chapterId?; paragraphId?; lineId?; [k]: unknown } }
interface Source<T> { uri: string; lifestyle: Lifecycle; start(ctx): AsyncIterable<Envelope<T>>; resume?(ctx, cursor) }
interface Target<T> { uri: string; open(ctx): Promise<void>; write(env, ctx): Promise<void>; close(ctx): Promise<void> }
interface Tool<I, O> { name: string; version: string; invoke(env, ctx): Promise<Envelope<O>>; exec?; cacheable?; idempotent? }
```

### `contexts.ts`
Three-level chain. Each context holds a backref to its parent — never a copy. Do not spread or clone contexts.
- `GlobalContext` — mt.json config, store root, logger
- `RunContext` — runId, pipeline ref, extends GlobalContext
- `ToolContext` / `SourceContext` / `TargetContext` — step-level, extends RunContext

### `dsl.ts` — `PipelineBuilder`
Fluent chain. The builder itself implements `Pipeline`, so it can be a `default export` without calling `.to()`.
```typescript
definePipeline()
  .from('jsonl://./input.jsonl')
  .flatMap(async (item) => [...])
  .tap(async (item) => { /* logging */ })
  .use(myTool)
  .subflow(otherPipeline)   // inline nested pipeline, same Runner
  .fork(subPipeline)        // child pipeline per envelope, checkpoint subtree
  .batch(5)
  .to('md://./output.md')
```

### `uri.ts` — `UriRegistry`
Singleton `registry`. Sources and targets registered by scheme; resolved by `resolveSource(uri)` / `resolveTarget(uri)`.
Composite schemes (e.g. `git://`) wrap another scheme. Named URI aliases from mt.json (`"uris": { "en": "md://./chapters/en" }`)
expand bare scheme-less strings at resolution time (in `resolveSource`/`resolveTarget` via optional settings, and in the
Runner, which has `GlobalContext.settings`). Registered schemes win over alias keys; alias chains are capped at
`MAX_URI_ALIAS_DEPTH` (10) with cycle detection.

### `engine/runner.ts` — `Runner`
Main execution loop. Methods: `start()`, `pause()`, `resume()`, `unpause()`. Manages state machine, checkpoint writes, event log, dead-letter.

One recursive builder drives every level of nesting:

```
buildStream(pipeline, input, runContext) → AsyncIterable<Envelope>
```

`input` is the stream entering the step chain (`null` at the top level). Each step either
replaces or extends that stream: `source` starts a new one, `tool`/`batch`/`window`/`flatmap`/
`tap`/`fork`/`subflow` map it, `target` consumes it into a sink. `fork` and `subflow` call
`buildStream` again with the child pipeline, so nested pipelines support **every** DSL op — not
just tools. Nested runs extend the checkpoint path (`<stepId>/fork-<n>`, `<stepId>/subflow`) and
inherit the run context (same `runId`, logger scoped to the node).

### `engine/checkpoint.ts`
Checkpoint tree walker. Key functions: `createRootCheckpoint()`, `walkTree()`, `findFirstNonDone()`, `markDone()`, `markFailed()`, `addChild()`.

### `engine/state-machine.ts` — `RunStateMachine`
State transitions: `pending → running → checkpoint → paused → resumed → done / failed`.
Use `canTransition()` before `transition()`.

### `engine/child-process.ts`
`spawnChildProcess()` / `runChildProcess()` — serialize envelope to JSON → write to child stdin → read JSON from stdout. Supports npx, deno, bun exec modes.

### `engine/cache.ts` — `Cache`
Content-hash keyed memoisation. `computeKey(tool, envelope)` → `has/get/set/delete/clear`.

### `store.ts` — `Store`
Atomic file I/O under `.mt/`. All writes: write to temp file → `fs.rename()`. `readJson/writeJson/append/appendLines/exists/ensureDir`.

## Adding a New Built-in Source

1. Create `packages/core/src/builtins/<scheme>-source.ts` implementing `Source<T>`
2. Register in `uri.ts` via `registry.registerSource('<scheme>', factory)`
3. Write tests in `packages/core/tests/`
4. Export from `src/index.ts`

## Dependency Rule

`core/` has **zero** external runtime dependencies beyond Node.js stdlib. No `axios`, no `zod`, no framework deps.

---

## Checkpoint Tree Replay Rules

The checkpoint tree is walked depth-first. Nodes marked `done` are skipped. The first non-done node is resumed. Sibling forks are sequential by status: a later fork (e.g. `fork:2`) is **not** started until all earlier siblings (`fork:0`, `fork:1`) reach a terminal state (`done` or `failed`). This prevents out-of-order side effects across branches.

## Concurrency Primitives

- **In-process**: per-step limiter (`p-limit`-style), configurable via URI query param (`concurrency`), DSL, or global defaults.
- **Out-of-process**: tools with `exec: 'npx' | 'deno' | 'bun'` run in a child process started as
  `<runtime> <runtime argv> engine/worker <tool.module> <tool.name>` — `module` is required whenever
  `exec !== 'inproc'`. The child speaks one NDJSON protocol for both modes: the `ToolContext` is the
  first stdin line, then one `<Envelope>` per line; the worker answers with one `<Envelope>` or
  `{"error":"…"}` per line (non-zero exit on error). See [tools.md](../tools.md#out-of-process-tools-exec).
  Under bun the pipeline id cannot be inferred from the stack (`Error.prepareStackTrace` call sites are
  unavailable) — pass an explicit `id` to `definePipeline()`.
- **Fork (`.fork`)**: runs the child pipeline **per parent envelope** — the envelope is fed into
  `buildStream(child.steps, [envelope], childCtx)` and the child's output is merged back into the
  parent stream. One checkpoint node per envelope (`<stepId>/fork-<n>`). A `target` inside the
  child makes it a sink: results are written there and nothing flows back to the parent.
- **Subflow (`.subflow`)**: in-process, same Runner, two modes selected by what the sub-pipeline
  declares — **never** by URI scheme:
  - **Inline** — sub-pipeline has no `source` step (steps only). Its steps are spliced into the
    parent stream, so data flows parent → child → parent.
  - **Self-contained** — sub-pipeline declares its own `source`. It runs as a nested pipeline on
    its own data after the upstream stream is consumed; the parent stream passes through unchanged.
    Subflows therefore run in declaration order, and an orchestration-only parent (no `source` /
    `target` of its own) is valid.

`.batch(n)` groups envelopes into `items[]` (`item` holds the same array) and flushes the
remainder at end of stream; `.window(n)` emits the same shape but slides one item per arrival, so
consecutive groups overlap.

## Retry & Error Policy

```typescript
type RetryStrategy = 'fixed' | 'linear' | 'exp';
interface RetryPolicy { max: number; backoffMs: number; strategy: RetryStrategy; }
type ErrorPolicy = 'fail-run' | 'skip-item' | 'dead-letter';
```

Merge order (highest wins): **tool step > pipeline > global (`mt.json`)**.

`dead-letter` writes the offending envelope + error to `.mt/runs/<id>/dead-letter.jsonl`.

## Caching

When `tool.cacheable === true`, output is memoised by `hash(toolName + version + input + relevantContext)` at `.mt/cache/<hash>.json`. Replay reads the cached envelope and skips invocation. Cache is project-scoped and never required for correctness — it is a performance optimization only.
