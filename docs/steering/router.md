# @mt/router
← [Architecture](../architecture.md)

Path: `packages/router/`

Standalone Nuxt/Nitro app. OpenAI-compatible **keyless gateway** in front of OpenRouter and other
OpenAI-compatible upstreams (Ollama, vLLM, …). Runs on a configurable port (default 7777).
**Standalone** — zero `@mt/*` dependencies (no imports, no `package.json` deps), enforced by
[packages/router/tests/layers.arch.test.ts](../../packages/router/tests/layers.arch.test.ts).

## Purpose

- Acts as a **keyless gateway**: clients send no upstream key, the router holds them (env + vault)
- Pools multiple OpenRouter API keys (round-robin, 429 block, 402 disable)
- Routes a model id to an upstream by prefix (`<upstream>/<model>`)
- Tracks per-run cost and usage
- Enforces the daily spend budget on chat completions (429 + `X-RateLimit-Remaining`) and — when bound
  beyond loopback — a bearer token
- Supports mock mode for deterministic tests
- Provides a dashboard UI (`/public/app.js`) with cost and pool status

## Gateway Topology

```
   pipeline / @mt/tools (provider "router")       any OpenAI client
                   |                                            |
                   |  no upstream key                           |  optional: Bearer $MT_ROUTER_TOKEN
                   v                                            v
   +--------------------------------------------------------------------------+
   | @mt/router — keyless OpenAI-compatible gateway                           |
   | holds keys: OPENROUTER_API_KEYS + vault entries                          |
   | routes by model prefix, pools keys, tracks cost                          |
   +--------------------------------------------------------------------------+
         |                     |                        |
    openrouter/free        ollama/<model>           openai-compat/<model>
   (default upstream)      (vault/env entry)        (vault/env entry)
         |                     |                        |
         v                     v                        v
  openrouter.ai/api/v1  http://gpu-host:7869/v1    http://vllm:8000/v1
```

The router is the only component that ever holds an upstream credential. Clients speak plain
OpenAI to the router; the router attaches the key of the upstream it picked. See
[docs/vault.md](../vault.md) for the vault format and [docs/uc.md](../uc.md) (UC063–UC065) for the
end-to-end flows.

## Server Routes

```
packages/router/server/routes/api/
├── chat/completions.ts     # POST /api/chat/completions — OpenAI-compatible proxy endpoint
├── translate.ts            # POST /api/translate — translation shortcut, routed via upstream registry
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
default upstream = bare OpenRouter id (the `openrouter/free` alias is always present);
other upstreams = `<upstream>/<model>` from vault/config `models` merged with a live listing (`<baseUrl>/models`,
ollama `/api/tags`), cached 60s, 2s timeout. Live failures are swallowed (configured models still listed); keys and
upstream bodies never appear. Token middleware applies (unlike `GET /api/health`).
Impl: `server/utils/models-list.ts`. Client helper: `listRouterModels` in `@mt/tools`
(`packages/tools/src/core/router-models.ts`).

## Upstreams & Routing (T117)

`server/utils/upstream.ts` + `server/utils/upstream-spec.ts` hold the upstream registry.

`Upstream = { name, kind: openrouter|ollama|openai-compat, baseUrl, keys, headers, models, defaultModel }`,
each with its own `OpenRouterPool` (round-robin / 429 / 402). The default upstream `openrouter` is always present,
built from `apiKeys`, and reuses the shared pool singleton. Extra upstreams come from
`RouterConfig.upstreams` (env `MT_ROUTER_UPSTREAMS`, `MT_ROUTER_OLLAMA_URL`, or code) plus the vault (T118, below).

Routing (`registry.resolve(model)`): `<name>/<model>` where `<name>` is a registered **non-default** upstream routes there and
the prefix is stripped (`ollama/gemma4:latest` -> ollama, `gemma4:latest`). Everything else — bare ids, `openrouter/free`,
`openrouter/auto`, unknown prefixes — goes to the default upstream unchanged. Keyless upstreams (no keys) send no
`Authorization` header. Ollama `baseUrl` gets `/v1` appended if missing. Non-openrouter upstreams log cost 0; log entries gain an
optional `upstream` field. `/api/pool` adds `upstreams[]` (name, kind, keyless, counts; never key values).

`MT_ROUTER_UPSTREAMS` is a JSON array of upstream specs
`{name, kind, baseUrl, keys?, headers?, models?, defaultModel?}`; invalid entries are skipped with a warning.
`MT_ROUTER_OLLAMA_URL` registers the keyless `ollama` upstream (e.g. `http://gpu-host:11434`).
The name `openrouter` is reserved for the default upstream.

