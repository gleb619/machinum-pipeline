# @mt/waypoint
← [Architecture](../guiding/architecture.md)

Path: `packages/waypoint/`

Source and Target implementations for the URI registry. Import as a **side-effect** to register all schemes:

```typescript
import '@mt/waypoint'
```

This registers: `jsonl://`, `md://`, `hs://` / `http://`, `chapter://`, `schema-doc://`, `git://`, `range://`, `void://`, `console://`, `review://`, `events://`, `temp://`.

## URI Scheme Reference

| ID | Scheme | File | Source | Target | Notes |
|---|---|---|---|---|---|
| WT001 | `jsonl://./file.jsonl` | `jsonl.ts` | ✓ | ✓ | Supports glob patterns for source |
| WT002 | `md://./chapters/` | `md.ts` | ✓ | ✓ | Markdown files in directory; `?series=true` splits each document with the registered `series` splitter before writing |
| WT003 | `hs://` / `http://` | `http-server.ts` | ✓ | — | Long-lived HTTP POST endpoint |
| WT004 | `chapter://./en/` | `chapter-output.ts` | ✓ | ✓ | Language-folder chapter layout |
| WT005 | `schema-doc://./docs/` | `schema-doc.ts` | ✓ | ✓ | Per-chapter schema doc files |
| WT006 | `git://<path>?branch=<b>` | `git-worktree.ts` | ✓ | ✓ | Git worktree isolation; optional auto-commit on close |
| WT007 | `range://<start>..<end>` | `range.ts` | ✓ | — | Integer generator; `?step=` magnitude, direction derived |
| WT008 | `void://` | `void.ts` | — | ✓ | Discards everything (like /dev/null) |
| WT009 | `console://` | `console.ts` | — | ✓ | Terminal sink (stdout/stderr), per-envelope, target-only |
| WT010 | `events://<name>?only=…` | `events.ts` | ✓ | ✓ | Subscription handle (not storage): yields `RunEvent` envelopes; target prints `[lifecycle] …` lines |
| WT011 | `review://./out.md` | `review.ts` | — | ✓ | Glossary pending-proposals review queue as markdown |
| WT012 | `temp://<entity>/<namespace>` | `entity-buffers.ts` | — | ✓ | In-memory write side for a typed entity buffer (`temp://chunks/ladder` → `chunks://ladder`) |
| WT013 | `ephemeral://<namespace>` | `ephemeral.ts` | ✓ | ✓ | Process-local in-memory buffer; target clears on open |
| WT014 | `batch://group\|members\|return` | `batch-scope.ts` | ✓ | ✓ | Scope-local views of `.batch(opts, nested)` |
| WT015 | `batches://` … `words://` | `entity-buffers.ts` | ✓ | ✓ (`batches` only) | Typed entity-buffer family: `batches`, `chapters`, `paragraphs`, `chunks`, `tokens`, `lines`, `words`; ladder rungs are source-only |

## Annotations

Every scheme factory carries one sealed runtime `waypoint` annotation. The ID is the `ID`
column above; source and target factories for the same scheme share it. `meta.schemes`
lists the URI schemes the factory serves and `meta.direction` is `source`, `target` or
`both`. Each module annotates its factory right next to the registry call:

```typescript
// packages/waypoint/src/jsonl.ts
annotate(
  createJsonlSource,
  waypoint('WT001', {
    name: 'jsonl source',
    description: 'Streams JSONL envelopes from a file or glob pattern.',
    meta: { schemes: ['jsonl'], direction: 'source' },
  }),
)
registry.registerSource('jsonl', createJsonlSource)

// consumer
annotationsOf(createJsonlSource) // [{ kind: 'waypoint', id: 'WT001', … }]
```

Scan the process-wide registry with `pnpm annotations --kind waypoint`. The
`entity-buffers.ts` family keeps one annotation per export with `meta.schemes` covering
all seven buffers (`WT015`), so `WT012` is only the `temp://` write side.

