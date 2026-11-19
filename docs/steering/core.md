# @mt/core

← [Architecture](../guiding/architecture.md)

Path: `packages/core/`

Core is the engine library — it contains all types, the DSL, the URI registry, and the Runner. Nothing in `core/` may import from any other `@mt/*` package.

## Public API (`src/index.ts`)

Re-exports everything needed by consumers:

- `definePipeline`, `defineTool`, `defineSource`, `defineTarget`, `defineWaypoint`, `defineProcess` (DSL builders; `defineProcess(pipelines, ...)` = process form, see [Processes](#processes))
- `isPipeline`, `isProcess` (type guards; see [Processes](#processes))
- `Exchange` (`Envelope` deprecated alias), `Source`, `Target`, `Tool`, `Pipeline`, `Lifecycle`, `RunState` (types)
- `GlobalContext`, `RunContext`, `ToolContext`, `SourceContext`, `TargetContext` (contexts)
- `loadGlobalContext`, `parseEnvFile`, `readMtConfig`, `readMtConfigSync`, `MtConfig`, `DEFAULT_MT_CONFIG` (mt.json → `GlobalContext`)
- `runToolCli` (`ToolCliOptions`) — expose a `Tool` as a standalone stdin/stdout JSON CLI (UC011, see [tool-cli.ts](#tool-clits--runtoolclitool-options))
- `UriRegistry`, `registry`, `Splitter`, `registerSource`, `registerTarget`, `registerSplitter`, `resolveSource`, `resolveTarget`, `resolveSplitter`, `hasSplitter` (URI + splitter registry)
- `acquireListener`, `ListenerLease`, `HttpRouteHandler` (refcounted shared HTTP listener registry)
- `Runner`, `Store`, `Cache`
- Metrics: `MetricsEvent`, `MetricsRunSummary`, `MetricsRecorder`, `MetricsStore`, `SqliteMetricsStore`,
  `createMetricsRecorder`, `BufferedMetricsRecorder`, `metricsEnabled`, `defaultMetricsDbPath`
- Intra-tool stages: `defineStage`, `wrap`, `StageError` + `Stage`, `StageFn`, `WrappedChain`,
  `StageInterceptor`, `StageHookEvent`, `StageResultEvent`, `StageOutcome` (see [wrap.ts](#wrapts--intra-tool-stages-metricscheckpoints-inside-a-tool))
- Event bus: `emitEvent`, `subscribeEvent`, `BusEvent`, `BusEventListener` (see [event-bus.ts](#event-busts--process-wide-publishsubscribe))

## Key Modules

### `types/domain.ts` — active-record entities

Classes, not bare interfaces. Every entity has a stable `id` (a filename for persisted entities) and its own text field; the descent methods live on the entities, so a pipeline can walk the Structure Ladder without adapters:

```ts
chapter.text                 // full markdown: `# title` + content
chapter.body()               // ChapterBody: value() / title() / content()
chapter.chunks()[0].paragraphs()[0].lines[0].words()[0].text
```

- `Book` — fields mirror the Java `machinum.book.Book` record (`uniqueId`, `ruName`, `enName`, `originName`, `link`, `linkText`, `type`, `genre`, `tags`, `year`, `chapters`, `author`, `description`, `imageId`, `imageData`, `originImageId`, `jsonlFileLink`, `jsonlFileData`, `createdAt`, `updatedAt`). `get` / `set` / `patch` / `getMeta` / `patchMeta` mutate in place.
- `Chapter` — `{ id, meta: ChapterMeta, text }`; `meta` is the YAML header (`bookId`, `url?`, `index?`) with `get` / `has` / `set` / `patch` / `toObject` helpers, plus `chapter.setMeta` / `patchMeta` / `getMeta`. `text` is full markdown; `title` / `content` are mutable string accessors; `body()` returns the read-side `ChapterBody`; `chunks()` / `paragraphs()` / `lines()` / `words()` descend and serialize back through `text` / `toMarkdown()`.
- `Chunk.text`, `Paragraph.text`, `ParagraphLine.text`, `LineWord.text`, `ChapterLine.text`, `ChapterLineWord.text`, `Token.text` — the plain text payload. `Chunk.paragraphs()`, `Chunk.tokens()` (needs `opts.tokenize`), `Paragraph.lines` (getter), `ParagraphLine.words()`, `ChapterLine.words()`.
- `Chunk.tokenCount` is the token-count field (`tokens()` is the token descent).
- Mutation helpers: `line.text`, `paragraph.setText()` / `insertLine()` / `removeLine()`, `chapter.title` / `chapter.content`. Serialization joins chunks on `\n\n---\n\n` (custom `opts.separator`), paragraphs on `\n\n`, lines on `\n`.
- Ids are view-local and deterministic (`<chapterId>:c0:p0:l0:w0`); Sources still provide top-level ids, the engine never mints. Core does structural splitting only; token-bounded chunking/BPE stays in `@mt/tools` behind `opts.splitChunks`, `opts.splitParagraphs`, `opts.splitLines`, `opts.splitWords` and `opts.tokenize`. `splitWords` returns span objects (`{ word, start, end }`) so `line.wordAt()` / `line.replaceWord()` stay positional.
- Round-trip is best-effort: CRLF, leading/trailing whitespace and separator-line style are normalised; frontmatter/`ChapterDoc` metadata stay in `@mt/tools`.

### `domain-tree.ts` — fluent view aliases

`chapterTree(chapter, opts?)` / `parseChapterTree(markdown, { id, meta }, opts?)` normalize a `Chapter` (or constructor input) into `ChapterNode`; the node classes (`ChapterNode`, `ChunkNode`, `ParagraphNode`, `LineNode`, `WordNode`, `TokenNode`) are thin subclasses of the domain classes, kept for the fluent entry point and markdown adapters. `ChapterBody` remains the scenario-agnostic read view (`value()` = full markdown, `title()` = H1, `content()` = below-H1 descent); `chapterBody(chapter)` / `chapterBodyFromMarkdown(markdown, { id, meta })` adapt a `Chapter` or markdown into it. Tools that accept "some chapter body" normalize through this seam instead of inventing private paragraph shapes.

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

### `tool-cli.ts` — `runToolCli(tool, options?)`

The UC011 adapter: a published tool becomes a standalone CLI without the CLI package. `runToolCli`
reads one JSON exchange on stdin (same contract `mt tool` accepts — `{ id?, item, items?, meta?, variables? }`,
normalized by `toExchange`), builds a minimal `RunContext`/`ToolContext` over `loadGlobalContext(projectRoot)`
with a `tool-<uuid>` run id and a `standalone` checkpoint id, calls `tool.invoke` and writes the
**persisted** envelope (`toPersisted`, so `meta` and ephemeral variables are dropped) as one stdout
JSON line. Diagnostics and log lines go to stderr; nothing else is written to stdout.

```ts
#!/usr/bin/env node
import { runToolCli } from '@mt/core'
import { myTool } from './tool.js'
process.exitCode = await runToolCli(myTool)
```

- Returns the exit code (`0` ok, `1` bad/empty stdin, bad JSON, project-context failure, or a failed
  invoke) — it never calls `process.exit`, so a bin script sets `process.exitCode`.
- `options` injects every seam: `input` (stdin text; default fd 0, with a TTY usage hint),
  `projectRoot` (default `process.cwd()`), `stdout`/`stderr` line sinks (default the process streams).
- A TTY stdin gets the usage hint instead of hanging; an empty payload is an error, like `mt tool`.

Example bin: `samples/sample1-tutorial/tools/markdown-stats-cli.ts`
(`echo '{"item":"# T\\n\\nHi."}' | tsx tools/markdown-stats-cli.ts`).

### `sync/` — project sync primitives (T203)

The sync engine is in `@mt/core` so both the CLI (`mt remote sync`) and the webui routes use one
implementation with no cross-package imports:

| File | Contents |
|---|---|
| `sync/manifest.ts` | `SyncManifestEntry { path, size, sha256, mtime }`, `buildManifest(root, opts)`, `hashFile`, `createSyncHashCache` (size+mtime keyed, per-run only) |
| `sync/scope.ts` | dependency-free glob matcher, hard exclusions, `collectSyncScope`, `collectOutputScope`, `projectIdFor`, `resolveProjectId`, caps |
| `sync/diff.ts` | `diffManifests(source, target)` → `{ added, changed, removed, removedEntries, unchanged }`, SHA-256 only |
| `sync/apply.ts` | `writeSyncFile` (atomic), `deleteSyncFile`, `pruneSyncFiles`, `readSyncFile`, `resolveSyncPath`; rejects traversal, absolute paths, symlinks and protected files |

Defaults and safety rules:

- Source scope = `pipelines/**`, `mt.json`, transitive relative imports of pipeline modules
  (best effort, `.js`→`.ts` resolution included), and relative `jsonl://` / `md://` inputs declared by
  `.from(...)`. A user `remote.sync.include` list replaces that derivation; `exclude` is added on top.
- Always excluded (and enforced server-side): `.mt/`, `node_modules/`, `.git/`, `dist/`, `.env*`,
  `vault.json`, `*.vault.json`, `*.kdbx`, `*.embed.json`, `*.key`, `*.pem`.
  `.mt/runs/<id>/**` is allowed only for explicit output/pull manifests (`allowRunState`).
- `projectId` defaults to `<slug-of-project-dir>-<first-8-of-sha256(abs-root)>`; `mt.json ->
  remote.projectId` overrides it. `resolveProjectId` rejects path separators/`..`.
- Transfer caps: per file 20 MB (`remote.sync.maxFileBytes`), per request 64 MB, per mirrored project
  500 MB. Every write is temp-then-rename; a crash leaves the previous file intact.
- `syncVersion` is `1` (`SYNC_PROTOCOL_VERSION`); the CLI refuses a remote `major.minor` mismatch.

### `dsl.ts` — `PipelineBuilder`

Fluent chain. The builder itself implements `Pipeline`, so it can be a `default export` without calling `.to()`.

```typescript
definePipeline()
  .from('chunks://ladder')
  .subflow('#paragraphs', paragraphPipe) // 1→N split; same as 'paragraphs://' (bare 'paragraphs' is rejected)
  .flatMap(async (item) => [...])
  .tap((env) => { /* logging: receives the full Exchange incl. meta + variables; async OK */ })
  .tap((ex) => log.info('msg', { key: value })) // `log` from '@mt/core': standard line, INFO default
  .log('debug')             // sugar over .tap(): '<ISO-ms> [INFO] [debug] <id> <item>'
  .use(myTool)
  .subflow(otherPipeline)   // inline nested pipeline, same Runner
  .fork(branchA, branchB, branchC) // parallel: branches per envelope, deterministic merge
  .forkSync(subPipeline)    // sequential: child pipeline per envelope, checkpoint subtree
  .subflow('batch://?size=5', batchPipe) // fan-in: packages of 5 run through batchPipe
  .to('md://./output.md')
```

**DSL method reference:**

| Method | Signature | Effect |
|---|---|---|
| `definePipeline()` | `definePipeline({ id?, retry?, onError? }?)` | Entry point — creates the builder. `id` defaults to the pipeline filename (parent dir for `index.ts`/`pipeline.ts`); defaults: `retry { max: 3, backoffMs: 1000, strategy: 'exp' }`, `onError: 'fail-run'`. |
| `defineProcess()` (process form) | `defineProcess(pipelines, { id?, mode? }?)` | Wraps pipelines into a runnable process (`mode` defaults to `'sync'`); call `await proc.run()`. `.parallel(true\|false)` returns a copy with the mode switched. |
| `.from()` | `.from(Source<T> \| string)` | Sets the Source. URI string (resolved via the registry; a named `mt.json` alias defers to the Runner at run time) or instance (carried through as-is — what lets `defineWaypoint` wrappers reach the run). |
| `.use()` | `.use(tool)` / `.use(tool, { retry?, onError? })` / `.use(tool, paramsFn)` | Appends a tool step; the tool's output feeds the next step. Per-step `retry`/`onError` overrides beat pipeline + `mt.json` defaults. A `paramsFn` (`(env, ctx) => Exchange \| void \| Promise<…>`, second argument when it is a function) transforms the incoming exchange (e.g. `withMeta`) just before the tool's `invoke` — applied first, then the pipeline's interceptors; it runs inside the step's retry/error policy with the tool's `ToolContext`, and returning void keeps the incoming exchange. |
| `.useAll()` | `.useAll(...tools)` | Sugar for `.use(a).use(b).use(c)` in order. |
| `.tap()` | `.tap((ex) => void \| Promise<void>)` | Observing side-effect (logging, metrics). Receives the full `Exchange` (meta + variables); the stream passes through unchanged. |
| `.log()` | `.log(label?, { level? }?)` | Console-logging sugar over `.tap()`. Emits one standard log line per envelope: `<ISO-ms> [<LEVEL>] [<label>] <exchange id> <item>`; `label` defaults to the pipeline id. DSL level `'log'` maps to severity `info`; `'info'`/`'warn'`/`'error'`/`'debug'` map to themselves. String items pass through truncation (`truncate: true` default); non-string items render single-line (primitives via `String()`, objects via compact `JSON.stringify` with a `String()` fallback). Stream unchanged. |
| `.before()` | `.before((ex, ctx) => Exchange \| void \| Promise<…>)` | Register a `before` interceptor wrapping every `.use()` tool invocation. Runs before the tool invoke; return a (possibly modified) exchange to feed the tool instead of the incoming one, or void/omitted to keep it. Throwing skips the tool invoke — the error follows the step's normal retry/error policy. Registrations stack, run in registration order. |
| `.after()` | `.after((ex, ctx) => Exchange \| void \| Promise<…>)` | Register an `after` interceptor wrapping every `.use()` tool invocation. Runs after a **successful** invoke only — never when the tool or another interceptor failed (including after retries are exhausted). May return a modified exchange to pass downstream. Registrations stack, run in registration order. |
| `.around()` | `.around((ex, ctx, next) => Promise<Exchange>)` | Register an `around` interceptor — middleware style, like koa. `next(ex)` invokes the remaining around interceptors (onion-nested, first-registered outermost) and finally the tool itself; the return value is the (possibly replaced) output exchange. Supports async work, timing, catching errors and swapping exchanges. |
| `.flatMap()` | `.flatMap(async (item) => R[])` | Fan-out: one item → many downstream items. Cardinality 1→N. |
| `.subflow()` | `.subflow(pipeline)` / `.subflow(source, pipeline)` | Pipeline form: inline nested pipeline, same Runner. A steps-only child has its steps spliced into the parent stream (inline transform); a child with its own `source` is self-contained — it runs once after the upstream drains and leaves the parent stream untouched. Split form: resolve the registered `Splitter` for the source URI's scheme and fan the parent stream out 1→N; the child pipeline runs synchronously as a side branch and the PARENT stream passes through unchanged. `'paragraphs://'` and `'#paragraphs'` are equivalent (bare `'paragraphs'` is rejected), likewise for `chunks`, `lines`, `words`, `tokens` and `series`. Publishing into an entity buffer is an explicit target: the child writes with `.to('<scheme>://<namespace>')` (reset at stage start, append per envelope) and the next stage reads `.from('<scheme>://<namespace>')`; a child without a target gets `void://` injected. Definition-time validation: the second argument must be a pipeline and must not declare its own `.from()`. The splitter receives the full `Exchange`; one child envelope per returned entity. Batch form: `.subflow('batch://[tumbling\|slide][?size=N][&slide=true\|false]', pipeline)` groups the parent stream into `items[]` packages (default size `DEFAULT_BATCH_SIZE` = 5, remainder flushed at end) and runs the child once per package — a **batch subflow**, see below. |
| `.fork()` / `.forkSync()` | `.fork(...pipelines)` / `.forkSync(...pipelines)` | `.fork()` runs every branch CONCURRENTLY per parent envelope via real `Promise.allSettled`, each on its own isolated deep-cloned envelope; branch outputs are buffered and merged in declaration order (all of parent 0's branches, then parent 1's, ...), and any branch failure fails the run after all branches settle with the first failure in declaration order. One checkpoint node `${stepId}/fork-<n>/branch-<m>` per parent/branch is created in declaration order before work starts. `.forkSync()` pushes one sequential fork step per branch (chained): each parent envelope runs branch 1 to completion, then branch 2, ..., each on its own nested checkpoint node (`stepId/fork-N`), merging results back in arrival order. Both forms validate at definition time: every argument must be a pipeline and must not declare its own `.from()` (branches receive envelopes from the parent stream). A branch without a target merges back into the parent stream; an explicit `.to()` redirects it. |
| `.to()` | `.to(Target<T> \| string)` | Sets the Target (URI string or instance, like `.from()`) and ends the stage → the builder, which doubles as the `Pipeline`; a further `.from()` starts the next stage (used by batch children: the group stage, then the members stage). Optional: the builder itself implements `Pipeline`, so subflow-only orchestration exports need no `.to()`. |

### Processes

`defineProcess(pipelines, { id?, mode? })` (the process form of `defineProcess`) returns a
`ProcessBuilder` with `{ kind: 'process', id, pipelines, mode, parallel(flag?), run(ctx?, options?) }`.
Each pipeline gets its own Runner/run id; all share one `GlobalContext`. `mode` defaults to `'sync'`
(sequential, declaration order, stops on the first failure). `'parallel'` starts every Runner and awaits
`Promise.all` over them; a failure rejects the run. With no context arg `run()` calls
`loadGlobalContext(process.cwd())`.

`proc.parallel(true)` (default flag) / `proc.parallel(false)` return a **new** process with the same id,
pipelines, and env config and the changed mode — the original is never mutated. An empty array or a
pipeline without a string `id` and `steps` array throws `TypeError` at definition time. Use
`isProcess(value)` / `isPipeline(value)` as type guards; a setup-only `defineProcess()` builder
(no pipelines array) is NOT a runnable process and `run()` on it throws.

`ProcessRunOptions` extends `RunnerOptions` with `onRunner?: (runner, pipeline) => void`, called once per
pipeline after `runner.start()` has minted the run id (synchronously) and before the run is awaited.

```ts
export const all = defineProcess([pipelineA, pipelineB], { id: 'all' }) // sync by default
await all.parallel(true).run(ctx, { onRunner: (runner, pipeline) => log(pipeline.id, runner.getRunId()) })
```

A process is usually the module's default export; `mt run <file>` runs it as declared. Without a default
process, a default pipeline runs alone; only a module with neither gets an implicit process (see
[cli.md](cli.md#pipeline-loading)).

### `dsl.ts` — `defineProcess()`

`defineProcess()` — process-level setup builder: `.install(...)` runs installers at module load,
`.config({ env })` declares pipeline-scoped env defaults (also applied to every pipeline of the process
form), `.pipeline(p)` is the terminal step returning the pipeline for the default export.

`defineProcess(pipelines, { id?, mode? })` — process form: wraps several pipelines into one runnable
entity (one Runner/run id each, shared `GlobalContext`); `.parallel(true|false)` switches mode
immutably (default `'sync'`). Full contract in [Processes](#processes). `process.ts` holds the
`Process`/`ProcessMode`/`ProcessRunOptions` types plus the `isProcess` guard; `isPipeline` lives in
`dsl.ts`.

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

### `wrap.ts` — intra-tool stages (metrics/checkpoints inside a tool)

`wrap(name, ...stages)` composes small named stages into one async callable:
each stage's output feeds the next, the last stage's output resolves the call.
It is generic over the payload — usable inside a tool's `invoke` on
`ex.item`, but not coupled to `Exchange`:

```typescript
import { defineStage, wrap } from '@mt/core'

const parseDoc = wrap<ChapterDoc, ChapterDoc, ToolContext>(
  'chapter-doc',
  defineStage('parse', (doc, ctx) => readChapterDoc(doc)),
  defineStage('emit', (doc, ctx) => emit(doc, ctx)),
)

// inside a tool:
invoke: (ex, ctx) => parseDoc(ex.item, ctx)
```

- `defineStage(name, fn)` — a named stage; `fn` may be sync or async. The
  name is used in hook payloads and error attribution.
- Interception — one design, mirroring the pipeline interceptors: registered
  per chain via `chain.intercept({ kind, fn })`, dispatched per stage.
  `before` runs in registration order (return a value to replace the input,
  throw to short-circuit); `around` is onion middleware (`next(input?)`,
  first-registered outermost — catch/replace/short-circuit); `after` runs on
  success only and receives the measured timing payload. With no interceptors
  registered the call runs straight through — no timing, no events.
- Hook payload (`StageHookEvent` / `StageResultEvent`): `chain`, `stage`,
  `index`, `path` (chain names of all enclosing wrapped chains, outer first —
  a nested `wrap` reports `['outer', 'inner']`), `input`/`output` refs,
  `ctx` (the caller-provided ctx, forwarded unchanged to every stage fn and
  interceptor), plus on success `startedAt`, `durationMs`, `outcome: 'ok'`.
  Raw data only — enough to feed `MetricsEvent`-shaped recorders and
  checkpoints without a hard dependency on `metrics.ts`.
- Errors — a failing stage throws `StageError` (`chain`, `stage`, `index`,
  `path`, original as `cause`; `retryable`/`retryAfterMs` duck-typed fields
  carried over so `withRetry` still applies). Later stages are skipped; a
  `StageError` from a nested chain rethrows untouched with its deeper path.

Public API: `defineStage`, `wrap`, `StageError` + types `Stage`, `StageFn`,
`WrappedChain`, `StageInterceptor`, `StageHookEvent`, `StageResultEvent`,
`StageOutcome`.

### `annotation.ts` — runtime annotations

One mechanism, four sealed kinds. Tools, waypoints, use cases and categories are plain runtime values
(objects/functions), not classes, so annotations are ordinary frozen records attached with
`annotate()` — a `WeakMap` plus a non-enumerable `Symbol.for('mt.annotation')` property. The
annotated value keeps its shape (no enumerable keys, no serialization drift) and `annotate()`
returns the same value, so it composes inside a definition:

```typescript
import { category, tool, useCase } from '@mt/core'

export const chapterValidator = defineTool({
  name: 'chapter-validator',
  // 'annotations' is optional — user-defined tools may omit it entirely.
  annotations: [
    tool('TL200', { refs: ['UC055'] }),
    useCase('UC055'),
    category(['validator', 'markdown']),
  ],
})
```

- **Closed kind set** — `tool`, `waypoint`, `useCase`, `category` (`ANNOTATION_KINDS`, frozen).
  The ID kinds are frozen factories with their own namespace: `TL###`, `WT###`, `UC###`
  (`^PREFIX\d{3,}$`). `category` instead takes a non-empty list of lowercase kebab-case names
  (`category(['validator', 'markdown'])`), stores a frozen, deduped `categories: readonly string[]`,
  and carries no `id`. There is no public factory for new kinds; adding one is a core API change.
- **Sealed records** — annotations, `categories`, `refs`, `meta` and the factory functions are
  frozen. One annotation per kind per target; re-attaching the same kind/label is idempotent,
  replacing it with a different id (or category list) throws. `annotationOf(target, 'category')`
  narrows to `CategoryAnnotation`.
- **Registry** — every `annotate()` call also records `{ annotation, target, targetName }` in the
  process-wide registry. `listAnnotations(kind?)`, `findAnnotation(id)` and `annotationsOf(target)`
  read it. `resetAnnotationRegistry()` is a test/scan helper; it does not detach metadata from values.
- **Decorator adapter** — `decorate(annotation)` returns a standard ECMAScript decorator for classes
  and methods. It deliberately avoids `context.metadata`, so the project does not need the `ESNext`
  lib or `experimentalDecorators`.
- **Optional on user code** — `annotations` is optional on `defineTool`: user-defined tools need no
  annotation at all. It exists so coding agents can grep an ID and jump to the implementation.
- **Coverage** — `@mt/tools` annotates every exported tool, `@mt/waypoint` every scheme factory, and
  CLI/engine entry points carry their `UC###`. `pnpm annotations` (repo-dev only, not part of the
  `mt` binary) lists the registry; package tests enforce coverage and ID uniqueness.

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
scheme in `.subflow(...)`; `@mt/tools` registers `chunks`, `paragraphs`, `lines`, `words`, `tokens`
and `series` at module load.

Entity buffers register a write side separately:
`registerBufferWriter(scheme, factory)`, `hasBufferWriter(scheme)`,
`resolveBufferWriter(scheme, namespace)` and `getBufferWriterSchemes()`. The explicit buffer
Target that `@mt/waypoint` registers per entity scheme shares this writer, so a split-form
subflow child publishing with `.to('<scheme>://<namespace>')` resets on open (once per
stage) and appends per envelope.

All split implementations share the `Splitter<O>` interface from `types.ts`
(`{ name, split(env: Exchange<unknown>, ctx?: SplitterContext): O[] | Promise<O[]> }`) but keep
their own logic. The Runner passes `{ run }`, so a splitter can resolve run-scoped settings and
tunable constants (`ctx.run.global.env` / `settings`) the same way a tool does.

### `http-listener.ts` — shared HTTP listener registry

`acquireListener(host, port, factory?) -> Promise<ListenerLease>` returns one `http.Server` per
compatible `host:port`, refcounted across callers in the process. Its routes dispatch by exact
pathname; `addRoute('*', handler)` is the fallback (`mt serve` mounts its h3 app there). A lease's
`release()` removes every route it mounted and closes the server only after the last lease.

- **Host match** — same port and identical hosts share; a listener bound to `0.0.0.0`/`::` also
  covers a loopback request. Explicit different interfaces on one port stay separate.
  `localhost` normalizes to `127.0.0.1`; `port: 0` always creates a fresh listener.
- **Concurrency** — concurrent acquires for one `host:port` share a single in-flight bind.
- **Errors** — a foreign process on the port rejects with `EADDRINUSE` naming `host:port`.
- **Layering** — registry lives in `core/` so both `@mt/waypoint` (`hs://` sources) and
  `@mt/webui` (`mt serve`) use it without either importing the other.

### `engine/runner.ts` — `Runner`

Main execution loop. Methods: `start()`, `pause()`, `resume()`, `unpause()`. Manages state machine, checkpoint writes, event log, dead-letter.

The constructor takes optional `RunnerOptions`: `pipelineFile` (the source file relative to the
project root) and `pipelineName` (its named export) are recorded in `state.json`, so
`mt resume <runId>` can reload the right pipeline without the operator remembering it. `runId`
replays an explicit engine run id (used by `mt worker` children). `resume()` rejects the run with a
clear `pipelineId mismatch` error when the loaded pipeline's `id` differs from the one the run was
started with.

One recursive builder drives every level of nesting:

```text
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

**Default target** — a root pipeline that has a source but no target gets a `void://` target
appended by the **Runner** (not by the DSL, whose private `withVoidTarget()` helper is for nested
children only): `registry.resolveTarget('void://')` when the scheme is registered (`@mt/waypoint`),
otherwise the built-in discard target in `src/void-target.ts` — core cannot depend on
`@mt/waypoint`. The discard target counts the envelopes it accepted; `checkpoint()` returns that
count. Only the root pipeline is patched — nested fork/subflow/batch children keep their own
contract.

**Per-step log files** — the runner mirrors its step-scoped log lines to
`.mt/runs/<runId>/logs/<stepId>.log`. Those writes are best-effort: a failed write (ENOSPC,
EACCES, a run dir removed mid-run) is swallowed, never surfaces as an unhandled rejection and
never affects the run. The console copy of the message is unaffected.

**Log line format (`src/logging.ts`)** — every human-readable runtime log line (console,
`run.log`, `logs/<stepId>.log`) is built by `formatLogLine()`:

```text
<ISO-8601 UTC timestamp with ms> [<LEVEL>] <message>[ <compact-json-meta>]
2026-11-03T11:23:29.471Z [INFO] md target 'md://./chapters' wrote 1 file(s)
```

`escapeLogNewlines()` folds CR/LF into the literal `\n` and TAB into `\t`, so one log call is
always one physical line. `createConsoleLogger()` emits this format with a single console
argument; the `log` singleton (same module) is the process-level equivalent for pipeline code —
`log(message, meta?)` is INFO, plus `log.info/warn/error/debug`. JSON/JSONL (`events.jsonl`,
`--json`) is excluded and keeps real newlines inside JSON strings. The Runner, `DuplexLogger`,
tools, sources/targets, `.log()` and the CLI lifecycle lines all share this formatter; do not
hand-build `[timestamp] [LEVEL]` strings.

### `event-bus.ts` — process-wide publish/subscribe

One bus per process, independent of the run lifecycle: pipelines publish and subscribe to named
channels without knowing about each other.

```typescript
import { emitEvent, subscribeEvent } from '@mt/core'

emitEvent('chapterReady', { chapter: 3, title: 'The Quiet Harbour' })
const unsubscribe = subscribeEvent('chapterReady', (event) => log.info('got', event))
```

- `BusEvent` — `{ type, ts, runId?, stepId?, error?, payload? }`.
- `emitEvent(type, payload?)` — validates a non-empty `type` (throws `TypeError` otherwise) and
  returns the published event. Inside a run it carries the run id and **registers that run as an
  emitter** of the channel.
- `subscribeEvent(type, listener, onClose?)` — returns an unsubscribe function. A late subscriber
  first receives the channel **history** (the last 100 events), then live events. Listener throws
  and rejections are caught and logged (`event bus listener failed`) — they never reach the
  publisher.
- **Close rule (custom channels)** — a channel that had at least one emitter closes when *every*
  emitter run has ended. The Runner calls `closeBusRun(runId)` when a run reaches `done`/`failed`;
  closing notifies the subscribers through `onClose`. Publishing again reopens the channel.
- **Lifecycle events** (`started`, `step-done`, `paused`, `resumed`, `done`, `failed`) are published
  to the bus as well, but they never register the publishing run as an emitter — otherwise a
  subscriber run would keep its own channel open forever.
- **Live runs** — the Runner registers its run (`openBusRun(runId)`) synchronously, before the first
  `await` of `start()`/`resume()`, and unregisters it when the run ends (`closeBusRun(runId)`).
  `subscribeBusRuns(runId, onChange)` tells a watcher whether *another* run of the process is still
  live. The synchronous registration is what lets `defineProcess([...]).parallel(true)` start every
  sibling run before any of them attaches a subscription.
- The channel name is the raw `type` string — the `events://` waypoint maps a URI onto it.

**Run context (`AsyncLocalStorage`)** — `withRunContext(runId, fn)` (the same pattern as
`wrap.ts`) scopes the run id, and the Runner wraps the whole `executeSteps()` in it, so
`emitEvent()` inside a `.tap()` carries the current run id.
`packages/core/tests/event-bus.test.ts` proves that the context propagates through the runner's
async-generator chain.

### `metrics.ts` / `metrics-store.ts` — run metrics (SQLite, WAL)

Per-run timing metrics for step invocations, persisted to SQLite (`better-sqlite3` under Node,
`bun:sqlite` under Bun — same dynamic-require driver trick as the webui backend, so the single-file
binary works and a broken native addon is non-fatal). This is the one deliberate exception to the
"core has zero external runtime dependencies" rule; the driver is loaded lazily at open time.

- **Event shape** (`MetricsEvent`, exporter-facing — Prometheus/OTel consumers read this, not SQL):
  `{ runId, pipelineId, stepType, stepName (engine step id), toolName, exchangeId, startedAt (ISO),
  durationMs, outcome: 'ok'|'error', errorMessage? }`. Only `'tool'` steps are measured today.
- **Where it hooks in**: the Runner creates a recorder in `start()`/`resume()` and closes it on
  `done`/`failed`. Each tool invoke inside `withRetry` is timed (params + interceptors + invoke +
  retries); cached invocations return before timing, so only real work is measured. Works with zero
  user-registered interceptors.
- **Recorder** (`BufferedMetricsRecorder` via `createMetricsRecorder`): events buffer in memory and
  flush in batches — the driver is sync, so a flush yields once through `setImmediate` to collapse
  bursts, runs on a 1s unref'd timer, at a 500-event high-water mark, and always on `close()`.
  Flush/close failures are warn-logged and dropped; metrics never fail or block a run. On close a
  run summary (`metrics_runs`: counts + wall duration) is upserted.
- **Store** (`SqliteMetricsStore.open(dbPath)`): `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`,
  `CREATE TABLE IF NOT EXISTS` at open. Tables: `metrics_events` (one row per event, indexes on
  `run_id`, `tool_name`, `started_at`) and `metrics_runs` (per-run aggregate, PK `run_id`). Each
  batch insert is one transaction. Read path: `queryEvents({runId?, toolName?, outcome?, limit?})`,
  `getRunSummary(runId)`, `journalMode()`.
- **DB location**: `MT_METRICS_DB`, default `<projectRoot>/.mt/metrics.db`.
- **Disable**: `MT_METRICS=false`. If the DB cannot be opened (missing/broken native addon, bad
  path), exactly one WARN line is logged (`Metrics disabled: ...`) and the run proceeds without
  metrics.
- Env var precedence: `process.env` wins over mt.json `env` (same as the rest of the engine).

### `engine/checkpoint.ts`

Checkpoint tree walker. Key functions: `createRootCheckpoint()`, `walkTree()`, `findFirstNonDone()`, `markDone()`, `markFailed()`, `addChild()`.

### Mid-run persist and durable cursors (UC015/UC016)

`persistState()` runs at start/pause/unpause/done/fail **and** mid-run: after every
`runner.persist.every` target writes (mt.json, default 50), at each target-step boundary, and on
pause. Mid-run persists are throttled through a single in-flight write plus a dirty flag
(`schedulePersist`/`drainPersists`), so an older snapshot can never overwrite a newer one, and a
failure is warn-logged, never thrown. Before serializing, `clampCursorsToCommitted()` clamps every
open target's cursor node to `baseCursor + checkpoint()` — the envelopes that target has durably
committed in its current open session. `Target.checkpoint?()` is optional:

- **Append-style file targets** (`jsonl://`, `md://<file>`) stage into `<path>.tmp.<runId>`, flush
  every write (WriteStream callback, then `fsync` from `checkpoint()`) and return the session
  envelope count. Final publish stays atomic: rename on `close()`. On resume the Runner passes the
  persisted cursor as `TargetContext.resumeCursor`; `open()` truncates the staging file back to
  that boundary (JSONL by line offset, md file mode via an `<tmp>.offsets.json` sidecar of
  per-envelope byte offsets) before appending.
- **Per-file targets** (`chapter://`, `schema-doc://`, `book://`, `review://`) write every
  envelope atomically and return a counter. Auto-numbered filenames seed from the highest existing
  chapter when `resumeCursor > 0`, so replay never overwrites lower chapters.
- **Terminal/stateful sinks** (`console://`, `void://`, `events://`) count accepted envelopes;
  console waits for `drain` under backpressure. These counts pace resume, but the sinks themselves
  are not crash-durable.
- **Process-local targets** (`ephemeral://`/`mem://`, `batch://return`, entity buffers) and custom
  targets that only publish on `close()` cannot align durable output across processes. They omit
  the hook; the engine keeps their cursors at the pre-run position and resume replays.

### Source cursor (`CheckpointNode.cursor`)

Each pipeline level keeps its source position on its own checkpoint node (root for the
top-level pipeline, `<stepId>/fork-<n>` / `<stepId>/subflow` for a nested one). The Runner counts
envelopes **as the target accepts them** (`writeTarget` → `recordCursor`) — never as the source
hands them out — because tool concurrency keeps items in flight past the write; counting pulls
would let a resume skip work that never completed. The node then serializes with the rest of the
tree, so the cursor survives a failure, a pause, or a crash.

On `resume()`, a `source` step reads that cursor and calls `source.resume(ctx, cursor)` when the
cursor is a number and the source implements `resume`; otherwise it falls back to `source.start()`
and clears the node's cursor (a full replay re-derives every position, and a cleared cursor tells
incremental targets to treat the run as fresh). Cursor units are **source
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

`core/` has **zero** external runtime dependencies beyond Node.js stdlib — the one exception is
`better-sqlite3` for the metrics store (optional at runtime, lazily loaded, `bun:sqlite` under Bun);
see [metrics.ts / metrics-store.ts](#metricsts--metrics-storets--run-metrics-sqlite-wal). No `axios`, no `zod`, no framework deps.

---

## Checkpoint Tree Replay Rules

The checkpoint tree is walked depth-first. Nodes marked `done` are skipped. The first non-done node is resumed. Sequential fork envelopes are ordered by status: a later envelope (e.g. `fork:2`) is **not** started until all earlier siblings (`fork:0`, `fork:1`) reach a terminal state (`done` or `failed`), preventing out-of-order side effects across envelopes. Parallel fork branches (`<stepId>/fork-<n>/branch-<m>`) are created together and all settle before the parent continues or fails. A resumed run re-executes the fork step from the persisted source cursor, like any other stream step.

## Concurrency Primitives

- **In-process**: per-step limiter (`p-limit`-style), configurable via URI query param (`concurrency`), DSL, or global defaults. Tools always run in-process via `tool.invoke()`.
- **Fork (`.fork` / `.forkSync`)**: both operate **per parent envelope**.
  - **Sequential** (`.forkSync(...pipelines)` — one chained step per branch): feeds the envelope into
    `buildStream(child.steps, [envelope], childCtx)` and merges the child's output back into the
    parent stream. One checkpoint node per envelope (`<stepId>/fork-<n>`). A `target` inside the
    child makes it a sink: results are written there and nothing flows back to the parent.
  - **Parallel** (`.fork(...pipelines)`): starts every branch concurrently for the envelope
    with `Promise.allSettled`, each branch draining its own cloned stream. Each branch gets a
    `structuredClone` envelope with `item` relinked to its cloned `item` variable, so in-place
    mutation cannot leak across branches. Branch outputs are buffered, then emitted in branch
    declaration order after every branch settles (parent 0's branches first, then parent 1's,
    ...). Checkpoint nodes are `<stepId>/fork-<n>/branch-<m>`, created in declaration order
    before the concurrent work. Any rejection fails the run after all branches settle.
- **Subflow (`.subflow`)**: in-process, same Runner. The pipeline form has two modes selected by
  what the sub-pipeline declares — **never** by URI scheme:
  - **Inline** — sub-pipeline has no `source` step (steps only). Its steps are spliced into the
    parent stream, so data flows parent → child → parent.
  - **Self-contained** — sub-pipeline declares its own `source`. It runs as a nested pipeline on
    its own data after the upstream stream is consumed; the parent stream passes through unchanged.
    Subflows therefore run in declaration order, and an orchestration-only parent (no `source` /
    `target` of its own) is valid.
- **Split-form subflow** — `.subflow('paragraphs://', pipe)` and `.subflow('#paragraphs', pipe)`
  are two spellings of the same registry lookup (likewise `chunks`, `lines`, `words`, `tokens`
  and `series`); bare `'paragraphs'` is rejected, and a URI with a path like
  `'paragraphs://ladder'` also resolves by scheme. The call pushes the internal `split` step:
  inline, same Runner, 1→N. The child pipeline runs synchronously as a side branch — the parent
  envelope passes downstream unchanged after its children are processed. One nested child run
  spans the whole step, so a buffer target inside the child opens exactly once (reset at stage
  start, append per envelope); a child without a target gets `void://` injected at definition
  time (resolved at run time, so defining a pipeline needs no registered `void://` waypoint).
  The checkpoint node is `<stepId>/split-branch`. It is deliberately **not** `.fork()`: a split
  is a 1→N transformation of the current stream, while `.fork()` runs whole branches per
  envelope. Publishing into an entity buffer is explicit: `.to('<scheme>://<namespace>')` inside
  the child, read back with `.from('<scheme>://<namespace>')`.
  The `series` splitter is document-aware: it parses with `readChapterDoc`, emits numbered
  `ChapterDoc` parts via `writeChapterDoc` only when the chapter is large enough (or a custom
  `shouldSplit` allows it), and otherwise returns the original markdown as one item.

The batch subflow `.subflow('batch://[tumbling|slide][?size=N][&slide=true|false]', pipe)` is the
fan-in twin of the split form: it groups envelopes into `items[]` packages and runs `pipe` once per
package. Packages flush at `size` (default `DEFAULT_BATCH_SIZE` = 5) and the remainder flushes at
end of stream; `batch://slide` (or `?slide=true`) moves one item per arrival instead, so
consecutive packages overlap. `?slide=` wins over the mode segment, and `batchSize` is accepted as
an alias of `size`. Everything is validated at definition time: an unknown mode segment, an unknown
query key or a non-boolean `slide` throws `TypeError`, a non-positive/non-integer size throws
`RangeError`. `batch://group`, `batch://members` and `batch://return` in the subflow source position
are a `TypeError` — they are child-side views only. Grouping and the scope state live in memory
(`groupStream` on the Runner side, `createBatchScope` in `packages/core/src/batch-scope.ts`); the
Runner-side grouping keeps a defensive fallback to size 1 for unchecked step configs.

### Batch subflow: `.subflow('batch://...', pipe)`

```typescript
const titles = definePipeline({ id: 'translate-titles' })
  .use(extractTitles)        // item = the package array, items = the same array
  .use(translateTitles)      // one call for the whole package
  .use(applyTitles)          // returns the patched package; members patched in place

definePipeline().from('md://./chapters/en')
  .subflow('batch://?size=5', titles)
  .to('chapter://./chapters')
```

- The package reaches the child as its INPUT stream: one exchange with `id` `batch-<...>`,
  `item` = the member payloads, `items` set, and the original members carried in the ephemeral
  `batchMembers` variable. A child therefore starts with `.use(...)` and must not declare its own
  `.from()`; the only allowed source is a child-side `batch://` view.
- A child without a target gets `.to('batch://return')` injected, so the package is handed back to
  the scope. The URI resolves at run time, so defining a pipeline needs no registered views.
- The OUTER stream continues with the ORIGINAL member envelopes (own id, meta, variables, order),
  patched by what the child committed. Group output: its CHANGED variables are stamped on every
  member; when its payload is an array of the same length as the package, member `i` receives
  `items[i]` (zip by index). An explicit member commit by id wins over that zip. A payload of a
  different length commits no payload. A child that never commits leaves members unchanged
  (warning logged).
- A child with its own `.to(<uri>)` is a sink: it writes there and nothing flows back to the
  parent members, same as a split child. The parent stream still continues downstream (and is
  drained when the parent has no target).
- Advanced child-side views: `batch://group` (the package as one exchange), `batch://members`
  (every member as its own exchange, own id/meta/variables) and `batch://return` (commit). A child
  may chain stages, e.g. `.from('batch://group')...to('batch://return').from('batch://members')...to('batch://return')`
  — `.to()` returns the builder for that. Commit rules: a group exchange (id = package id) keeps
  only its changed variables and stamps them on every member (its payload is handled by the zip
  above); a member exchange replaces that member by id; anything else is an error.
- Checkpoint: one node `<stepId>/batch-<n>` per package; a failing child step fails the run under
  the usual retry/error policies and marks the node `failed`.
- Resume: package grouping, the members and the scope state are in memory only, never persisted.
  The outer source cursor advances only on outer target writes, so after a crash the package is
  re-formed from the source and the child replays for it — scope work is re-done, not restored.
- `unbatchExchange` is internal machinery behind `batch://members`; there is no `.unbatch()` /
  `.window()` DSL op.

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

`vault.ts`: gitignored store of LLM endpoints/keys (`~/.mt/vault.json`, then `<dir>/.mt/vault.json` from the git top-level down to the run root — nearer wins — or only `MT_VAULT`).
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
