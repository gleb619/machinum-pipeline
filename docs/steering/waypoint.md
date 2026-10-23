# @mt/waypoint

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

## Key Implementation Details

### `jsonl.ts`
- Source: streams lines from `.jsonl` file, supports glob patterns and a position cursor for resume
- Target: opens file handle on `open()`, appends JSON lines on `write()`, flushes on `close()`
- `isGlobPattern()` / `isGlobCursor()` helpers for glob vs direct path detection

### `http-server.ts`
- `Lifecycle: 'long-lived'` — persists across pauses/resumes
- Starts a Fastify HTTP server on `start()`; reconnects on `resume()`
- Clients POST JSON bodies; server emits Envelopes

### `git-worktree.ts`
- `GitWorktreeSource` / `GitWorktreeTarget` — use `createWorktree()` / `removeWorktree()` from `@mt/core/engine/git-worktree`
- Target calls `autoCommit()` in `close()` when `commit` query param is set
- Both implement `lifestyle: 'resumable'`

### `schema-doc.ts`
- Parses/serialises custom schema-doc format (YAML + CSV sections)
- `parseSchemaDoc()` / `extractTextContent()` helpers

### `settings.ts`
- `getWaypointSetting(key)` — reads from `mt.json` waypoint section
- `resolveWaypointPath(uri, ctx)` — resolves relative paths against project root

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
