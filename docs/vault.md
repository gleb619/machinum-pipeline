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
`models`, anything else is an error. T115 wires refs into `mt.json` `settings.llm.use`.

## Security

- `.mt/vault*`, `vault.json`, `*.vault.json` are gitignored. Never commit real vaults.
- `saveVault` writes atomically with mode 0600.
- `GlobalContext.vault` is non-enumerable: excluded from `JSON.stringify`, spreads, checkpoints, meta, logs.
- Use `maskVault()` before displaying/logging any entry.

## Router

`@mt/router` reads the same files with its own copy of the reader (`packages/router/server/utils/vault-reader.ts`; the router
is standalone, keep formats in sync). Each entry becomes an upstream named after the entry, routed as `<entry>/<model>`:
`ollama` -> ollama, `openai`/`custom` -> openai-compat (needs `baseUrl`), `openrouter` -> keys join the default `openrouter`
pool (after `OPENROUTER_API_KEYS`). `anthropic` is skipped with a warning, `router` ignored. Env upstreams
(`MT_ROUTER_UPSTREAMS`, `MT_ROUTER_OLLAMA_URL`) win on name conflicts. Edits are picked up without restart (mtime check, at
most every 2s); a broken file keeps the previous entries. Key values are never logged or returned by the router API.
