# @mt/router
← [Architecture](../architecture.md)

Path: `packages/router/`

Standalone Nuxt/Nitro app. OpenAI-compatible reverse proxy in front of OpenRouter. Runs on a configurable port (default 7777). **Standalone** — zero `@mt/*` dependencies (no imports, no `package.json` deps), enforced by [packages/router/tests/layers.arch.test.ts](../../packages/router/tests/layers.arch.test.ts).

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
├── models.ts               # GET /api/models — OpenAI-style list of routable model ids
├── health.ts               # GET /api/health
└── logs.ts                 # GET /api/logs — recent request logs
```

### Models endpoint

`GET /api/models` -> `{ object: 'list', data: [{ id, object: 'model', owned_by }] }`. Ids are routable as is:
default upstream = bare OpenRouter id (always includes the `openrouter/free` alias, plus configured `models`);
other upstreams = `<upstream>/<model>` from vault/config `models` merged with a live listing (`<baseUrl>/models`,
ollama `/api/tags`), cached 60s, 2s timeout. Live failures are swallowed (configured models still listed); keys and
upstream bodies never appear. Token middleware applies (unlike `GET /api/health`).
Impl: `server/utils/models-list.ts`. Client helper: `listRouterModels` in `@mt/tools`.

## Key Utilities

### `server/utils/openrouter-pool.ts`
Router-local key pool (`OpenRouterPool` + `OpenRouterPoolSupplier`): round-robin, 429 block, 402 disable, TTL recreate.
Deliberate copy of the same half of `packages/tools/src/core/openrouter-pool.ts` — the standalone rule beats
single-sourcing it, so keep both in sync when pool semantics change.

### `server/utils/openrouter-pool-supplier.ts`
Wraps the router-local pool for use inside Nitro context, building clients from the effective router config
(`getRouterConfig().apiKeys`) so CLI flags and `secrets.envFile` reach the pool. Returns the shared pool singleton.

### `server/utils/upstream.ts` / `upstream-spec.ts`
Upstream registry (T117). `Upstream = { name, kind: openrouter|ollama|openai-compat, baseUrl, keys, headers, models, defaultModel }`,
each with its own `OpenRouterPool` (round-robin / 429 / 402). The default upstream `openrouter` is always present, built from
`apiKeys`, and reuses the shared pool singleton. Extra upstreams come from `RouterConfig.upstreams` (env
`MT_ROUTER_UPSTREAMS`, `MT_ROUTER_OLLAMA_URL`, or code) plus the vault (T118, below).

Routing (`registry.resolve(model)`): `<name>/<model>` where `<name>` is a registered **non-default** upstream routes there and
the prefix is stripped (`ollama/gemma4:latest` -> ollama, `gemma4:latest`). Everything else — bare ids, `openrouter/free`,
`openrouter/auto`, unknown prefixes — goes to the default upstream unchanged. Keyless upstreams (no keys) send no
`Authorization` header. Ollama `baseUrl` gets `/v1` appended if missing. Non-openrouter upstreams log cost 0; log entries gain an
optional `upstream` field. `/api/pool` adds `upstreams[]` (name, kind, keyless, counts; never key values).

### `server/utils/vault-reader.ts` / `vault-upstreams.ts`
Vault feeding (T118). `vault-reader.ts` is a **deliberate duplicate** of the read half of `packages/core/src/vault.ts`
(router must import no `@mt/*`): same format (`{version:1, entries}`), same lookup (`MT_VAULT` only, else `$MT_HOME|~/.mt/vault.json`
then `<cwd>/.mt/vault.json`, project wins per entry). Keep both in sync. Errors name path + entry only, never content/keys.
`vault-upstreams.ts` maps entries: `ollama` -> `ollama` (baseUrl default `http://localhost:11434`), `openai`/`custom` ->
`openai-compat` (baseUrl required), `openrouter` -> keys appended to the default `openrouter` pool (after env keys, deduped),
`router` ignored, `anthropic`/unusable entries skipped with a warning. Name = entry name; `apiKey`/`apiKeys`, `headers`,
`models`, `defaultModel` carried over. Env/`RouterConfig.upstreams` win on name conflicts.
Hot reload: on request, vault file mtimes+size are re-stat'ed at most every 2s (`MT_ROUTER_VAULT_POLL_MS`); on change the
registry is rebuilt and swapped; unchanged upstreams keep their pool state. Broken file: warning, previous entries kept
(first load: env-only). Missing vault = env-only. `RouterConfig.vault` / `MT_ROUTER_VAULT=false` disables. `/api/health`
shows entry names only; no key or file content in `/api/pool`, `/api/dashboard`, logs or errors.

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

## Security Model (T119)

Router is a keyless gateway: clients send no upstream key; router holds them (env + vault). Keyless must not mean open.

- **Bind guard** (`utils/bind-guard.ts`): default host `localhost`. A non-loopback `MT_ROUTER_HOST` / `--host` without
  `MT_ROUTER_TOKEN` makes `startRouter()` throw (clear fix hint) before listening.
- **Token** (`middleware/auth.ts`, runs before `rate-limit`): when `MT_ROUTER_TOKEN` is set, every `/api/*` request except
  `GET /api/health` needs `Authorization: Bearer <token>` (constant-time compare), else 401. Unset: open (loopback only).
  Static dashboard files are served without auth but its `/api` calls need the token when set.
- **Header strip**: `completions.ts` builds upstream headers from scratch (content-type, optional http-referer/x-title,
  upstream key, registry headers). Client `Authorization`, `x-api-key`, cookies and the router token are never forwarded.
- **Redaction** (`utils/redact.ts`): all known keys (env, vault, upstream specs, router token) plus `Bearer <x>` / `sk-...`
  patterns become `***` in upstream error echo, proxy errors, the global error handler, log lines, `/api/logs`, and
  console errors. `/api/pool`, `/api/health`, `/api/dashboard` expose names and counts only.
- Rate-limit / daily budget semantics unchanged. Not done: per-client budget (`X-MT-Client`, `MT_CLIENT_BUDGET`).
- **Tools side**: `mt` tools with provider `router` send `Authorization: Bearer ${MT_ROUTER_TOKEN}` when that env is set
  (`llm-config.ts` provider env keys; `MT_LLM_API_KEY` still wins). No key otherwise.

## Dashboard UI (`public/app.js`)

Vanilla JS SPA (no framework). Vue-like reactive state (`setup`, `ref`). Sections:
- `useDashboard()` — cost totals, model breakdown
- `usePool()` — key pool status, exhausted/active counts
- `useLogs()` — recent request log with latency and cost

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEYS` | — | Comma-separated keys |
| `MT_ROUTER_UPSTREAMS` | — | JSON array of upstream specs `{name,kind,baseUrl,keys?,headers?,models?,defaultModel?}` |
| `MT_ROUTER_OLLAMA_URL` | — | Registers keyless `ollama` upstream (e.g. `http://gpu:11434`) |
| `MT_VAULT` | — | Vault file path override (only that file is read) |
| `MT_ROUTER_HOST` | `localhost` | Bind host; non-loopback requires `MT_ROUTER_TOKEN` |
| `MT_ROUTER_TOKEN` | — | Bearer token required on `/api/*` (except `GET /api/health`); also read by tools provider `router` |
| `MT_ROUTER_VAULT` | `true` | `false` disables vault loading |
| `MT_ROUTER_VAULT_POLL_MS` | `2000` | Min interval between vault mtime checks |
| `MT_MOCK` | `false` | Enable mock mode |
| `PORT` | `7777` | Router listen port |
| `MT_LOG_RETENTION_DAYS` | `30` | Log file retention |

## Tests

```
packages/router/tests/
├── upstream-registry.test.ts # resolve() + handler routing vs fake upstream
├── vault-upstreams.test.ts # vault reader, entry mapping, hot reload, no-leak
├── routes.arch.test.ts    # Arch: all expected routes exist
└── middleware.arch.test.ts # Arch: rate-limit middleware shape
```

## Running

```bash
pnpm dev --filter=@mt/router     # Dev with hot reload
pnpm build --filter=@mt/router   # Build .output/
node packages/router/.output/server/index.mjs  # Run built output
```