Entity schemes descend the **Structure Ladder** (`jsonl://` → `md://` → `chunks://` ─┬→ `paragraphs://` → `lines://` → `words://` / └→ `tokens://` alternate) — see [Structure Ladder](#structure-ladder) below. Ladder rungs are **source-only** (creational); write their output through `temp://<entity>/<namespace>`. `batches://` is a non-ladder package buffer and stays bidirectional.

## Source/Target Shape

Every implementation follows the `Source<T>` / `Target<T>` interfaces from `@mt/core`.

```typescript
// Source: async generator
class JsonlSource implements Source<unknown> {
  uri: string
  lifestyle: 'resumable'
  async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<unknown>> { … }   // stamp a stable `id`; the Runner runs toExchange
  async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<ExchangeInput<unknown>> { … }   // stamp a stable `id`; the Runner runs toExchange
}

// Target: open/write/close lifecycle
class JsonlTarget implements Target<unknown> {
  uri: string
  async open(ctx: TargetContext): Promise<void> { … }
  async write(ex: Exchange<unknown>, ctx: TargetContext): Promise<void> { … }
  async close(ctx: TargetContext): Promise<void> { … }
}
```

### Source resume contract

`resume(ctx, cursor)` must **skip `cursor` envelopes** of the source's deterministic ordering
(`docs/steering/core.md` — Source cursor). The runner counts envelopes as the target accepts
them and resumes at `sourceStart + envelopesWritten`; replaying already-accepted envelopes makes
the runner double-count and the next resume silently skips unprocessed work. A non-number cursor
means "skip nothing" (`sourceStart = 0`). All waypoint resumable orderings are deterministic
(sorted file walks, buffer insertion order), so a plain skip is exact. Shared helper:
`src/resume.ts` (`resumeFrom(startFn, cursor)` / `skipEnvelopes(stream, n)`), used by `md://`,
`my-target://`, `ephemeral://`, `chapters://`/`paragraphs://`/`chunks://`/`tokens://`/`lines://`/`words://`, `schema-doc://` and `range://`.

## Atomicity Contract (hard rule)

> File writes are atomic (temp-then-rename).

Every waypoint target writes through the helpers in `@mt/core`:

| Helper | Use |
|---|---|
| `atomicWriteFile(path, data)` | Whole-file write: temp sibling → `rename` |
| `AtomicStreamWriter.open(path, runId)` | Streamed write; `commit()` renames on `close()`, `abort()` drops the temp |
| `removeStaleTmpFiles(path)` | Sweep temp files left by an interrupted run |

Target shapes:

- **Per-file targets** (`my-target://`, `schema-doc://`, `md://<dir>`) call `atomicWriteFile`
  per envelope. A crash keeps every chapter written so far intact — never a truncated one.
- **Single-file targets** (`jsonl://<file>`, `md://<file>`) accumulate into
  `<path>.tmp.<runId>` and rename in `close()`. Consequences:
  - a crash mid-run leaves the final file untouched (absent, or its previous content);
  - `open()` sweeps stale `.tmp.` siblings, so a rerun replaces instead of appending
    duplicates — do **not** open these targets with `flags: 'a'`;
  - the final file becomes visible only once `close()` resolves, so read a target
    file only after the run reaches its checkpoint.

`Store.append` (run logs, dead-letter queue) is the one documented exception: those files are
append-only line logs, never re-read whole, so it uses `fs.appendFile` rather than temp+rename.

## Key Implementation Details

### `jsonl.ts`
- Source: streams lines from `.jsonl` file, supports glob patterns and a position cursor for resume
- Each line must be a JSON object with an `item` property or an `item` variable (`{ id?, item, meta?, variables? }`; the `jsonl://` target writes the persisted form `{ id, items?, variables }` where the payload is only the `item` variable); a missing `meta`
  defaults to `{}`, `variables` to `[]`, and a missing `id` to the stable `<file>#<line-index>`. Malformed JSON or a missing/invalid `item`/`meta` throws with a `file:line`
  location (1-based physical line number)
- Cursor: single file → envelope index among non-blank lines (blank lines are skipped and never
  counted); glob → `{ fileIndex, line }` where `line` is the envelope index in the file at
  `fileIndex` (legacy numeric cursors map to the first file). Non-numeric/non-glob cursors throw
  `invalid jsonl cursor`
- `batchSize` is honored on both `start()` and `resume()` — resumed runs see the same cardinality
- One shared line reader (`readLines()`/`readFiles()`) backs start, resume and glob paths, so
  numbering is identical everywhere
- Target: `AtomicStreamWriter` on `open()`, JSON lines on `write()`, `commit()` (rename) on `close()`
- `isGlobPattern()` / `isGlobCursor()` helpers for glob vs direct path detection

### `range.ts`
- Source-only integer generator: `range://<start>..<end>` yields `{ item: n, meta: {} }` per number
  from `start` to `end` inclusive (`uri.path || uri.host` carries the range; the parser puts `1..10`
  in the host for `range://1..10`)
- Direction derived from start/end comparison (`5..3` yields 5,4,3); `?step=` is a positive-integer
  **magnitude** applied in that direction. `0..0` / `3..3` yield exactly one envelope
- Validation throws naming the bad component (`start`, `end`, `step`): missing `..`, non-integer,
  non-positive step
- `lifestyle: 'resumable'`; `resume()` via `resumeFrom()` — the numeric ordering is deterministic
  by construction. No `batchSize`: use the engine's `.batch(n)` for cardinality changes

### `void.ts`
- Target-only sink: `void://` discards every envelope (open/write/close are no-ops)
- Deliberately **no `checkpoint()`** — nothing is durable mid-run; the runner keeps its cursor
  pre-run and a crash replays the source, which is harmless for a stateless sink

### `console.ts`
- Target-only terminal sink: `console://[?format=auto|json|pretty][&prefix=<text>][&envelope=true|1][&stream=stdout|stderr]`;
  registered as a built-in in `packages/waypoint/src/console.ts` (`createConsoleTarget`,
  `renderConsoleExchange`) with no source registration (`resolveSource` throws)
- Writes each envelope to stdout (default) or stderr immediately with one trailing newline; no
  buffering, no atomicity contract
- `prefix=<text>` is prepended to every output line (multi-line items: every line)
- `envelope=true|1` prints the full exchange `{ id, item, items?, meta, variables }` instead of just `item`
- Unknown `format` or `stream` values throw at factory time
- Deliberately **no `checkpoint()`** — stdout is not durable storage; a crash resume replays safely
- Used in sample2 by `consolePreviewPipeline` (`pnpm run runner:preview`), which prints each input
  line prefixed with `[preview]` plus a space

| Query option | Values | Default | Behavior |
|---|---|---|---|
| `format` | `auto`, `json`, `pretty` | `auto` | `auto`: strings as-is, everything else compact JSON; `json`: compact JSON always (strings quoted); `pretty`: 2-space indented JSON |
| `prefix` | text | — | Prepended to every output line |
| `envelope` | `true`, `1` | `false` | Print the full exchange instead of just `item` |
| `stream` | `stdout`, `stderr` | `stdout` | Destination stream |

### `review.ts`
- Target-only glossary review queue (T140): `review://./glossary.review.md` renders the pending
  proposals (`term.pending`) of the glossary envelope as a markdown worksheet, plus a locked-terms
  section; the last glossary envelope wins and the file is written atomically in `close()`
- The glossary is read from the `glossary` variable (legacy `glossary` variable accepted), or parsed from a JSON-string / object `item`
  (structural `ReviewGlossary` mirror of `@mt/tools` `Glossary` — waypoint must not import
  `@mt/tools`, keep the mirror in sync); envelopes without a glossary throw a clear error
- Deliberately **no `checkpoint()`** — nothing is durable mid-run, so a crash resume replays safely

### `http-server.ts`
- `Lifecycle: 'long-lived'` — persists across pauses/resumes
- Plain `node:http` server started on `start()`; no `resume()` support
- Endpoints: `POST <uri.path>` ingest, `GET /health`, `GET /events` (SSE)
- `/events` is a read-only fan-out: each envelope handed to the pipeline is mirrored to every
  subscriber. It never reads or clears the ingest buffer, so subscribing cannot steal items
- Query options: `port`, `count` (stop after N yielded), `maxBodyBytes` (default 1 MiB, oversize →
  `413`), `maxBuffer` (default 1000 undelivered envelopes, full → `503` + `Retry-After`)
- Shutdown ends all subscriber responses and calls `closeAllConnections()` before `close()` — an open
  SSE connection must not block run teardown

## Listening to run lifecycle

`SourceContext`/`TargetContext` carry an optional `events?: RunEvents` — a Runner-built facade
exposing only `subscribe(listener): () => void`. Event types: `started`, `step-done` (with
`stepId`), `paused`, `resumed`, `done`, `failed` (with `error`). The Runner writes each event to
`events.jsonl` first and only then notifies listeners (fire-and-forget; listener errors are
logged, never thrown). Pattern: subscribe in `start()`/`open()`, **unsubscribe in `close()` or a
generator's `finally`** — a source must not hold a listener after the run released it.
`http-server.ts` is the reference example: it mirrors `paused`/`resumed`/`done`/`failed` into its
`/events` SSE stream as `{"type":"lifecycle","event":<RunEventType>}` frames, next to the
per-envelope fan-out, and unsubscribes in the generator's `finally`. The `events://` scheme
(`packages/waypoint/src/events.ts`) uses the same facade as a subscription handle: as a target
it logs `[lifecycle] <type>` lines; as a source it yields `RunEvent` envelopes (`item = RunEvent`).
The `#` shortcut (e.g. `#only=done`, bare `#`) resolves through the alias layer to
`events://default?<qualifier>`.

### `git-worktree.ts`
- `GitWorktreeSource` / `GitWorktreeTarget` — use `createWorktree()` / `removeWorktree()` from `@mt/core/engine/git-worktree`
- Target calls `autoCommit()` in `close()` when `commit` query param is set
- On close with `commit=on-close`, `mergeWorktreeToMain()` rebases the worktree branch onto the
  base branch **inside the worktree** (base history never rewritten), then fast-forwards the base
  branch in `repoRoot` only if it is the checked-out branch with a clean tracked tree — the
  operator's checkout is never switched. Base branch auto-detection: `origin/HEAD` →
  `init.defaultBranch` → repoRoot's current branch; overridable via `?base=<name>`. A skipped
  merge leaves the mt branch unmerged and surfaces a run warning (`logger.warn`) naming it (T170)

### Runner auto-commit (`commit=on-close`)
- On Target close the Runner calls `autoCommit(projectRoot, undefined, [outputPath])` — it
  stages **only the target's output path** (git pathspec commit), never `git add -A`, so
  unrelated WIP edits and untracked files (e.g. `.env`) stay out of the commit (T169)
- Output path derives from the target URI via `resolveWaypointPath` semantics
  (`uri.path || uri.host`, `waypoint.<scheme>.defaultFolder` for bare filenames); directory
  targets match recursively
- Both implement `lifestyle: 'resumable'`

### `schema-doc.ts`
- Parses/serialises custom schema-doc format (YAML + CSV sections)
- `parseSchemaDoc()` / `extractTextContent()` helpers

### `chapter-output.ts`
- Writes `<base-dir>/<lang>/chapter<num>.md` per envelope (lang optional → `<base-dir>/chapter<num>.md`)
- Path-safety (mirrors the `md://` intent rules): `meta.lang` must match `/^[\p{L}\p{N}_-]+$/u`
  (single segment — no separators, no `..`); `meta.chapterNum` (or legacy `chapter`) must be a
  non-negative integer; the auto-increment fallback is always safe. Violations throw an error
  naming the key, never silently rewrite. The final path is additionally asserted inside
  `baseDir` via `relative()` (no `..` prefix) as defence in depth

### `md.ts`
- Target query `?series=true` (or `?series=1`) is syntax sugar for `.subflow('#series')` +
  `.to('md://...')`: each incoming markdown item is passed through `registry.resolveSplitter('series')`
  (with `{ run }` as context) and every part is written through the normal file/dir path. File
  mode appends each part; dir mode without `mdOutputs` writes `chapterN.md` per part. Combining it
  with `mdOutputs` intents throws, because there is no unambiguous filename for a part. Import
  `@mt/tools` to register the `series` splitter; a missing splitter throws a clear error.

### `settings.ts`
- `getWaypointSetting(key)` — reads from `mt.json` waypoint section
- `resolveWaypointPath(uri, scheme, settings, projectRoot)` — the single resolver for all
  waypoint paths: absolute URI paths are returned unchanged, every relative path (including glob
  patterns) anchors at `projectRoot` (`ctx.run.global.project.root`), never `process.cwd()`;
  `waypoint.<scheme>.defaultFolder` is prepended only for bare filenames (no directory separator)
- `resolveWaypointRoot(uri, scheme, settings, projectRoot)` — thin wrapper over
  `resolveWaypointPath` (the bare-filename rule is a no-op for directory-style URIs); used where
  a waypoint composes paths under a root (`md://` dir mode)

## `md://` dir mode — write intents

A tool never names an output root. It appends an entry to the `mdOutputs` variable (the target also still reads legacy `mdOutputs` variable):

```typescript
{
  name: 'schema-doc',      // logical slot, used in diagnostics
  subdir: 'schema',        // relative to the target root; '' = root itself
  filename: 'chapter1.schema.md',  // basename only
  content: '…',
}
```

The `md://` target resolves the root in `open()` (`absolute URI path` → `waypoint.md.defaultFolder` →
`project.root`) and writes `join(root, subdir, filename)` per intent, atomically. `subdir` must be
relative and free of `..`; `filename` must be a basename. Violations throw — they are tool bugs, not
paths to normalize. `dir` is a deprecated alias for `subdir` (removed next release).

Consequence: retargeting `.to('md://./out')` moves every intent, and tools stay reusable across
layouts. `md://<file>` single-file mode ignores `mdOutputs` entirely.

## Adding a New URI Scheme

1. Create `packages/waypoint/src/<scheme>.ts` implementing `Source<T>` and/or `Target<T>`
2. Call `registry.registerSource('<scheme>', factory)` and/or `registry.registerTarget('<scheme>', factory)` at module level (side-effect)
3. Re-export from `packages/waypoint/src/index.ts`
4. Write tests in `packages/waypoint/tests/builtins/`

## Tests

```
packages/waypoint/tests/builtins/
├── jsonl.test.ts          # JSONL read/write, glob source
├── md.test.ts             # Markdown source/target
├── chapter-output.test.ts # lang/chapterNum path-validation rejections + happy path
├── http-server.test.ts    # HTTP source (real Fastify server)
├── git-worktree.arch.test.ts
├── range.test.ts / range.arch.test.ts   # integer generator: directions, step, validation, resume skip
├── void.test.ts / void.arch.test.ts     # sink no-ops; source-side resolution must throw
├── console.test.ts / console.arch.test.ts # terminal sink formatting, prefix/envelope/stream, target-only registration
├── review.test.ts / review.arch.test.ts # glossary review queue render + atomic write; target-only registration
├── entity-buffers.test.ts # entity buffer schemes: source-only rungs, temp:// write side, namespace isolation
└── settings.test.ts
```

Architecture tests (`.arch.test.ts`) verify the registered schemes and interface shapes without full I/O.

## WP index (planned-scheme spec)

The WP001–WP013 entries below are the planned-scheme spec index for the waypoint catalogue.

| ID   | Waypoint         | Source | Target | Lifestyle     | Used in Samples                           |
|------|------------------|--------|--------|---------------|-------------------------------------------|
| WP001 | jsonl://         | ✓      | ✓      | resumable     | sample1, sample2, sample3, sample4                 |
| WP002 | md://            | ✓      | ✓      | resumable     | sample1, sample2, sample3, sample4, sample5        |
| WP003 | hs:// / http://  | ✓      | —      | long-lived    | sample1, sample2                          |
| WP004 | my-target://| ✓      | ✓      | resumable     | sample3                                   |
| WP005 | schema-doc://    | ✓      | ✓      | resumable     | — (sample3 writes schema docs via `md://` write intents, not this scheme) |
| WP006 | git://           | ✓      | ✓      | resumable     | —                                         |
| WP007 | ephemeral://     | ✓      | ✓      | resumable     | sample2, sample3                          |
| WP008 | range://         | ✓      | —      | resumable     | sample2                                   |
| WP009 | void://          | —      | ✓      | —             | sample2                                   |
| WP010 | review://        | —      | ✓      | —             | —                                         |
| WP011 | chapters:// / paragraphs:// / chunks:// / tokens:// / lines:// / words:// | ✓ | — | resumable | sample2 (`paragraphs://`, `chunks://`, `tokens://`, `lines://`, `words://`; `chapters://` unused) |
| WP012 | temp:// | — | ✓ | — | sample2 (write side of the ladder rungs) |
| WP013 | console:// | — | ✓ | — | sample2 (`consolePreviewPipeline`) |

---

| Index | ID    | Name                | Source | Target | Lifestyle  | Input     | Output    | Description                                                                                                                               |
|:------|-------|---------------------|--------|--------|------------|-----------|-----------|-------------------------------------------------------------------------------------------------------------------------------------------|
| 1     | WP001 | `jsonl://`          | ✓      | ✓      | resumable  | `unknown` | `unknown` | JSONL file source/target; supports glob patterns for source; position cursor for resume; atomic write with temp file.                     |
| 2     | WP002 | `md://`             | ✓      | ✓      | resumable  | `string`  | `string`  | Markdown directory source/target; dir mode supports `mdOutputs` variable write intents (subdir + filename); single-file mode ignores intents. |
| 3     | WP003 | `hs://` / `http://` | ✓      | —      | long-lived | `unknown` | —         | Long-lived HTTP server source; POST ingest, GET /health, GET /events (SSE fan-out); no resume support.                                    |
| 4     | WP004 | `my-target://` | ✓      | ✓      | resumable  | `string`  | `string`  | Chapter-specific layout: `<base-dir>/<lang>/chapter<num>.md`; validates `meta.lang` and `meta.chapterNum`; atomic per-file writes.        |
| 5     | WP005 | `schema-doc://`     | ✓      | ✓      | resumable  | `string`  | `string`  | Schema document source/target; custom YAML + CSV format; per-chapter `<dir>/chapter<num>.schema.md`.                                      |
| 6     | WP006 | `git://`            | ✓      | ✓      | resumable  | varies    | varies    | Git worktree isolation wrapper; composites with inner scheme via `git+`; auto-commit on close with `commit=on-close`.                     |
| 7     | WP007 | `ephemeral://`      | ✓      | ✓      | resumable  | `T`       | `T`       | In-memory buffer keyed by URI path; for testing and in-memory pipelines; process-local, no persistence.                                   |
| 8     | WP008 | `range://`          | ✓      | —      | resumable  | —         | `number`  | Integer range producer; `range://<start>..<end>` inclusive, both directions, `?step=N` magnitude; source-only.                              |
| 9     | WP009 | `void://`           | —      | ✓      | —          | `T`       | —         | Discard sink (like /dev/null); open/write/close no-ops; deliberately no `checkpoint()`; target-only.                                       |
| 10    | WP010 | `review://`         | —      | ✓      | —          | `Glossary`| `string`  | Glossary review-queue renderer: pending proposals (`term.pending`) + locked terms as a markdown worksheet; atomic write on close; target-only. |
| 11    | WP011 | `chapters://` / `paragraphs://` / `chunks://` / `tokens://` / `lines://` / `words://` | ✓ | — | resumable | — | `T` | Entity-level **source-only** ladder views over the in-memory buffer: one key space per entity scheme, optional namespace path; process-local, no persistence. |
| 12    | WP012 | `temp://<entity>/<namespace>` | — | ✓ | — | `T` | — | Target-only in-memory write side for an entity buffer; `temp://chunks/ladder` fills the buffer that `chunks://ladder` reads. |
| 13    | WP013 | `console://` | — | ✓ | — | `T` | — | Target-only terminal sink; prints each envelope to stdout/stderr immediately; `format=auto\|json\|pretty`, optional `prefix`, `envelope`, `stream`; deliberately no `checkpoint()`. |

## Structure Ladder

The **Structure Ladder** is the descent from a whole document to its smallest units. It is a tree: below
`chunks://` it branches into the text descent and the token descent.

```
jsonl:// → md:// → chunks:// ─┬→ paragraphs:// → lines:// → words://
                              └→ tokens://
```

Each rung is a
URI scheme plus an entity type; descending one rung is a cardinality change, so it happens through a DSL op
(`.flatMap()` fans one envelope out into many, `.batch()` groups many into one).

| Level | Scheme          | Entity type | Typical op             |
|-------|-----------------|-------------|------------------------|
| 0     | `jsonl://`      | record      | `.from()`              |
| 1     | `md://`         | document / chapter | `.flatMap()` (split into chapters) |
| 2     | `chunks://`     | chunk       | `.subflow('#chunks')` (registered splitter; token-bounded chunks) |
| 3     | `paragraphs://` | paragraph   | `.flatMap()` (split a chunk into paragraphs; carry `chunkId`) |
| 4     | `lines://`      | line        | `.flatMap()` (split into lines) |
| 5     | `words://`      | word        | `.batch()` (group words) |
| alt   | `tokens://`     | token       | `.flatMap()` (chunk → BPE tokens; sibling of `paragraphs://`, parent `chunks://`) |

**Chunks are the coarsest rung under the document.** A document is first split into token-bounded,
`---`-separated chunks (the fixated text units sent to the LLM for translation); each chunk is then
descended into paragraphs, lines and words. A chunk is the largest unit that still fits one request; it
does not group paragraphs, paragraphs are derived from it (and carry its `chunkId`). The `chunkSplit` tool
(`@mt/tools`) fixates a chapter into `---`-separated chunks; `chunkClean` strips the separators again.

Descent with the registered splitter — one chapter in, its chunks out:

```typescript
import { definePipeline } from '@mt/core'
import '@mt/tools'                          // registers chunks/paragraphs/lines/words/series splitters

export default definePipeline()
  .from('md://./chapters/')                 // level 1 — one envelope per chapter (string body)
  .subflow('#chunks')                       // level 2 — chapter markdown → Chunk[] (MT_CHUNK_SIZE)
  .to('temp://chunks/chapters')             // level 2 — write the chunks into the in-memory buffer
```

The `chunks` splitter is the shipped form of the manual `readChapterDoc` + `splitIntoChunks` +
`heuristicTokenCount` glue; the token budget follows `meta.chunkSize` → tool option → mt.json
`settings.chunkSize` → `MT_CHUNK_SIZE` → `DEFAULT_CHUNK_TARGET`.

**Alternate route: `chunks → tokens`.** Instead of descending into paragraphs, a chunk can be tokenized into
tiktoken-style BPE tokens (`Token`: `chunkId`, `tokenId`, decoded `text`) — what the LLM actually sees. The
`chunkTokenize` tool / `tokenizeChunk()` helper (`@mt/tools`, `gpt-tokenizer`; ~4 chars/token fallback flagged
`heuristic`) does the split. Demonstrated by `tokenLadderPipeline` in sample2.

Rung 0 (`jsonl://`) is the entry point for machine-readable input; rungs 2–5 and `tokens://` are process-local buffers, so
a ladder that crosses a process boundary must re-enter through a file waypoint (`jsonl://`, `md://`). These rungs are
source-only: a stage writes with `.to('temp://<rung>/<namespace>')` and the next stage reads `.from('<rung>://<namespace>')`.
Use `batches://` when a package must survive the hop between pipelines as one envelope (it is not a ladder rung).

### Batch scope waypoints: `batch://group|members|return`

Scope-local views of `.batch(opts, nested)` (see [core.md](core.md#batch-scope-batchopts-nested)); no namespace, no global buffer - they read/write `RunContext.batchScope`.

| URI | Kind | Meaning |
|---|---|---|
| `batch://group` | source | The package as ONE exchange (`item` = `items[]`, members carried for batch-aware tools) |
| `batch://members` | source | Each member as its own exchange (own id/meta/variables, `meta.batchIndex`, group edits stamped on) |
| `batch://return` | target | Hand a result back: group exchange -> its changed variables reach all members; member exchange -> replaces that member by id |

Outside a batch scope they throw. No `resume()`: scope state is in-memory, a resumed run replays the scope.

## Composing Waypoints: `defineWaypoint`

`defineWaypoint(source|target, hooks)` wraps an existing Source/Target **instance** with lifecycle hooks
— no new scheme registration needed:

- Source hooks: `onStart`, `filter` (drop envelopes), `onItem`
- Target hooks: `onOpen`, `onWrite`, `onClose`

Demonstrated in `samples/sample4/pipelines/waypoint-log.ts`, which re-runs the sample4 normalize chain
with an audit-logging `jsonl://` source and `md://` target. The base accepts a URI string or an instance
(`defineSource(...)` / `defineTarget(...)`); the sample passes instances so the wrapped endpoints are built
explicitly next to their hooks.
