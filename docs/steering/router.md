# @mt/router

Path: `packages/router/`

Standalone Nuxt/Nitro app. OpenAI-compatible reverse proxy in front of OpenRouter. Runs on a configurable port (default 7777). **Standalone** — has no dependency on any other `@mt/*` package except optional shared config types.

## Purpose

- Pools multiple OpenRouter API keys (round-robin)
- Tracks per-run cost and usage
- Enforces rate limits (daily/per-minute)
- Supports mock mode for deterministic tests
- Provides a dashboard UI (`/public/app.js`) with cost and pool status

## Server Routes

```
packages/router/server/routes/api/
├── chat/completions.ts     # POST /api/chat/completions — OpenAI-compatible proxy endpoint
├── translate.ts            # POST /api/translate — translation shortcut with prompt building
├── translate/
│   ├── health.ts           # GET /api/translate/health
│   └── config.ts           # GET /api/translate/config
├── dashboard.ts            # GET /api/dashboard — cost + pool stats for UI
├── pool.ts                 # GET /api/pool — pool status
├── health.ts               # GET /api/health
└── logs.ts                 # GET /api/logs — recent request logs
```

## Key Utilities

### `server/utils/openrouter-pool-supplier.ts`
Wraps the key pool from `@mt/tools` for use inside Nitro context. Returns the shared pool singleton.

### `server/utils/cost-tracker.ts`
- `logCall(model, usage, cost)` — appends to rolling log files under `~/.mt/router/<YYYY-MM-DD>/log.json`
- `getMonthlyCost()` / `getDailyCost()` — aggregate cost summaries
- Rolling logs: 5 MB max, retained N days

### `server/utils/log-rotator.ts`
- `rotateLogs()` — removes old log files beyond retention window

### `server/plugins/mock-mode.ts`
- `isMockMode()` — true when `MT_MOCK=true` env var is set
- `mockModePlugin` — intercepts OpenRouter calls with deterministic responses

### `server/plugins/log-rotation.ts`
- `logRotationPlugin` — runs `rotateLogs()` on server start

### `server/middleware/rate-limit.ts`
- Per-IP rate limiting; `getSecondsUntilMidnight()` for daily reset timing

## `completions.ts` Implementation Notes

- Forwards request to OpenRouter with a pooled API key
- Handles streaming (`stream: true`) via `toNodeReadable()` helper
- On 429: marks key exhausted, retries with next key
- On 402: removes key permanently from pool
- Appends cost data via `cost-tracker`

## Dashboard UI (`public/app.js`)

Vanilla JS SPA (no framework). Vue-like reactive state (`setup`, `ref`). Sections:
- `useDashboard()` — cost totals, model breakdown
- `usePool()` — key pool status, exhausted/active counts
- `useLogs()` — recent request log with latency and cost

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEYS` | — | Comma-separated keys |
| `MT_MOCK` | `false` | Enable mock mode |
| `PORT` | `7777` | Router listen port |
| `MT_LOG_RETENTION_DAYS` | `30` | Log file retention |

## Tests

```
packages/router/tests/
├── routes.arch.test.ts    # Arch: all expected routes exist
└── middleware.arch.test.ts # Arch: rate-limit middleware shape
```

## Running

```bash
pnpm dev --filter=@mt/router     # Dev with hot reload
pnpm build --filter=@mt/router   # Build .output/
node packages/router/.output/server/index.mjs  # Run built output
```
