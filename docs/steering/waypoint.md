# @mt/waypoint
← [Architecture](../architecture.md)

Path: `packages/waypoint/`

Source and Target implementations for the URI registry. Import as a **side-effect** to register all schemes:

```typescript
import '@mt/waypoint'
```

This registers: `jsonl://`, `md://`, `hs://` / `http://`, `chapter://`, `schema-doc://`, `git://`, `range://`, `void://`, `review://`.

## URI Scheme Reference

| Scheme | File | Source | Target | Notes |
|---|---|---|---|---|
| `jsonl://./file.jsonl` | `jsonl.ts` | ✓ | ✓ | Supports glob patterns for source |
| `md://./chapters/` | `md.ts` | ✓ | ✓ | Markdown files in directory |
| `hs://` / `http://` | `http-server.ts` | ✓ | — | Long-lived HTTP POST endpoint |
| `chapter://./en/` | `chapter-output.ts` | ✓ | ✓ | Language-folder chapter layout |
| `schema-doc://./docs/` | `schema-doc.ts` | ✓ | ✓ | Per-chapter schema doc files |
| `git://<path>?branch=<b>` | `git-worktree.ts` | ✓ | ✓ | Git worktree isolation; optional auto-commit on close |
| `range://<start>..<end>` | `range.ts` | ✓ | — | Integer generator; `?step=` magnitude, direction derived |
| `void://` | `void.ts` | — | ✓ | Discards everything (like /dev/null) |
| `review://./out.md` | `review.ts` | — | ✓ | Glossary pending-proposals review queue as markdown |

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
`chapter-output://`, `ephemeral://`, `schema-doc://` and `range://`.

## Atomicity Contract (hard rule)

> File writes are atomic (temp-then-rename).

Every waypoint target writes through the helpers in `@mt/core`:

| Helper | Use |
|---|---|
| `atomicWriteFile(path, data)` | Whole-file write: temp sibling → `rename` |
| `AtomicStreamWriter.open(path, runId)` | Streamed write; `commit()` renames on `close()`, `abort()` drops the temp |
| `removeStaleTmpFiles(path)` | Sweep temp files left by an interrupted run |

Target shapes:

- **Per-file targets** (`chapter-output://`, `schema-doc://`, `md://<dir>`) call `atomicWriteFile`
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
per-envelope fan-out, and unsubscribes in the generator's `finally`.

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
├── review.test.ts / review.arch.test.ts # glossary review queue render + atomic write; target-only registration
└── settings.test.ts
```

Architecture tests (`.arch.test.ts`) verify the registered schemes and interface shapes without full I/O.
