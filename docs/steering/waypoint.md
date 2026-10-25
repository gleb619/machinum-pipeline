# @mt/waypoint
← [Architecture](../architecture.md)

Path: `packages/waypoint/`

Source and Target implementations for the URI registry. Import as a **side-effect** to register all schemes:

```typescript
import '@mt/waypoint'
```

This registers: `jsonl://`, `md://`, `hs://` / `http://`, `chapter://`, `schema-doc://`, `git://`.

## URI Scheme Reference

| Scheme | File | Source | Target | Notes |
|---|---|---|---|---|
| `jsonl://./file.jsonl` | `jsonl.ts` | ✓ | ✓ | Supports glob patterns for source |
| `md://./chapters/` | `md.ts` | ✓ | ✓ | Markdown files in directory |
| `hs://` / `http://` | `http-server.ts` | ✓ | — | Long-lived HTTP POST endpoint |
| `chapter://./en/` | `chapter-output.ts` | ✓ | ✓ | Language-folder chapter layout |
| `schema-doc://./docs/` | `schema-doc.ts` | ✓ | ✓ | Per-chapter schema doc files |
| `git://<path>?branch=<b>` | `git-worktree.ts` | ✓ | ✓ | Git worktree isolation; optional auto-commit on close |

## Source/Target Shape

Every implementation follows the `Source<T>` / `Target<T>` interfaces from `@mt/core`.

```typescript
// Source: async generator
class JsonlSource implements Source<unknown> {
  uri: string
  lifestyle: 'resumable'
  async *start(ctx: SourceContext): AsyncIterable<Envelope<unknown>> { … }
  async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<unknown>> { … }
}

// Target: open/write/close lifecycle
class JsonlTarget implements Target<unknown> {
  uri: string
  async open(ctx: TargetContext): Promise<void> { … }
  async write(env: Envelope<unknown>, ctx: TargetContext): Promise<void> { … }
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
`chapter-output://`, `ephemeral://` and `schema-doc://`.

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
- Each line must be a JSON object with an `item` property (`{ item, meta? }`); a missing `meta`
  defaults to `{}`. Malformed JSON or a missing/invalid `item`/`meta` throws with a `file:line`
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
- Both implement `lifestyle: 'resumable'`

### `schema-doc.ts`
- Parses/serialises custom schema-doc format (YAML + CSV sections)
- `parseSchemaDoc()` / `extractTextContent()` helpers

### `settings.ts`
- `getWaypointSetting(key)` — reads from `mt.json` waypoint section
- `resolveWaypointPath(uri, scheme, settings)` — bare-filename `defaultFolder` rule for file-style
  waypoints (returns the raw path when it already contains a directory separator)
- `resolveWaypointRoot(uri, scheme, settings, projectRoot)` — absolute base directory, independent of
  `process.cwd()`; used where a waypoint composes paths under a root (`md://` dir mode)

## `md://` dir mode — write intents

A tool never names an output root. It appends a `meta.mdOutputs` intent:

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
├── http-server.test.ts    # HTTP source (real Fastify server)
├── git-worktree.arch.test.ts
└── settings.test.ts
```

Architecture tests (`.arch.test.ts`) verify the registered schemes and interface shapes without full I/O.
