# Vault

Gitignored store for sensitive LLM endpoint data (URLs, API keys, headers). Implemented in
`packages/core/src/vault.ts`; exposed as `GlobalContext.vault`.

## Format

See [vault.example.json](vault.example.json) (fake values). `{ "version": 1, "entries": { "<name>": VaultEntry } }`.
`VaultEntry`: `provider` (`ollama|openrouter|openai|anthropic|custom|router`), optional `baseUrl`,
`apiKey`, `apiKeys[]`, `headers{}`, `models[]`, `defaultModel`, `notes`. Entry names contain no `/`.

## Precedence

1. `MT_VAULT=<path>` set: only that file.
2. Otherwise user `~/.mt/vault.json` (`$MT_HOME/vault.json` when `MT_HOME` set), then project
   `<root>/.mt/vault.json`. Project entries override user entries by name (whole entry, no field merge).

Missing file = empty vault. Malformed JSON / bad entry = error naming file + entry, never the secret.

## Refs

`vault://<entry>[/<model>]` or `@vault/<entry>[/<model>]`. Model may contain `:` and `/`
(`vault://my-openrouter/openai/gpt-4o-mini`). Model defaults to `defaultModel`; if the entry lists
`models`, anything else is an error. See [Using a vault entry](#using-a-vault-entry-llmuse).

## Security

- `.mt/vault*`, `vault.json`, `*.vault.json` are gitignored. Never commit real vaults.
- `saveVault` writes atomically with mode 0600.
- `GlobalContext.vault` is non-enumerable: excluded from `JSON.stringify`, spreads, checkpoints, meta, logs.
- Use `maskVault()` before displaying/logging any entry.

## Router

`@mt/router` reads the same files with its own copy of the reader (`packages/router/server/utils/vault-reader.ts`; the router
is standalone, keep formats in sync). Each entry becomes an upstream named after the entry, routed as `<entry>/<model>`:
`ollama` -> ollama, `openai`/`custom` -> openai-compat (needs `baseUrl`), `openrouter` -> keys join the default `openrouter`
pool (after `OPENROUTER_API_KEYS`). `anthropic` is skipped with a warning, `router` entries are ignored by the router itself (they are client-side refs, below). Env upstreams
(`MT_ROUTER_UPSTREAMS`, `MT_ROUTER_OLLAMA_URL`) win on name conflicts. Edits are picked up without restart (mtime check, at
most every 2s); a broken file keeps the previous entries. Key values are never logged or returned by the router API.

## Using a vault entry (`llm.use`)

```json
{ "settings": { "llm.use": "@vault/local-ollama/llama3" } }
```

`llm.use` (mt.json `settings`), env `MT_LLM_USE`, and a `use` field on the per-call / tool / `meta.llm`
LLM config layer all take a ref. It expands (from `ctx.run.global.vault`; tools never read files)
into one layer: `provider`, `baseUrl`, `apiKey`/`apiKeys`, `headers`, `model` (ref model, else
`defaultModel`). The first ref found wins: call input > tool > `meta.llm` > settings `llm.use` > `MT_LLM_USE`.

Precedence (per field, first defined wins):
`input > tool > meta.llm > settings llm.* > vault expansion > provider env (MT_OLLAMA_*) > preset defaults > MT_LLM_* env > defaults`.
So explicit `llm.model` etc. beat the vault; the vault beats env/preset defaults (preset default models and
endpoints of `ollamaTool` / `openrouterFree` / `openrouterPool` are defaults, not pins). Presets still pin
the **provider**: a vault entry of another provider (e.g. `openrouter` entry with `ollamaTool`) throws an
error naming the ref. `openrouterPool` skips its sticky model pin when the model comes from a vault ref.

Errors: unknown entry / model (not in `models`) / no vault loaded name the ref and never contain secrets.
`resolved.sources` reports `vault:<entry>`; `meta.llm` still ignores `apiKey(s)`; nothing from the vault
reaches meta, checkpoints or logs.

Sample pickers (`samples/sample2|3/pipelines/llm-picker.ts`) pass `MT_LLM_USE` / `settings.llm.use`
to the chosen tool; without an explicit `MT_LLM_MODEL` / `llm.model` the vault model is used.

## Router entry (client side)

A `router` entry points `llm.use` at the router; no upstream key is needed (the router holds them). `apiKey` is
optional and, if set, is sent as the router token (`MT_ROUTER_TOKEN` equivalent). Models are routable ids; list them
with `listRouterModels()` (`GET /api/models`). All values below are fake.

```json
{ "version": 1, "entries": {
  "rt":   { "provider": "router", "baseUrl": "http://localhost:7777", "defaultModel": "openrouter/free" },
  "rtol": { "provider": "router", "baseUrl": "http://localhost:7777", "defaultModel": "ollama/gemma4:latest",
            "apiKey": "fake-router-token" }
} }
```

`llm.use: "vault://rt"` runs the free OpenRouter model through the router; `vault://rt/ollama/gemma4:latest` picks
a model per ref.
