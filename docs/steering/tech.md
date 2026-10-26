# Tech Stack & Code Style
← [Architecture](../architecture.md)

## Runtime & Toolchain

| Layer | Technology |
|---|---|
| Language | TypeScript 5, strict mode, `noUncheckedIndexedAccess: true` |
| Runtime | Node.js (engine); pipelines loaded via `tsx` / `jiti` — no consumer build step |
| Distribution | `mt` npm package (library + CLI, `packages/mt`) and a single-file Bun binary (`bun build --compile`, Bun >= 1.3) |
| Monorepo | pnpm workspaces + Turborepo |
| Lint / Format | **Biome only** — no ESLint, no Prettier |
| Test runner | **Vitest** — test files co-located in `src/` with `.test.ts` suffix |
| Server framework | router: Nuxt / Nitro; backend: h3 handlers, run via plain h3 + `node:http` (`mt serve`, Bun binary) or Nitro (dev) |
| Frontend | Vue 3 + Tailwind CSS + Vite |
| DB | SQLite (backend only, v1: indicator): `bun:sqlite` in Bun/binary, `better-sqlite3` on Node |

## Biome Config (biome.json)

- 2-space indent
- single quotes
- no semicolons
- trailing commas where valid
- `printWidth: 100`
- `noExplicitAny` = **error**
- `noNonNullAssertion` = **error**

Run `pnpm lint` to check, `pnpm format` to auto-fix.

## TypeScript Rules

- `strict: true`, `noUncheckedIndexedAccess: true` in `tsconfig.base.json`
- Use `interface` for public API shapes; `type` for internal unions
- `import type { … }` for type-only imports
- No `any` — use `unknown` with narrowing
- No `// @ts-ignore` without a documented reason
- `readonly` on interface properties that must not mutate
- Async functions return `Promise<T>` explicitly

## Naming Conventions

| Entity | Convention |
|---|---|
| Files | `kebab-case.ts` |
| Types / Interfaces | `PascalCase` |
| DSL builders | `define*` prefix (`definePipeline`, `defineTool`, `defineSource`, `defineTarget`) |
| Functions | `camelCase` |
| Error types | `PascalCase` + `Error` suffix |
| CLI commands | lowercase verbs (`run`, `resume`, `ls runs`) |
| Commits | Conventional commits: `type(scope): description` |

## Testing

- Test files: `src/**/*.test.ts` (co-located, not in a separate `tests/` folder)
- Use `describe` / `it` blocks — never bare `test`
- Test names describe behaviour in business terms
- Integration tests use temp dirs (`os.tmpdir()`) for isolation
- Architecture tests live in `tests/` inside each package (`.arch.test.ts` suffix)

## Import Layer Rules (enforced)

```
cli/ → core/, waypoint/ (URI registration side effect),
       backend/standalone (lazy, only for `mt serve`)
backend/ → core/       (only)
mcp/ → core/           (only)
frontend/ → backend API (HTTP only, no direct TS imports)
router/ → standalone   (no other packages except shared config types)
extensions → HTTP or MCP (never direct imports)
mt/ → umbrella package (core, tools, waypoint, cli, backend)
```

Enforced by architecture tests: `packages/{cli,backend,mcp}/tests/layers.arch.test.ts`.

## Common Commands

