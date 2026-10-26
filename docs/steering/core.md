# @mt/core

← [Architecture](../architecture.md)

Path: `packages/core/`

Core is the engine library — it contains all types, the DSL, the URI registry, and the Runner. Nothing in `core/` may import from any other `@mt/*` package.

## Public API (`src/index.ts`)

Re-exports everything needed by consumers:
- `definePipeline`, `defineTool`, `defineSource`, `defineTarget`, `defineWaypoint` (DSL builders)
- `Exchange` (`Envelope` deprecated alias), `Source`, `Target`, `Tool`, `Pipeline`, `Lifecycle`, `RunState` (types)
- `GlobalContext`, `RunContext`, `ToolContext`, `SourceContext`, `TargetContext` (contexts)
- `loadGlobalContext`, `parseEnvFile`, `readMtConfig`, `readMtConfigSync`, `MtConfig`, `DEFAULT_MT_CONFIG` (mt.json → `GlobalContext`)
- `UriRegistry`, `registry`, `registerSource`, `registerTarget`, `resolveSource`, `resolveTarget` (URI)
- `Runner`, `Store`, `Cache`

## Key Modules

### `domain.ts`
Plain interfaces only: `Book`, `Chapter`, `Paragraph`, `Line`. No classes, no methods. Sources provide stable IDs.

### `exchange.ts`
The data unit is a Camel-style **Exchange** (replaces the bare Envelope; `Envelope<T>` stays as a
deprecated alias of `Exchange<T>`). Modeled on the Java `FlowContext` / `FlowArgument`:
```typescript
type Qualifier = 'new' | 'old' | 'copy' | 'alt'
interface Variable<U> { id; name; qualifier: Qualifier; value: U; timestamp: string; ephemeral: boolean }
interface Exchange<T> { id: string; item: T; items?: T[]; meta: { chapterId?; paragraphId?; lineId?; [k]: unknown }; variables: Variable[] }
interface ExchangeInput<T> { id?; item: T; items?; meta?; variables? }   // loose shape Sources may yield
```
An Exchange is a **plain JSON-serializable object** (checkpoints, `events.jsonl`, dead-letter stringify
it); all operations are pure free functions returning a NEW exchange:
`createExchange`, `toExchange` (normalizer), `withItem` (derive output from input), `withMeta`,
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
- The Runner calls `toExchange` at every boundary (source output, after each tool), so literals
  without `id`/`variables` still work from Sources; a missing `id` is minted as `ex-<n>`.
- Engine: `batch`/`window` get a new `batch-<n>` id and **merge variables** (later wins on
  name+qualifier clash), meta of the first item; `flatMap` children inherit the parent's variables,
  get id `<parentId>.<n>` and `meta.parentId`. Cache keys hash `item/items/meta` + non-ephemeral
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

`scripts?: LifecycleScripts` (`Partial<Record<'install' | 'start' | 'end', string>>`) declares lifecycle
hook pipelines: paths to pipeline module files (relative to the project root) run by the CLI —
`mt install` runs `scripts.install`; `mt run` runs `scripts.start` before and `scripts.end` after the
main pipeline. The raw config (incl. `scripts`) is read with `readMtConfig(projectRoot)` — no merging
over defaults, missing file yields `{}`.

### `dsl.ts` — `PipelineBuilder`
Fluent chain. The builder itself implements `Pipeline`, so it can be a `default export` without calling `.to()`.
```typescript
definePipeline()
  .from('jsonl://./input.jsonl')
  .flatMap(async (item) => [...])
  .tap(async (env) => { /* logging: receives the full Exchange incl. meta + variables */ })
  .use(myTool)
  .subflow(otherPipeline)   // inline nested pipeline, same Runner
  .fork(subPipeline)        // child pipeline per envelope, checkpoint subtree
  .batch(5)
  .to('md://./output.md')
```

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

### `uri.ts` — `UriRegistry`
Singleton `registry`. Sources and targets registered by scheme; resolved by `resolveSource(uri)` / `resolveTarget(uri)`.
Composite schemes (e.g. `git://`) wrap another scheme. Named URI aliases from mt.json (`"uris": { "en": "md://./chapters/en" }`)
expand `'@name'` strings (e.g. `.to('@en')`) at resolution time (in `resolveSource`/`resolveTarget` via optional settings, and in the
Runner, which has `GlobalContext.settings`). Alias chains are capped at
`MAX_URI_ALIAS_DEPTH` (10) with cycle detection.

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
replaces or extends that stream: `source` starts a new one, `tool`/`batch`/`window`/`flatmap`/
`tap`/`fork`/`subflow` map it, `target` consumes it into a sink. `fork` and `subflow` call
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
(`batch`/`window`/`flatMap`) and dropped items (`skip-item`) can only under-count, which is the
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

- **In-process**: per-step limiter (`p-limit`-style), configurable via URI query param (`concurrency`), DSL, or global defaults. Tools always run in-process via `tool.invoke()`.
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
consecutive groups overlap. Both reject non-positive-integer `n` (`0`, negatives, fractions,
`NaN`, `Infinity`) with a `RangeError` at pipeline-definition time; the Runner-side grouping
(`groupStream`) keeps a defensive fallback to size 1 for unchecked step configs.

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
`loadVault`, `maskVault`, `parseVaultRef`/`resolveVaultRef` (`vault://entry/model`, `@vault/entry/model`), atomic 0600 `saveVault`.
`loadGlobalContext` attaches it as non-enumerable `GlobalContext.vault` - never serialized. Details: [../vault.md](../vault.md).

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
provision stores atomically (mode 0600); `resolveEmbedValue()` honors `MT_EMBED=false`. Config:
`MT_EMBED_PATH` (default `$MT_HOME|~/.mt/secrets.embed.json`), `MT_EMBED_PASSWORD` /
`MT_EMBED_PASSWORD_FILE`. Errors name the path/entry only.

`loadVault` resolves all three ref kinds (`resolveRefs: false` keeps stored refs for
editing); details: [../vault.md](../vault.md).

A vault ref is also a config value: `settings.llm.use` in `mt.json` and env `MT_LLM_USE` expand into
provider/baseUrl/keys/headers/model for the LLM gates ([tools.md](tools.md#llm-toolkit)). The router reads
the same files with its own copy of the reader and turns entries into upstreams
([router.md](router.md#vault-t118)).