## Vault (T118)

`server/utils/vault-reader.ts` / `vault-upstreams.ts` feed the registry from the vault file(s).
`vault-reader.ts` is a **deliberate duplicate** of the read half of `packages/core/src/vault.ts`
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

The vault is written by `mt vault` (`packages/cli/src/commands/vault.ts`, see
[docs/steering/cli.md](cli.md#srccommandsvaultts)); the router only reads it. Format and CLI:
[docs/vault.md](../vault.md).

## Security Model (T119)

Router is a keyless gateway: clients send no upstream key; router holds them (env + vault). Keyless must not mean open.

- **Bind guard** (`utils/bind-guard.ts`): default host `localhost`. A non-loopback `MT_ROUTER_HOST` / `--host` without
  `MT_ROUTER_TOKEN` makes `startRouter()` throw (clear fix hint) before listening.
- **Token** (`middleware/auth.ts`, runs before `rate-limit`): when `MT_ROUTER_TOKEN` is set, every `/api/*` request except
  `GET /api/health` needs `Authorization: Bearer <token>` (constant-time compare), else 401. Unset: open (loopback only).
  Static dashboard files are served without auth but its `/api` calls need the token when set.
- **Header strip**: `utils/upstream-call.ts` builds upstream headers from scratch (content-type, optional http-referer/x-title,
  upstream key, registry headers). Client `Authorization`, `x-api-key`, cookies and the router token are never forwarded.
- **Redaction** (`utils/redact.ts`): all known keys (env, vault, upstream specs, router token) plus `Bearer <x>` / `sk-...`
  patterns become `***` in upstream error echo, proxy errors, the global error handler, log lines, `/api/logs`, and
  console errors. `/api/pool`, `/api/health`, `/api/dashboard` expose names and counts only.
- Rate limit = the daily spend budget only. Not done: per-client budget (`X-MT-Client`, `MT_CLIENT_BUDGET`).
- **Translate path**: `POST /api/translate` resolves its model through the upstream registry exactly like chat
  (`ollama/<m>`, vault upstream names; bare ids go to openrouter; default `openai/gpt-4o-mini`) and shares the
  forward + 429-retry + 402 + redacted-502 logic in `utils/upstream-call.ts` (`callUpstream`) with
  `chat/completions`. Keyless upstreams get no `Authorization`. Cost log uses the requested id and
  `{ upstream, free: kind !== 'openrouter' }`; response `model` is the requested id. Optional body `apiKeys`
  override only the default openrouter upstream for that call (never stored); ignored for other upstreams.
- **Tools side**: `mt` tools with provider `router` send `Authorization: Bearer ${MT_ROUTER_TOKEN}` when that env is set
  (`llm-config.ts` provider env keys; `MT_LLM_API_KEY` still wins). No key otherwise.

Arch tests pin this model: [packages/router/tests/gateway.arch.test.ts](../../packages/router/tests/gateway.arch.test.ts)
(no credential passthrough, no key literals in handlers, redaction util present) and
[packages/router/tests/security.test.ts](../../packages/router/tests/security.test.ts) (live fake-upstream run).

## Key Utilities

### `server/utils/openrouter-pool.ts`
Router-local key pool (`OpenRouterPool` + `OpenRouterPoolSupplier`): round-robin, 429 block, 402 disable, TTL recreate.
Deliberate copy of the same half of `packages/tools/src/core/openrouter-pool.ts` — the standalone rule beats
single-sourcing it, so keep both in sync when pool semantics change.

### `server/utils/openrouter-pool-supplier.ts`
Wraps the router-local pool for use inside Nitro context, building clients from the effective router config
(`getRouterConfig().apiKeys`) so CLI flags and `secrets.envFile` reach the pool. Returns the shared pool singleton.

### `server/utils/router-config.ts`
Effective config: explicit `startRouter()` overrides (CLI flags) win, otherwise the environment. Fields: `port`, `host`,
`token`, `mock`, `logDir`, `dailyBudget`, `retentionDays`, `apiKeys`, `upstreams`, `vault`. The environment alone is a
valid configuration — no build-time injected config.

### `server/utils/cost-tracker.ts`
- `logCall(model, usage, cost)` — appends to rolling log files under `<logDir>/<YYYY-MM-DD>/log.jsonl`
  (`logDir` = `$MT_HOME/router`, default `~/.mt/router`; `mt router --log-dir` overrides)
- `getMonthlyCost()` / `getDailyCost()` — aggregate cost summaries
- Rolling logs: 5 MB max, retained N days

### `server/utils/log-rotator.ts`
- `rotateLogs()` — removes old log files beyond retention window

### `server/plugins/mock-mode.ts`
- `isMockMode()` — true when `MT_ROUTER_MOCK=true` (or `mt router --mock`)
- `mockModePlugin` — intercepts OpenRouter calls with deterministic responses

### `server/plugins/log-rotation.ts`
- `logRotationPlugin` — runs `rotateLogs()` on server start

### `server/middleware/rate-limit.ts`
- Daily spend budget on `POST /api/chat/completions`: over budget -> 429 with `retryAfter`
  (`getSecondsUntilMidnight()`), always `X-RateLimit-Remaining` on the response
- No per-IP or per-minute limit yet (see `MT_CLIENT_BUDGET` in the env table)

## `completions.ts` Implementation Notes

- Resolves the target upstream from the model id, forwards the request with a pooled API key
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
| `OPENROUTER_API_KEYS` | — | Comma-separated keys for the default `openrouter` upstream |
| `MT_ROUTER_UPSTREAMS` | — | JSON array of upstream specs `{name,kind,baseUrl,keys?,headers?,models?,defaultModel?}` |
| `MT_ROUTER_OLLAMA_URL` | — | Registers keyless `ollama` upstream (e.g. `http://gpu:11434`) |
| `MT_VAULT` | — | Vault file path override (only that file is read) |
| `MT_ROUTER_HOST` | `localhost` | Bind host; non-loopback requires `MT_ROUTER_TOKEN` |
| `MT_ROUTER_TOKEN` | — | Bearer token required on `/api/*` (except `GET /api/health`); also read by tools provider `router` |
| `MT_ROUTER_VAULT` | `true` | `false` disables vault loading |
| `MT_ROUTER_VAULT_POLL_MS` | `2000` | Min interval between vault mtime checks |
| `MT_CLIENT_BUDGET` | — | Reserved for per-client budgets (`X-MT-Client`); **not implemented yet** |
| `MT_ROUTER_MOCK` | `false` | Enable mock mode (same as `mt router --mock`) |
| `PORT` / `MT_ROUTER_PORT` | `7777` | Router listen port |
| `MT_DAILY_BUDGET` | `5` | Daily spend budget (USD) enforced by the rate-limit middleware |
| `MT_RETENTION_DAYS` | `30` | Log file retention |

## Tests

```
packages/router/tests/
├── upstream-registry.test.ts # resolve() + handler routing vs fake upstream
├── vault-upstreams.test.ts # vault reader, entry mapping, hot reload, no-leak
├── models.test.ts         # GET /api/models — routable ids, live listing, no keys
├── security.test.ts       # bind guard, token compare, header strip, redaction (live)
├── standalone.test.ts     # startRouter()/close(), routes mounted
├── gateway.arch.test.ts   # Arch: no credential passthrough, no key literals, redaction util
├── layers.arch.test.ts    # Arch: router stays standalone (no @mt/* imports or deps)
├── routes.arch.test.ts    # Arch: all expected routes exist
└── middleware.arch.test.ts # Arch: rate-limit middleware shape
```

`packages/router/tests/vault-secrets.arch.test.ts` guards the repo: no real vault values (private hosts,
live API keys) in committed docs/examples.

## Running

```bash
mt router                              # from @mt/cli (flags: --port, --host, --mock, --log-dir, -d)
pnpm dev --filter=@mt/router     # Dev with hot reload
pnpm build --filter=@mt/router   # Build .output/
node packages/router/.output/server/index.mjs  # Run built output
```

`mt router` takes no `--token` flag: the router token comes from `MT_ROUTER_TOKEN` only. Binding to a
non-loopback host without that token is refused before the socket opens.
