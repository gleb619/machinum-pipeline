# @mt/core

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
  .subflow(otherPipeline)   // inline, same Runner
  .fork(subPipeline)        // child Runner + checkpoint subtree
  .batch(5)
  .to('md://./output.md')
```

### `uri.ts` — `UriRegistry`
Singleton `registry`. Sources and targets registered by scheme; resolved by `resolveSource(uri)` / `resolveTarget(uri)`.
Composite schemes (e.g. `git://`) wrap another scheme.

### `engine/runner.ts` — `Runner`
Main execution loop. Methods: `start()`, `pause()`, `resume()`, `unpause()`. Manages state machine, checkpoint writes, event log, dead-letter.

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
