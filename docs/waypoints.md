# Waypoints

Source and Target implementations for the URI registry. Import as a **side-effect** to register all schemes:

```typescript
import '@mt/waypoint'
```

All waypoints follow `Source<T>` / `Target<T>` interfaces from `@mt/core` with async generator start/resume for sources and open/write/close lifecycle for targets.

## Waypoint Index

| ID   | Waypoint         | Source | Target | Lifestyle     | Used in Samples                           |
|------|------------------|--------|--------|---------------|-------------------------------------------|
| WP001 | jsonl://         | ✓      | ✓      | resumable     | sample1, sample2, sample3                 |
| WP002 | md://            | ✓      | ✓      | resumable     | sample1, sample2, sample3                 |
| WP003 | hs:// / http://  | ✓      | —      | long-lived    | sample1                                   |
| WP004 | chapter-output://| ✓      | ✓      | resumable     | sample2                                   |
| WP005 | schema-doc://    | ✓      | ✓      | resumable     | sample2                                   |
| WP006 | git://           | ✓      | ✓      | resumable     | —                                         |
| WP007 | ephemeral://     | ✓      | ✓      | resumable     | sample2                                   |

---

| Index | ID    | Name                | Source | Target | Lifestyle  | Input     | Output    | Description                                                                                                                               |
|:------|-------|---------------------|--------|--------|------------|-----------|-----------|-------------------------------------------------------------------------------------------------------------------------------------------|
| 1     | WP001 | `jsonl://`          | ✓      | ✓      | resumable  | `unknown` | `unknown` | JSONL file source/target; supports glob patterns for source; position cursor for resume; atomic write with temp file.                     |
| 2     | WP002 | `md://`             | ✓      | ✓      | resumable  | `string`  | `string`  | Markdown directory source/target; dir mode supports `meta.mdOutputs` write intents (subdir + filename); single-file mode ignores intents. |
| 3     | WP003 | `hs://` / `http://` | ✓      | —      | long-lived | `unknown` | —         | Long-lived HTTP server source; POST ingest, GET /health, GET /events (SSE fan-out); no resume support.                                    |
| 4     | WP004 | `chapter-output://` | ✓      | ✓      | resumable  | `string`  | `string`  | Chapter-specific layout: `<base-dir>/<lang>/chapter<num>.md`; validates `meta.lang` and `meta.chapterNum`; atomic per-file writes.        |
| 5     | WP005 | `schema-doc://`     | ✓      | ✓      | resumable  | `string`  | `string`  | Schema document source/target; custom YAML + CSV format; per-chapter `<dir>/chapter<num>.schema.md`.                                      |
| 6     | WP006 | `git://`            | ✓      | ✓      | resumable  | varies    | varies    | Git worktree isolation wrapper; composites with inner scheme via `git+`; auto-commit on close with `commit=on-close`.                     |
| 7     | WP007 | `ephemeral://`      | ✓      | ✓      | resumable  | `T`       | `T`       | In-memory buffer keyed by URI path; for testing and in-memory pipelines; process-local, no persistence.                                   |

---

## Detailed Reference

### WP001: jsonl://

**Scheme:** `jsonl://./file.jsonl` or `jsonl://./pattern/*.jsonl`

**Source:** Streams lines from `.jsonl` file(s). Each line must be a JSON object with an `item` property (`{ item, meta? }`). Supports glob patterns (`*`, `?`, `[]`). Cursor: single file → envelope index; glob → `{ fileIndex, line }`. Blank lines are skipped and not counted.

**Target:** Accumulates envelopes into `<path>.tmp.<runId>` and renames on `close()`. `open()` sweeps stale `.tmp.` siblings to prevent duplicates on rerun. Honors `batchSize` on both start and resume.

**Atomicity:** Single-file target uses `AtomicStreamWriter` (temp → rename on close). Crash mid-run leaves final file untouched.

**Key helpers:** `isGlobPattern()`, `isGlobCursor()`, shared line reader `readLines()`/`readFiles()`.

---

### WP002: md://

**Scheme:** `md://./chapters/` (dir mode) or `md://./output.md` (single-file mode)

**Source:** Recursively discovers `.md` files in directory; yields file contents as strings with deterministic sorted order. Supports resume via cursor (skip first N envelopes).

**Target:** Two modes:
- **Dir mode** (path ends with `/`): Resolves root from URI path → `waypoint.md.defaultFolder` → `project.root`. Reads `meta.mdOutputs` intents from envelopes (`{ name, subdir, filename, content }`) and writes `join(root, subdir, filename)` atomically. Subdir must be relative and free of `..`; filename must be basename. Violations throw (tool bugs, not paths to normalize).
- **Single-file mode** (path is a file): Ignores `mdOutputs` entirely; accumulates all content into `<path>.tmp.<runId>` and renames on close.

**Atomicity:** Per-file atomic writes via `atomicWriteFile()` in dir mode; single-file uses `AtomicStreamWriter`.

**Write intents:** Tools never name output roots. They append `meta.mdOutputs`:
```typescript
{
  name: 'schema-doc',
  subdir: 'schema',
  filename: 'chapter1.schema.md',
  content: '...',
}
```

---

### WP003: hs:// / http://

**Scheme:** `hs://localhost:9876/path` or `http://localhost:9876/path`

**Source:** Long-lived HTTP server started on `start()`. No `resume()` support.

**Endpoints:**
- `POST <uri.path>` — ingest envelopes (JSON envelope in body)
- `GET /health` — health check
- `GET /events` — SSE fan-out of envelopes (read-only, never consumes buffer)