```bash
pnpm install            # Install all deps
pnpm build              # Build all packages (Turborepo)
pnpm lint               # Biome lint check
pnpm format             # Biome auto-fix
pnpm typecheck          # tsc across workspace
pnpm test               # All tests (Vitest)
pnpm test --filter=@mt/core          # Single package
pnpm --filter=@mt/tools exec vitest run src/chapter-validator.ts  # Single file
pnpm dev --filter=@mt/core           # Watch mode
pnpm build:bin          # Single-file binary (incl. `mt serve` + UI) -> packages/mt/dist/bin/mt (needs bun)
pnpm smoke:bin          # Build binary + smoke test: run/imports/serve/SSE/UI (no node_modules, no node on PATH)
bun packages/mt/scripts/build-bin.ts --target bun-linux-arm64   # cross build -> dist/bin/mt-linux-arm64
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEYS` | — | Comma-separated keys; pool rotates round-robin |
| `MT_HOME` | `~/.mt` | Global state directory (router logs, etc.) |
| `MT_ROUTER_URL` | `http://localhost:7777` | OpenRouter proxy URL |
| `MT_ROUTER_HOST` | `localhost` | Router bind host; a non-loopback host requires `MT_ROUTER_TOKEN` ([router.md](router.md)) |
| `MT_ROUTER_TOKEN` | — | Bearer token for the router `/api/*` routes (except `GET /api/health`); also the only credential of the tools provider `router` |
| `MT_ROUTER_VAULT` | `true` | Load router upstreams/keys from the vault file(s); `false` disables ([router.md](router.md)) |
| `MT_CLIENT_BUDGET` | — | Router: daily USD budget per `X-MT-Client` id; unset/0 = off (global `MT_DAILY_BUDGET` still applies) |
| `MT_CLIENT_ID` | — | Tools: sent as `X-MT-Client` on router-provider requests (per-client budget key); not a secret |
| `MT_LLM_PROVIDER` | `router` | `router` \| `openrouter` \| `openai` \| `ollama` \| `anthropic` \| `custom` |
| `MT_LLM_USE` | — | Vault ref `vault://<entry>[/<model>]` \| `@vault/<entry>[/<model>]`; expands to provider/baseUrl/keys/headers/model (same as mt.json `settings.llm.use`, which wins). See [vault.md](../vault.md) |
| `MT_LLM_MODEL` | provider default | Default model id |
| `MT_LLM_BASE_URL` | provider default | API base URL (required for `custom`) |
| `MT_LLM_API_KEY` | — | API key for any provider (wins over provider-specific vars) |
| `MT_OLLAMA_URL` | `http://localhost:11434/v1` (`ollamaTool` preset) | Ollama endpoint (set to your remote GPU server, e.g. `http://<gpu-host>:<port>/v1`); provider `ollama` only, beats the generic `MT_LLM_BASE_URL` |
| `MT_OLLAMA_MODEL` | `gemma4:latest` (`ollamaTool` preset) | Ollama model id; provider `ollama` only, beats the generic `MT_LLM_MODEL` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | Provider keys |
| `MT_LLM_TIMEOUT_MS` | `120000` | Per-call timeout |
| `MT_LLM_TRANSPORT` | `sdk` when the provider SDK is installed, else `fetch` | `sdk` \| `fetch`; router provider always uses `fetch` |
| `MT_LLM_CACHE` | `false` | Cache LLM responses in `.mt/cache` |
| `MT_PROMPT_<NAME>` | built-in | Prompt override, inline text or `@path/to/file.md` (`translate.system` -> `MT_PROMPT_TRANSLATE_SYSTEM`) |
| `MT_CONTEXT_MAX_TOKENS` / `MT_CONTEXT_LIMIT` / `MT_CONTEXT_RESERVE` | — | Context-window budget (input tokens / model window / output reserve) |
| `MT_CONTEXT_STRATEGIES` | `dropOldest,truncateLines` | Comma-separated shrink strategies |
| `MT_CONTEXT_LAST_MESSAGE` | `off` | Oversize final user message: `off` \| `truncate` (head+tail with elision) \| `summarize` (LLM) \| `error` |
| `MT_CONTEXT_AUTO_LIMIT` | `true` | Derive the budget from the known model context window |
| `MT_CONTEXT_LIMITS` | — | JSON map `{"glob-or-prefix": tokens}` extending the built-in model context-limit table |
| `MT_LOG_LEVEL` | `info` | Logging verbosity |
| `MT_DEBUG` | `false` | Verbose checkpoint debug output |
| `MT_VAULT` | — | Path to a single vault file; when set, user/project vaults are ignored ([vault.md](../vault.md)) |
| `MT_VLT` | `true` | Vault `vlt:<name>` secret refs: `false` disables vlt resolution entirely ([vault.md](../vault.md)) |
| `MT_VLT_SKIP_VERIFY` | `false` | `mt vault vlt-install`: skip the release-archive sha256 checksum verification (warned; not recommended) |
| `VLT_CONFIG_PATH` | `~/.vlt.toml` | vlt config file location (vlt itself also reads this) |

LLM precedence tables: [tools.md](tools.md#llm-toolkit). Secrets loaded from `.env` via `mt.json → secrets.envFile`.
