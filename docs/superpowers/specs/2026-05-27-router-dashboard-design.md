# Router Dashboard — Design Spec
Date: 2026-05-27

## Overview

Add a Vue 3 + Tailwind SPA dashboard to `@mt/router` (Nitro server). Served from `public/` as static assets. No Nuxt migration — Nitro natively serves `public/` at root. Dashboard shows real-time API usage, cost, pool health, and request logs.

## Architecture

```
packages/router/
  public/
    index.html        # app shell; loads Vue 3 + Tailwind via CDN
    app.js            # Vue 3 Composition API SPA
  server/routes/api/
    logs.ts           # GET /api/logs?date=YYYY-MM-DD&limit=N
    pool.ts           # GET /api/pool
    dashboard.ts      # existing — unchanged
    health.ts         # existing — unchanged
```

No new npm dependencies. Vue 3 and Tailwind loaded from CDN (esm.sh / cdn.tailwindcss.com).

## API Endpoints

### `GET /api/logs?date=YYYY-MM-DD&limit=50`

Returns recent `LogEntry[]` from the JSONL log for the given date (default: today). Sorted newest-first. `limit` defaults to 50, max 200.

Response:
```json
{ "entries": [{ "timestamp": "", "runId": "", "stepId": "", "model": "", "promptTokens": 0, "completionTokens": 0, "cost": 0 }] }
```

### `GET /api/pool`

Returns pool runtime state.

Response:
```json
{ "mockMode": false, "totalKeys": 3, "activeKeys": 2, "rateLimitedKeys": 1, "blockedKeys": 0 }
```

Note: key count derived from `poolSupplier.getPool()` size methods. No key values exposed.

## Dashboard Layout

```
┌─────────────────────────────────────────────────────┐
│ MT Router Dashboard   [MOCK badge]    ↻ auto-30s    │
├──────────┬──────────┬──────────┬────────────────────┤
│ Today    │ Today    │ Monthly  │ Budget             │
│ N calls  │ $X.XX    │ $X.XX    │ ████░░ $X.XX left  │
├──────────┴──────────┴──────────┴────────────────────┤
│ Pool Status: N active · N rate-limited · N blocked  │
├─────────────────────────────────────────────────────┤
│ Model Breakdown (today)                             │
│ model-name        calls     cost                    │
├─────────────────────────────────────────────────────┤
│ Recent Requests (last 50)                           │
│ time  model  runId  stepId  prompt  compl   cost    │
└─────────────────────────────────────────────────────┘
```

## Component Structure (app.js)

Single-file Vue 3 app (no SFC compilation):

- `useDashboard()` composable: fetches `/api/dashboard`, auto-refreshes every 30s
- `usePool()` composable: fetches `/api/pool`
- `useLogs()` composable: fetches `/api/logs`
- Components (plain objects): `SummaryCard`, `BudgetGauge`, `PoolStatus`, `ModelTable`, `LogsTable`

## UX Details

- Dark theme (Tailwind `slate-900` bg, `slate-800` cards)
- Budget gauge: colored bar — green >50%, yellow 20–50%, red <20%
- Mock mode: orange badge in header when active
- Pool health: green dot (all active), yellow (some rate-limited), red (all blocked)
- Logs table: `font-mono text-xs`, `runId`/`stepId` truncated to 8 chars with full value on hover
- Cost values: always 4 decimal places (`$0.0084`)
- Timestamps: local time, `HH:mm:ss` format

## Error Handling

- Fetch errors: show inline error banner, retain stale data
- Empty state: "No data yet" placeholder in each section

## Testing

Playwright smoke tests via `playwright-cli` skill:
- Dashboard loads (HTTP 200 on `/`)
- Summary cards render (4 cards visible)
- Auto-refresh fires (data updates after mock interval)
- Pool status section visible
- Logs table renders (or empty state)

## Out of Scope

- Authentication
- Historical charts / time-series graphs
- Log filtering / search
- WebSocket live updates (polling is sufficient)