**Query options:**
- `port` — listen port (default 8080)
- `count` — stop after N envelopes yielded
- `maxBodyBytes` — reject oversized bodies with 413 (default 1 MiB)
- `maxBuffer` — answer 503 when buffer full (default 1000, `Retry-After: 1`)

**Lifecycle:** Mirrors run events (`paused`, `resumed`, `done`, `failed`) to `/events` subscribers via `ctx.events?.subscribe()`. Unsubscribes in generator's `finally`. Shutdown calls `closeAllConnections()` before `close()`.

---

### WP004: chapter-output://

**Scheme:** `chapter-output://./chapters`

**Source:** Reads chapter files from `<base-dir>/<lang>/chapter<num>.md` (lang optional → `<base-dir>/chapter<num>.md`). Validates path components; throws on unsafe lang/chapterNum.

**Target:** Writes chapters to `<base-dir>/<lang>/chapter<num>.md`. Envelope meta:
- `meta.lang` — language code (subdirectory; optional)
- `meta.chapterNum` (or legacy `meta.chapter`) — chapter number

**Path-safety:** `meta.lang` must match `/^[\p{L}\p{N}_-]+$/u` (single segment, no separators, no `..`). `meta.chapterNum` must be non-negative integer; auto-increment fallback always safe. Final path asserted inside `baseDir` via `relative()` as defence in depth.

**Atomicity:** Per-file atomic writes via `atomicWriteFile()`. Crash never leaves half-written chapter.

---

### WP005: schema-doc://

**Scheme:** `schema-doc://./docs/`

**Source:** Reads per-chapter schema docs from `<dir>/chapter<num>.schema.md`. Parses custom format (YAML frontmatter + CSV sections). Helper: `parseSchemaDoc()`, `extractTextContent()`.

**Target:** Writes per-chapter schema docs to `<dir>/chapter<num>.schema.md`. Assembles content from envelope meta (title from item, summary/entities/schema from meta). Uses `gray-matter` for YAML frontmatter parsing and `remark-parse` for markdown.

**Atomicity:** Per-file atomic writes via `atomicWriteFile()`.

---

### WP006: git://

**Scheme:** `git+jsonl://data.jsonl?branch=feat&commit=on-close` (composite with inner scheme)

**Source/Target:** Generic wrappers around any inner Source/Target with git worktree isolation. Implements `GitWorktreeSource` / `GitWorktreeTarget` from `@mt/core/engine/git-worktree-source.js`. This module only registers the `git+` composite resolver.

**Composite resolver:** Parses inner scheme (e.g., `jsonl://`) and injects `_inner_scheme` query param for the worktree wrappers.

**Auto-commit:** When `commit=on-close` query param is set, target calls `autoCommit()` in `close()`. Merges worktree branch onto base branch via `mergeWorktreeToMain()` (rebase inside worktree, fast-forward in repoRoot only if base branch is checked-out and clean). Stages only target's output path (git pathspec commit), never `git add -A`.

**Base branch detection:** `origin/HEAD` → `init.defaultBranch` → repoRoot's current branch. Overridable via `?base=<name>`.

---

### WP007: ephemeral://

**Scheme:** `ephemeral://<buffer-name>`

**Source:** Reads all envelopes from in-memory buffer keyed by URI path. Yields current buffer contents, then completes. If no buffer exists, yields nothing. Supports resume via `resumeFrom()` helper.

**Target:** Writes envelopes to in-memory buffer keyed by URI path. Append-only; process-local, no persistence.

**Use case:** Testing and in-memory pipelines where file I/O is undesirable. Buffers are module-level `Map<string, Envelope[]>`, shared between sources and targets within the same process.

**Lifestyle:** `resumable` (cursor-based skip on resume).

---

## Adding a New Waypoint

1. Create `packages/waypoint/src/<scheme>.ts` implementing `Source<T>` and/or `Target<T>`
2. Call `registry.registerSource('<scheme>', factory)` and/or `registry.registerTarget('<scheme>', factory)` at module level (side-effect)
3. Re-export from `packages/waypoint/src/index.ts`
4. Write tests in `packages/waypoint/tests/builtins/`

**Source contract:**
```typescript
class MySource implements Source<T> {
  uri: string
  lifestyle: 'resumable' | 'long-lived'
  async *start(ctx: SourceContext): AsyncIterable<Envelope<T>> { … }
  async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>> { … }
}
```

**Target contract:**
```typescript
class MyTarget implements Target<T> {
  uri: string
  async open(ctx: TargetContext): Promise<void> { … }
  async write(env: Envelope<T>, ctx: TargetContext): Promise<void> { … }
  async close(ctx: TargetContext): Promise<void> { … }
}
```

**Atomicity rule:** All file writes must be atomic (temp file → rename). Use helpers from `@mt/core`:
- `atomicWriteFile(path, data)` — whole-file write
- `AtomicStreamWriter.open(path, runId)` — streamed write with `commit()`/`abort()`
- `removeStaleTmpFiles(path)` — cleanup on open

---

## Tests

Location: `packages/waypoint/tests/builtins/`

| Test                        | Coverage                                       |
|-----------------------------|------------------------------------------------|
| `jsonl.test.ts`             | JSONL read/write, glob source, cursor resume   |
| `md.test.ts`                | Markdown source/target, dir mode write intents |
| `chapter-output.test.ts`    | lang/chapterNum path validation, happy path    |
| `http-server.test.ts`       | HTTP source (real Fastify server)              |
| `git-worktree.arch.test.ts` | Git worktree composite resolver (architecture) |
| `settings.test.ts`          | Waypoint settings and path resolution          |

Architecture tests (`.arch.test.ts`) verify registered schemes and interface shapes without full I/O.
