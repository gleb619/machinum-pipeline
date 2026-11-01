# @mt/core

← [Architecture](../guiding/architecture.md)

Path: `packages/core/`

Core is the engine library — it contains all types, the DSL, the URI registry, and the Runner. Nothing in `core/` may import from any other `@mt/*` package.

## Public API (`src/index.ts`)

Re-exports everything needed by consumers:
- `definePipeline`, `defineTool`, `defineSource`, `defineTarget`, `defineWaypoint`, `defineProcess` (DSL builders)
- `defineSuite`, `isPipeline`, `isPipelineSuite` (run several pipelines sync or parallel; see [Suites](#suites))
- `Exchange` (`Envelope` deprecated alias), `Source`, `Target`, `Tool`, `Pipeline`, `Lifecycle`, `RunState` (types)
- `GlobalContext`, `RunContext`, `ToolContext`, `SourceContext`, `TargetContext` (contexts)
- `loadGlobalContext`, `parseEnvFile`, `readMtConfig`, `readMtConfigSync`, `MtConfig`, `DEFAULT_MT_CONFIG` (mt.json → `GlobalContext`)
- `UriRegistry`, `registry`, `Splitter`, `registerSource`, `registerTarget`, `registerSplitter`, `resolveSource`, `resolveTarget`, `resolveSplitter`, `hasSplitter` (URI + splitter registry)
- `Runner`, `Store`, `Cache`

## Key Modules

### `domain.ts`
Plain interfaces only: `Book`, `Chapter`, `Chunk`, `Paragraph` (optional `chunkId` — paragraph of a chunk), `Token` (BPE token of a chunk — alternate descent from `Chunk`, sibling of `Paragraph`), `Line`, `Word`. No classes, no methods. Sources provide stable IDs.

### `exchange.ts`
The data unit is a Camel-style **Exchange** (replaces the bare Envelope; `Envelope<T>` stays as a
deprecated alias of `Exchange<T>`). Modeled on the Java `FlowContext` / `FlowArgument`:
```typescript
type Qualifier = 'new' | 'old' | 'copy' | 'alt'
interface Variable<U> { id; name; qualifier: Qualifier; value: U; timestamp: string; ephemeral: boolean }
interface Exchange<T> { id: string; item: T /* materialized copy of the `item` variable */; items?: T[]; meta: { chapterId?; paragraphId?; lineId?; [k]: unknown }; variables: Variable[] }
interface ExchangeInput<T> { id?; item: T; items?; meta?; variables? }   // loose shape Sources may yield
```
An Exchange is a **plain JSON-serializable object**; all operations are pure free functions returning a NEW exchange:
`createExchange`, `toExchange` (normalizer), `withItem` (derive output from input; pushes the `item` variable), `itemOf` / `oldItemOf` / `itemsOf` (accessors), `withMeta`,
`variable`, `getVariable` / `findVariable` / `getOldVariable` / `hasVariable`, `setVariable(s)`,
`withVariable`, `withoutVariable`, `replaceVariable`, `pushVariable` (current `new` becomes `old`,
the value becomes `new`; Java `push`/`rearrange`), `copyVariable`, `withoutEphemeral`,
`withoutEmpty`, `withoutOldAndEmpty`, `mergeVariables`. Empty = `null`/`undefined`, blank string or
empty array (`isEmptyValue`).

Conventions:
- **`meta` is identity/provenance only** (`chapterId`, `paragraphId`, `lineId`, `chapterNum`,
  `lang`, `filePath`, `parentId`, ...) - things Sources stamp. Anything a tool *computes* (llm config,
  token counts, glossary, summary, `mdOutputs` write intents, ...) is a **variable** with a constant
  name exported from the tool module (`VAR_*`).
- **Tools derive output from input** (`withItem(ex, out)`, `setVariable(ex, ...)`) so `id`, `meta`
  and `variables` propagate. Never rebuild `{ item, meta }` from scratch.
- **The payload is a variable.** `ITEM_VARIABLE = 'item'` (qualifier `new`) is the single source of truth, so
  the payload has the same history as any variable: `withItem(ex, v)` is `pushVariable(ex, 'item', v)` (+ clears
  `items`), the previous payload stays as the `old` item variable (`oldItemOf(ex)`). Design choice (b):
  `ex.item` stays as a materialized convenience field (~345 `.item` call sites; plain-JSON and spread-friendly)
  kept in sync by every helper (`createExchange`, `withItem`, `withVariable` family, `toExchange`,
  `fromPersisted`); `fromPersisted`/`itemOf` rebuild `item` from the variable (variable wins), `toPersisted`
  never writes an `item` field. `toExchange` treats a literal whose `item` field differs from its variable
  (`{ ...env, item: x }`) as a payload edit and pushes it (history kept); prefer `withItem`. `items` (batch
  list) stays a plain field (`itemsOf(ex)` = `items ?? [item]`) and is persisted as-is. Item variables (new+old)
  are excluded from `hashableVariables`/cache keys and from `mergeVariables` (batch/flatMap build their own);
  cache keys hash the payload via `ex.item`, so equal payloads hash equally regardless of history. The `item`
  variable is never ephemeral and survives `withoutEmpty`/`withoutOldAndEmpty`/`withoutEphemeral`/`withoutVariable`.
- **Persistence contract: `meta` is in-flight only; `variables` are persisted.** `toPersisted(ex)` /
  `fromPersisted(p)` define the persisted form `{ id, items?, variables }` (the payload is the `item` variable, no separate `item` field): `meta` is dropped
  (rehydrates as `{}`), ephemeral variables are dropped, all other variables keep id/qualifier/timestamp.
  Where it applies: dead-letter entries (`dead-letter.jsonl`) and the `jsonl://` target write the persisted
  form. Checkpoints (`state.json`) and `events.jsonl` hold no exchange payload at all; resume replays from the
  Source cursor, so `meta` is re-derived by the Source and variables are recomputed by the tools. Exceptions:
  the tool cache (`.mt/cache/`) is keyed by `meta` + non-ephemeral variables and stores the tool output as-is
  (a hit only occurs for identical meta, so it stays consistent); `mt tool` stdin/stdout is process-to-process
  interchange (in-flight), so it carries `meta`. Rule for authors: anything that must survive
  pause/resume/dead-letter goes in a variable.
- The Runner calls `toExchange` at every boundary (source output, after each tool), so literals
  without `id`/`variables` still work from Sources; a missing `id` is minted as `ex-<n>`.
- Engine: `batch` get a new `batch-<n>` id and **merge variables** (later wins on
  name+qualifier clash), meta of the first item; `flatMap` and `split` children inherit the parent's
  variables, get id `<parentId>.<n>` and `meta.parentId`. Cache keys hash `item/items/meta` + non-ephemeral
  variables (`id` and ephemeral variables excluded). Dead-letter writes the full exchange.

### `types.ts`
Core interface shapes (`I`/`O` are **payload** types wrapped in an Exchange):
```typescript
interface Source<T> { uri: string; lifestyle: Lifecycle; start(ctx): AsyncIterable<ExchangeInput<T>>; resume?(ctx, cursor) }
interface Target<T> { uri: string; open(ctx): Promise<void>; write(ex: Exchange<T>, ctx): Promise<void>; close(ctx): Promise<void>; checkpoint?(ctx): Promise<number | undefined> }
interface Tool<I, O> { name: string; version: string; mdDescription: string; invoke(ex: Exchange<I>, ctx): Promise<Exchange<O>>; cacheable?; idempotent? }
```

### `contexts.ts`
Three-level chain. Each context holds a backref to its parent — never a copy. Do not spread or clone contexts.
- `GlobalContext` — mt.json config, store root, logger
- `RunContext` — runId, pipeline ref, extends GlobalContext
- `ToolContext` / `SourceContext` / `TargetContext` — step-level, extends RunContext

### `config.ts` — `loadGlobalContext(projectRoot)`
The only `GlobalContext` builder: `mt.json` merged over `DEFAULT_MT_CONFIG`, top-level `uris` copied to
`settings.uris`, and `secrets.envFile` (default `.env`) read into `env`. Missing `mt.json` yields defaults;
a malformed one throws naming the file path. `env` never overrides a key already set in `process.env` and never
writes back into it. `mt run`, `mt resume` and the admin start route all call it — no caller hand-rolls a context.

`imports?: string[]` pulls in extra config files (e.g. a gitignored `mt.local.json` with the remote ollama
URL / model): each file is deep-merged over `mt.json` in order (objects key by key, arrays and scalars
replaced, later wins, so local overrides committed). Paths resolve relative to the importing file, nested
imports work (cycles are skipped), a missing file is skipped, a malformed one throws naming it. The key is
dropped from the result. `readMtConfig` (async) and `readMtConfigSync` (module-load-time readers such as
`pickLlmTool`) both apply it, so `loadGlobalContext` and the picker see the same merged settings. `.env`
(`secrets.envFile`) cannot do this job: it only reaches `ctx.env` (URL/model at call time), not the picker's
`MT_LLM_TOOL` / `MT_LLM_MODEL`, which are read from `process.env` when the pipeline module loads.

`scripts?: LifecycleScripts` (`Partial<Record<'install' | 'start' | 'end' | 'stop' | 'exit' | 'resume' | 'error', string>>`) declares lifecycle
hook pipelines: paths to pipeline module files (relative to the project root) run by the CLI —
`mt install` runs `scripts.install`; `mt run` runs `scripts.start` before and `scripts.end` after the run, plus `scripts.error` on failure, `scripts.stop` on SIGINT pause, and `scripts.exit` before process exit; `mt resume` runs `scripts.resume` before resuming;
main pipeline. The raw config (incl. `scripts`) is read with `readMtConfig(projectRoot)` — no merging
over defaults, missing file yields `{}`.

### `dsl.ts` — `PipelineBuilder`
Fluent chain. The builder itself implements `Pipeline`, so it can be a `default export` without calling `.to()`.
```typescript
definePipeline()
  .from('chunks://ladder')
  .subflow('#paragraphs')   // 1→N split; same as 'paragraphs://' (bare 'paragraphs' is rejected)
  .flatMap(async (item) => [...])
  .tap((env) => { /* logging: receives the full Exchange incl. meta + variables; async OK */ })
  .use(myTool)
  .subflow(otherPipeline)   // inline nested pipeline, same Runner
  .fork(subPipeline)        // child pipeline per envelope, checkpoint subtree
  .batch(5)
  .to('md://./output.md')
```

**DSL method reference:**

| Method | Signature | Effect |
|---|---|---|
| `definePipeline()` | `definePipeline({ id?, retry?, onError? }?)` | Entry point — creates the builder. `id` defaults to the pipeline filename (parent dir for `index.ts`/`pipeline.ts`); defaults: `retry { max: 3, backoffMs: 1000, strategy: 'exp' }`, `onError: 'fail-run'`. |
| `defineSuite()` | `defineSuite(pipelines, { id?, mode? }?)` | Wraps pipelines into a runnable suite (`mode` defaults to `'sync'`); call `await suite.run()`. |
| `.from()` | `.from(Source<T> \| string)` | Sets the Source. URI string (resolved via the registry; a named `mt.json` alias defers to the Runner at run time) or instance (carried through as-is — what lets `defineWaypoint` wrappers reach the run). |
| `.use()` | `.use(tool, { retry?, onError? }?)` | Appends a tool step; the tool's output feeds the next step. Per-step `retry`/`onError` overrides beat pipeline + `mt.json` defaults. |
| `.useAll()` | `.useAll(...tools)` | Sugar for `.use(a).use(b).use(c)` in order. |
| `.tap()` | `.tap((ex) => void \| Promise<void>)` | Observing side-effect (logging, metrics). Receives the full `Exchange` (meta + variables); the stream passes through unchanged. |
| `.flatMap()` | `.flatMap(async (item) => R[])` | Fan-out: one item → many downstream items. Cardinality 1→N. |
| `.batch()` | `.batch(opts?, nested?)` / `.batch(nested)` | `opts` = `number` \| `{ size?: 5, slide?: false }`. Groups items into `items[]` packages of `size`, flushing the remainder at end of stream; `slide: true` emits overlapping sliding windows instead (one per arrival). `size` must be a positive integer (`RangeError` at definition time). With `nested` (a `definePipeline()` pipeline) each package runs through it - a **batch scope**, see below. |
| `.subflow()` | `.subflow(pipeline)` / `.subflow(splitterRef)` | Pipeline form: inline nested pipeline, same Runner. A steps-only child has its steps spliced into the parent stream (inline transform); a child with its own `source` is self-contained — it runs once after the upstream drains and leaves the parent stream untouched. String form: resolve the registered `Splitter` for an entity/buffer URI scheme and fan out 1→N as an inline split. `'paragraphs://'` and `'#paragraphs'` are equivalent (bare `'paragraphs'` is rejected), likewise for `lines`, `words` and `series`; `'paragraphs://ladder'` also resolves by scheme. The splitter receives the full `Exchange`; one child envelope per returned entity. A split is an inline 1→N transformation of the current stream, so `.subflow` is the right operator — `.fork()` would spawn a nested Runner per envelope. |
| `.fork()` | `.fork(pipeline)` | Runs the child pipeline per parent envelope in a child Runner — each envelope gets its own nested checkpoint node (`stepId/fork-N`) — and merges child results back into the parent stream. |
| `.to()` | `.to(Target<T> \| string)` | Sets the Target (URI string or instance, like `.from()`) and ends the stage → the builder, which doubles as the `Pipeline`; a further `.from()` starts the next stage (used by batch scopes). Optional: the builder itself implements `Pipeline`, so subflow-only orchestration exports need no `.to()`. |

### Suites

`defineSuite(pipelines, { id?, mode? })` returns
`{ kind: 'pipeline-suite', id, pipelines, mode, sync(), parallel(), run(ctx?, options?) }`.
Each pipeline gets its own Runner/run id; all share one `GlobalContext`. `mode` defaults to `'sync'`
(sequential, declaration order, stops on the first failure). `'parallel'` starts every Runner and awaits
`Promise.all` over them; a failure rejects the suite. With no context arg `run()` calls
`loadGlobalContext(process.cwd())`.

`suite.sync()` / `suite.parallel()` return a **new** suite with the same id and pipelines and the changed
mode — the original is never mutated. An empty array or a pipeline without a string `id` and `steps` array
throws `TypeError` at definition time. Use `isPipelineSuite(value)` / `isPipeline(value)` as type guards.

`SuiteRunOptions` extends `RunnerOptions` with `onRunner?: (runner, pipeline) => void`, called once per
pipeline after `runner.start()` has minted the run id (synchronously) and before the run is awaited.

```ts
export const all = defineSuite([pipelineA, pipelineB], { id: 'all', mode: 'sync' })
await all.parallel().run(ctx, { onRunner: (runner, pipeline) => log(pipeline.id, runner.getRunId()) })
```

A suite is usually the module's default export; `mt run <file>` runs it as declared. Without a default
suite, a default pipeline runs alone; only a module with neither gets an implicit suite (see
[cli.md](cli.md#pipeline-loading)).

### `suite.ts` — `defineSuite()`

`defineSuite(pipelines, { id?, mode? })` — wraps several pipelines into one runnable suite (one Runner/run id
each, shared `GlobalContext`); `.sync()` / `.parallel()` switch mode immutably. Full contract in
[Suites](#suites).

**Tool composition** (all optional; plain `Tool`s and `.use()` unchanged):
- `chain(name, ...tools)` — one `Tool` running tools sequentially (output envelope feeds next).
- `builder.useAll(a, b, c)` — sugar for `.use(a).use(b).use(c)`.
- `defineComposableTool({ name, version, mdDescription, slots })` — tool built from named, ordered slots
  (object key order = run order), each slot itself a `Tool`. `tool.with({ slot: Tool | fn })` returns a NEW
  tool (immutable; the default export is never mutated); unknown slot names throw.
```typescript
.use(schemaDocWriter.with({ emit: myMockEmit }))   // keep build, swap emit
```
Slot rule: put pure build logic in one slot and I/O/emit (e.g. the `mdOutputs` variable) in another so authors can swap either.

**Waypoint composition** (`defineWaypoint(base, hooks)`) — wrap an existing Source/Target (instance or URI string) with
lifecycle/filter hooks, no engine changes:
- Source hooks: `onStart(ctx)`, `filter(env)` (return false to drop), `onItem(env)` (kept envelopes only).
  `resume` exists on the wrapper only if the inner source has one; same filter applies on resume.
- Target hooks: `onOpen(ctx)`, `filter(env)` (false skips the inner write), `onWrite(env)` (written ones only), `onClose(ctx)`.
- `checkpoint(ctx)` is forwarded ONLY when the inner target implements it — the wrapper never invents one.
- `uri`/`lifestyle` pass through unchanged. Hook errors propagate.
- Pass INSTANCES (e.g. `defineTarget('md://…')`) as the base for a real run: `.from()`/`.to()` carry
  Source/Target instances through to the Runner instead of re-resolving the URI from the registry.
```typescript
// Source: keep only items matching a predicate
const filtered = defineWaypoint<Chapter>('jsonl://./chapters.jsonl', {
  filter: (env) => env.item.title.startsWith('Part 1:'),
})

// Target: lifecycle hooks around an existing target
const observed = defineWaypoint<Chapter>(target('md://./out'), {
  onWrite: (env) => console.log('wrote', env.item.id),
})
```

**Process-level setup** — `defineProcess()` (same module) wraps a pipeline default export with
module-load-time installers: `.install(...)` accepts side-effect functions or `{ install() }` objects
(e.g. `mockLlm(...)` from `@mt/tools` registering a process-wide mock LLM provider) and applies them
immediately; `.pipeline(p)` returns the pipeline unchanged. Shape:
`defineProcess().install(mockLlm({ source })).pipeline(definePipeline().from(…))`. Factories resolve
installed providers at invoke time, so load-time install covers the whole run. See
[../guiding/mock-tools.md](../guiding/mock-tools.md).

### `uri.ts` — `UriRegistry`
Singleton `registry`. Sources and targets registered by scheme; resolved by `resolveSource(uri)` / `resolveTarget(uri)`.
Composite schemes (e.g. `git://`) wrap another scheme. Named URI aliases from mt.json (`"uris": { "en": "md://./chapters/en" }`)
expand `'@name'` strings (e.g. `.to('@en')`) at resolution time (in `resolveSource`/`resolveTarget` via optional settings, and in the
Runner, which has `GlobalContext.settings`). Alias chains are capped at
`MAX_URI_ALIAS_DEPTH` (10) with cycle detection.

The same registry also holds splitters, keyed by entity/buffer URI scheme:
`registerSplitter(scheme, splitter)`, `hasSplitter(scheme)`, `resolveSplitter(schemeOrUri)` and
`getSplitterSchemes()`. Resolution accepts `'<scheme>://'` (or a path form) and the `'#<scheme>'`
shortcut; a bare `'paragraphs'` is rejected so buffer references stay visibly distinct from
pipeline ids and tool names. `'paragraphs://'` / `'paragraphs://ladder'` and `'#paragraphs'`
resolve the same splitter; a missing splitter error lists the known schemes. A pipeline names the
scheme in `.subflow(...)`; `@mt/tools` registers `chunks`, `paragraphs`, `lines`, `words` and
`series` at module load.

All split implementations share the `Splitter<O>` interface from `types.ts`
(`{ name, split(env: Exchange<unknown>, ctx?: SplitterContext): O[] | Promise<O[]> }`) but keep
their own logic. The Runner passes `{ run }`, so a splitter can resolve run-scoped settings and
tunable constants (`ctx.run.global.env` / `settings`) the same way a tool does.

### `engine/runner.ts` — `Runner`
Main execution loop. Methods: `start()`, `pause()`, `resume()`, `unpause()`. Manages state machine, checkpoint writes, event log, dead-letter.

The constructor takes optional `RunnerOptions` (`pipelineFile`, `pipelineName` — the pipeline's
source file relative to the project root and its named export). They are recorded in
`state.json`, so `mt resume <runId>` can reload the right pipeline without the operator
remembering it; `resume()` rejects the run with a clear `pipelineId mismatch` error when the
loaded pipeline's `id` differs from the one the run was started with.

One recursive builder drives every level of nesting:

```
buildStream(pipeline, input, runContext) → AsyncIterable<Exchange>
```

`input` is the stream entering the step chain (`null` at the top level). Each step either
replaces or extends that stream: `source` starts a new one, `tool`/`batch`/`flatmap`/
`split`/`tap`/`fork`/`subflow` map it, `target` consumes it into a sink. `fork` and `subflow` call
`buildStream` again with the child pipeline, so nested pipelines support **every** DSL op — not
just tools. Nested runs extend the checkpoint path (`<stepId>/fork-<n>`, `<stepId>/subflow`) and
inherit the run context (same `runId`, logger scoped to the node).

**Run event log** — every run appends one JSON line per event to `.mt/runs/<runId>/events.jsonl`
through `Store.append` (append-only, never temp+rename). The backend tails this file for SSE
(UC015/UC029), so it must exist for every normal run.

| `RunEventType` | Emitted when | extra field |
|---|---|---|
| `started` | `start()` persisted the initial state | — |
| `step-done` | a step's stream ran dry, a `target` finished writing, or a nested fork/subflow node completed | `stepId` |
| `paused` | `pause()` persisted | — |
| `resumed` | `unpause()` / `resume()` took the run back to `running` | — |
| `done` | the run reached its terminal `done` state | — |
| `failed` | `failRun()` persisted the failure | `error` |

Events are written *after* the matching `state.json` write, so a tailer never sees an event
running ahead of the persisted state. A stream-shaped step only reports `step-done` when its
consumer pulls the last envelope, so upstream steps are recorded before the sink. A `pause`
that lands in the tail window (stream drained, terminal transition not yet made) is unraveled by
`markRunDone()` instead of stranding the run in `paused` — `paused → done` is not a legal edge.

**In-process events (`RunEvents`)** — alongside the file log, the Runner exposes a subscription
facade: `runner.subscribeEvents(listener)` returns an unsubscribe function, and
`RunnerOptions.events` seeds initial listeners. The facade (`{ subscribe }` only, never the
Runner) is also passed to sources/targets as `ctx.events`. Ordering guarantee: the events.jsonl
line is appended *first*, listeners are published *after* (fire-and-forget, never awaited, so
listener latency cannot stall the state machine). Listener errors (throws and rejections) are
logged via the run logger at warn level (`run event listener failed`, meta `eventType`/`stepId`)
and never thrown — a bad listener can never fail a run.

**Per-step log files** — the runner mirrors its step-scoped log lines to
`.mt/runs/<runId>/logs/<stepId>.log`. Those writes are best-effort: a failed write (ENOSPC,
EACCES, a run dir removed mid-run) is swallowed, never surfaces as an unhandled rejection and
never affects the run. The console copy of the message is unaffected.

### `engine/checkpoint.ts`
Checkpoint tree walker. Key functions: `createRootCheckpoint()`, `walkTree()`, `findFirstNonDone()`, `markDone()`, `markFailed()`, `addChild()`.

### Mid-run persist and durable cursors (UC015/UC016)
`persistState()` runs at start/pause/unpause/done/fail **and** mid-run: after every
`runner.persist.every` target writes (mt.json, default 50) and at each target-step boundary.
Mid-run persists are throttled through a single in-flight write plus a dirty flag
(`schedulePersist`/`drainPersists`), so an older snapshot can never overwrite a newer one, and a
failure is warn-logged, never thrown. Before serializing, `clampCursorsToCommitted()` clamps every
open target's cursor node to `baseCursor + checkpoint()` — the envelopes that target has durably
committed in its current open session. `Target.checkpoint?()` is optional: temp+rename targets
(`jsonl://`, `md://`) deliberately omit it, so their mid-run cursor stays at the pre-run position
and a crash resume replays from the start instead of skipping items whose output died in the temp
file. Targets with true append semantics (e.g. HTTP sinks) implement it so resume skips exactly
the committed prefix.

### Source cursor (`CheckpointNode.cursor`)
Each pipeline level keeps its source position on its own checkpoint node (root for the
top-level pipeline, `<stepId>/fork-<n>` / `<stepId>/subflow` for a nested one). The Runner counts
envelopes **as the target accepts them** (`writeTarget` → `recordCursor`) — never as the source
hands them out — because tool concurrency keeps items in flight past the write; counting pulls
would let a resume skip work that never completed. The node then serializes with the rest of the
tree, so the cursor survives a failure, a pause, or a crash.

On `resume()`, a `source` step reads that cursor and calls `source.resume(ctx, cursor)` when the
cursor is a number and the source implements `resume`; otherwise it falls back to `source.start()`
and rebases the cursor at 0 (a full replay re-derives every position). Cursor units are **source
envelopes**, so a `resume(cursor)` implementation must treat it as "skip this many envelopes" —
the ordinal a `jsonl://` source reads as its line offset. Cardinality-changing steps
(`batch`/`flatMap`/`split`) and dropped items (`skip-item`) can only under-count, which is the
safe direction: the item is re-processed, then deduplicated by the content cache.

A run whose stream ends without a target records no cursor — resume there stays cache-replay.

### `engine/git-worktree-source.ts` — Git worktree wrapper

`GitWorktreeSource` and `GitWorktreeTarget` run an inner Source/Target inside a
Git worktree without changing `process.cwd()`. Relative inner URI paths are
resolved onto the worktree directory in `createGitWorktreeSource` / `createGitWorktreeTarget`
before the inner factory is invoked. Absolute inner paths pass through unchanged.
The engine never calls `process.chdir`; concurrent worktree writes are safe.

### `engine/state-machine.ts` — `RunStateMachine`
State transitions: `pending → running → checkpoint → paused → resumed → done / failed`.
Use `canTransition()` before `transition()`.

A run that throws is marked `failed` (root checkpoint node + run state, both persisted) and the
error is re-thrown — `mt run` / `mt resume` then exit non-zero. `failed → running` is the one edge
out of `failed`: `resume()` re-drives a failed run from its first non-done checkpoint node.

### `engine/cache.ts` — `Cache`
Content-hash keyed memoisation. `computeKey(tool, exchange)` (id + ephemeral variables excluded) → `has/get/set/delete/clear`.

### `store.ts` — `Store`
Atomic file I/O under `.mt/`. All writes: write to temp file → `fs.rename()`. `readJson/writeJson/append/exists/ensureDir`.

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

- **In-process**: per-step limiter (`p-limit`-style), configurable via URI query param (`concurrency`), DSL, or global defaults. Tools always run in-process via `tool.invoke()`.
- **Fork (`.fork`)**: runs the child pipeline **per parent envelope** — the envelope is fed into
  `buildStream(child.steps, [envelope], childCtx)` and the child's output is merged back into the
  parent stream. One checkpoint node per envelope (`<stepId>/fork-<n>`). A `target` inside the
  child makes it a sink: results are written there and nothing flows back to the parent.
- **Subflow (`.subflow`)**: in-process, same Runner. The pipeline form has two modes selected by
  what the sub-pipeline declares — **never** by URI scheme:
  - **Inline** — sub-pipeline has no `source` step (steps only). Its steps are spliced into the
    parent stream, so data flows parent → child → parent.
  - **Self-contained** — sub-pipeline declares its own `source`. It runs as a nested pipeline on
    its own data after the upstream stream is consumed; the parent stream passes through unchanged.
    Subflows therefore run in declaration order, and an orchestration-only parent (no `source` /
    `target` of its own) is valid.
- **Subflow by entity type** — `.subflow('paragraphs://')` and `.subflow('#paragraphs')` are two
  spellings of the same registry lookup (likewise `chunks`, `lines`, `words` and `series`); bare
  `'paragraphs'` is rejected, and a URI with a path like `'paragraphs://ladder'` also resolves by
  scheme. The call pushes the internal `split` step: inline, same Runner, 1→N. It is deliberately **not** `.fork()`: a split
  is a transformation of the current stream, while `.fork()` starts a child Runner per envelope.
  The `series` splitter is document-aware: it parses with `readChapterDoc`, emits numbered
  `ChapterDoc` parts via `writeChapterDoc` only when the chapter is large enough (or a custom
  `shouldSplit` allows it), and otherwise returns the original markdown as one item.

`.batch()` groups envelopes into `items[]` (`item` holds the same array) and flushes the
remainder at end of stream (default size 5); `{ slide: true }` slides one item per arrival, so
consecutive groups overlap. Non-positive-integer sizes (`0`, negatives, fractions, `NaN`,
`Infinity`) throw a `RangeError` at pipeline-definition time; the Runner-side grouping
(`groupStream`) keeps a defensive fallback to size 1 for unchecked step configs.

### Batch scope: `.batch(opts, nested)`

```typescript
const scope = definePipeline({ id: 'titles' })
  .from('batch://group')            // the package as ONE exchange (item = items[])
  .use(extractTitles).use(translate).use(parse)
  .to('batch://return')             // commit: group variable edits reach every member
  .from('batch://members')          // every member as its own exchange (own id/meta/variables)
  .use(applyTitle)
  .to('batch://return')             // commit: the patched member replaces the original (by id)

definePipeline().from('md://./chapters/en').batch(scope).to('chapter-output://./chapters')
```

- The nested pipeline runs once per package (own checkpoint node `<stepId>/batch-<n>`); afterwards
  the OUTER stream continues with the ORIGINAL member envelopes (own id/meta/variables, order kept),
  patched by what the scope committed. `slide: true` + nested is a `RangeError`.
- Plumbing: the Runner puts a `BatchScope` (`createBatchScope`, `packages/core/src/batch-scope.ts`)
  on the nested `RunContext.batchScope`; the `batch://` waypoints (`packages/waypoint/src/batch-scope.ts`)
  only talk to that object, so core never imports waypoint and there is no global buffer.
- Commit rules: group exchange (id = package id) -> only its CHANGED variables are kept and stamped
  on every member (payload ignored); member exchange -> replaces that member by id; anything else is
  an error. A scope that never commits leaves members unchanged (warning logged).
- Multi-stage choice: ONE definition with several `.from(...)...to('batch://return')` stages (hence
  `.to()` returns the builder). Chosen over a scope-local named buffer or `.subflow()` per stage:
  no extra namespace/cleanup, the group-stage -> member-stage hand-off is just the committed
  group variables, and the whole flow reads top to bottom. Stages run in order, each to completion.
- Resume: the member envelopes live in the EPHEMERAL `batchMembers` variable and the scope state is
  in-memory, never persisted. The outer source cursor only advances on outer target writes, so after
  a crash the package is re-formed from the source and the nested pipeline replays for it (the
  `batch://` sources define no `resume()`). Scope work is therefore re-done, not restored.
- A failing nested step fails the run (same policies as `.fork()`); its checkpoint node is `failed`.
- `unbatchExchange` is internal machinery behind `batch://members`; there is no `.unbatch()` / `.window()` DSL op.

## Retry & Error Policy

```typescript
type RetryStrategy = 'fixed' | 'linear' | 'exp';
interface RetryPolicy {
  max: number; backoffMs: number; strategy: RetryStrategy; maxBackoffMs?: number; // cap, default 60_000
}
type ErrorPolicy = 'fail-run' | 'skip-item' | 'dead-letter';
```

Merge order (highest wins): **tool step > pipeline > global (`mt.json`)**.

`withRetry` also reads a duck-typed error contract (`RetryableError` in `engine/retry.ts`), so core
stays free of any `@mt/tools` import:

- `error.retryable === false` → fatal: rethrown on the spot, no further attempt, no `onRetry`
  callback, no backoff. Anything else (including a plain `Error`) keeps retrying.
- `error.retryAfterMs` > 0 on a retryable error replaces the computed backoff — a `Retry-After`
  header is a server instruction, not a hint.
- Every wait (computed backoff or `retryAfterMs`) is clamped to `maxBackoffMs`
  (`DEFAULT_MAX_BACKOFF_MS` = 60s when unset), so `exp` cannot run away on a large `backoffMs`.

Tools opt in by throwing errors carrying those fields (contract documented on `Tool.invoke` in
`types.ts`); `LlmError.retryable` and `LlmRateLimitError.retryAfterMs` in `@mt/tools` are the
existing shapes, so a dead key (402) or an oversize prompt now fails fast instead of waiting
1s + 2s + 4s per item.

`dead-letter` writes the offending envelope + error to `.mt/runs/<id>/dead-letter.jsonl`.
`skip-item` and `dead-letter` drop the item and keep the run going (it ends `done`); `fail-run`
rejects the tool's promise, which aborts the step stream — the item is **not** silently dropped, and
the run ends `failed`.

## Caching

When `tool.cacheable === true`, output is memoised by `hash(toolName + version + input + relevantContext)` at `.mt/cache/<hash>.json`. Replay reads the cached envelope and skips invocation. Cache is project-scoped and never required for correctness — it is a performance optimization only.

## Vault

`vault.ts`: gitignored store of LLM endpoints/keys (`~/.mt/vault.json` + `<root>/.mt/vault.json`, or only `MT_VAULT`).
`loadVault` (rejects plaintext `apiKey`/`apiKeys[]`), `isSecretRef`/`findPlaintextKeys`, `maskVault` (refs stay visible), `parseVaultRef`/`resolveVaultRef` (`vault://entry/model`, `@vault/entry/model`), atomic 0600 `saveVault`.
`loadGlobalContext` attaches it as non-enumerable `GlobalContext.vault` - never serialized. Details: [../guiding/vault.md](../guiding/vault.md).

### `vlt.ts` — vlt secret backend

Vault `apiKey`/`apiKeys[]` values of the form `vlt:<name>` are refs into
[vlt](https://github.com/ladzaretti/vlt-cli), resolved in memory at `loadVault` time
(never written back). `findVlt()` locates the binary (PATH, then `$MT_HOME|~/.mt/bin`,
memoized), `getVltSecret()` shells out via `execFile` (arg array, sanitized errors —
process output never leaks), `installVlt()` downloads the latest Linux release
(tar.gz/zip, stdlib-only extraction) into `~/.mt/bin`, `resolveVltValue()` passes
non-refs through, auto-installs once on a missing binary, and honors `MT_VLT=false`.

### `keepass.ts` — KeePass secret backend

Vault `apiKey`/`apiKeys[]` values of the form `keepass:<title|uuid>` (or
`keepass://…`) are refs into a `.kdbx` database. `kdbxweb` parses the file and
`hash-wasm` supplies Argon2 (WASM embedded in JS; no native addon or external
binary). `getKeepassSecret()` matches UUID, then `Group/Title` path, then title;
`listKeepassEntries()` returns metadata without passwords. The database is
memoized per process by path + mtime + size + credential fingerprint.
`createKeepassDatabase()` / `addKeepassSecret()` provision databases atomically
(mode 0600); `resolveKeepassValue()` honors `MT_KEEPASS=false`. Config:
`MT_KEEPASS_PATH` (default `$MT_HOME|~/.mt/secrets.kdbx`), `MT_KEEPASS_PASSWORD` /
`MT_KEEPASS_PASSWORD_FILE`, `MT_KEEPASS_KEY_FILE`. Errors name the path/entry only.

### `embed.ts` — embedded store secret backend

Vault `apiKey`/`apiKeys[]` values of the form `embed:<name>` (or `embed://…`) are refs into a
small JSON file encrypted with AES-256-GCM (scrypt KDF, AAD `mt-embed-v1`) — pure `node:crypto`,
no dependency/native addon/external binary. `getEmbedSecret()` reads by name,
`listEmbedEntries()` returns metadata without secrets. The decrypted store is memoized per
process by path + mtime + size + password fingerprint. `createEmbedStore()` / `setEmbedSecret()`
provision stores atomically (mode 0600); `resolveEmbedValue()` honors `MT_EMBED=false`.
Store format **v2** (keyring): the master password (scrypt) unlocks a keyring of named 256-bit
*encryption keys* (`kid`, status `active|retired`); each secret is AES-256-GCM-sealed under its own
`kid` (AAD `mt-embed-v2-secret:<kid>:<name>`), and `getEmbedSecret`/`resolveEmbedValue` pick the
entry's key transparently. Keyring API: `generateEmbedKey`, `addEmbedKey` (+ `parseSuppliedEmbedKey`:
64 hex / 32-byte base64 / >=12-char passphrase via scrypt), `listEmbedKeys`, `useEmbedKey`,
`retireEmbedKey`, `removeEmbedKey({ force })`, `rotateEmbedKeys({ reencrypt })`; `setEmbedSecret`
takes `kid`; `rotateEmbedSecret` replaces a value under the active key (`rotatedAt`);
`rekeyEmbedStore` changes the master password (re-wraps the keyring, verified via temp file before the
atomic rename; wrong current password or new == current changes nothing). Terminology is strict:
master password / encryption key (`kid`) / secret. Config:
`MT_EMBED_PATH` (default `$MT_HOME|~/.mt/secrets.embed.json`), `MT_EMBED_PASSWORD` /
`MT_EMBED_PASSWORD_FILE`. Errors name the path/entry only.

Master password resolution (`resolveMasterKey`): `MT_EMBED_PASSWORD` > `MT_EMBED_PASSWORD_FILE` > project `<MT_PROJECT_ROOT|cwd>/.mt/master.key` > user `$MT_HOME|~/.mt/master.key` > `DEFAULT_EMBED_PASSWORD` plus a one-time `console.warn` (obfuscation only; suggests `mt vault master-key generate`). `loadVault` sets `MT_PROJECT_ROOT` to its `projectRoot`. Key files: `generateMasterKey()` (256-bit base64url), `writeMasterKeyFile(path,{force,key})` (atomic, 0600, refuses overwrite without `force`), `masterKeyStatus()`, `masterKeyPaths()`, `masterKeyFileTooOpen()` (warn, never fail). The router duplicate (`packages/router/server/utils/embed.ts`) must keep the same order. The embedded store is the default backend, and `setEmbedSecret` creates the store on first use.

`loadVault` resolves all three ref kinds (`resolveRefs: false` keeps stored refs for
editing); details: [../guiding/vault.md](../guiding/vault.md).

A vault ref is also a config value: `settings.llm.use` in `mt.json` and env `MT_LLM_USE` expand into
provider/baseUrl/keys/headers/model for the LLM gates ([tools.md](tools.md#llm-toolkit)). The router reads
the same files with its own copy of the reader and turns entries into upstreams
([router.md](router.md#vault-t118)).
