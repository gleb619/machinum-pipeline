# @mt/backend

Path: `packages/backend/`

Nuxt/Nitro admin server. Serves the Vue frontend, REST API for run management, and SSE event stream from `events.jsonl`. Uses SQLite as an indicator/metadata store (v1 — not the source of truth; `.mt/` files remain canonical).

## API Routes

```
packages/backend/server/routes/api/
├── health.ts                         # GET /api/health
├── pipelines.ts                      # GET /api/pipelines — list discovered pipelines
├── runs/
│   ├── index.ts                      # GET /api/runs — list all runs
│   ├── start.ts                      # POST /api/runs — start a new run
│   ├── [id].ts                       # GET /api/runs/:id — run metadata
│   └── [id]/
│       ├── items.ts                  # GET /api/runs/:id/items — paginated envelope list
│       ├── events.ts                 # GET /api/runs/:id/events — SSE stream
│       ├── pause.ts                  # POST /api/runs/:id/pause
│       └── resume.ts                 # POST /api/runs/:id/resume
```

## SSE Events (`events.ts`)

Tails `.mt/runs/<runId>/events.jsonl` using file watching. Sends each appended JSON line as an SSE `data:` message. Client reconnection is handled via `Last-Event-ID` header.

## SQLite (`server/plugins/sqlite.ts`, `server/utils/sqlite.ts`)

- `sqlitePlugin` — initializes DB on server start, creates tables if missing
- `initSqlite()` / `getDb()` / `closeSqlite()` — singleton DB access
- v1: only stores run index for quick listing (canonical data is in `.mt/` files)

## Runner Registry (`server/utils/runner-registry.ts`)

In-process registry mapping `runId → Runner` for runs started via the API. Methods: `registerRunner`, `getRunner`, `removeRunner`.

Used by `/api/runs/:id/pause` and `/api/runs/:id/resume` to reach the live Runner object.

## Frontend Integration

The Vue 3 frontend (`@mt/frontend`) is bundled into backend at build time. Nitro serves it from `public/` in the built output. In dev, Vite proxy handles frontend requests.

## Key Files

```
packages/backend/
├── nitro.config.ts       # Nitro config: port, publicDir, SQLite plugin
├── vitest.config.ts
├── server/
│   ├── plugins/
│   │   └── sqlite.ts
│   ├── routes/api/…
│   └── utils/
│       ├── sqlite.ts
│       └── runner-registry.ts
└── tests/
    ├── db.arch.test.ts       # Arch: SQLite schema and migrations
    ├── routes.arch.test.ts   # Arch: expected routes present
    └── api/
        ├── runs.arch.test.ts # Arch: runs API shape
        └── events.arch.test.ts
```

## Important Constraints

- The backend reads `.mt/` files for canonical data — never writes them (only the Runner does)
- SQLite is a queryable index, not the source of truth
- `runner-registry` only holds Runners for the current process lifetime — cross-process runs need file-based coordination

## Running

```bash
pnpm dev --filter=@mt/backend     # Dev with hot reload (Nuxt dev server)
pnpm build --filter=@mt/backend   # Build + bundle frontend into .output/
```

Or via CLI: `mt serve` (in-process) / `mt serve --detach` (background process).
