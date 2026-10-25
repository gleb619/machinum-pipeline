# Vault

Gitignored store for sensitive LLM endpoint data (URLs, API keys, headers). Implemented in
`packages/core/src/vault.ts`; exposed as `GlobalContext.vault`.

## Format

See [vault.example.json](vault.example.json) (fake values). `{ "version": 1, "entries": { "<name>": VaultEntry } }`.
`VaultEntry`: `provider` (`ollama|openrouter|openai|anthropic|custom|router`), optional `baseUrl`,
`apiKey`, `apiKeys[]`, `headers{}`, `models[]`, `defaultModel`, `notes`. Entry names contain no `/`.

## CLI (`mt vault`)

`mt vault` lives in `packages/cli/src/commands/vault.ts` and imports `@mt/core` only.

| Command | Effect |
|---|---|
| `mt vault list` | One line per entry: name, provider, base URL, model count |
| `mt vault show <name>` | The entry as JSON — secrets masked |
| `mt vault show <name> --reveal` | The entry as JSON — secrets unmasked |
| `mt vault add <name> [flags]` | Adds an entry to the project vault (see below) |
| `mt vault rm <name>` | Removes the entry (project vault first, then the user vault) |
| `mt vault path` | The resolved vault paths and whether they exist |
| `mt vault init` | Creates an empty `{ "version": 1, "entries": {} }` vault file |
| `mt vault vlt-install` | Downloads the vlt binary into `~/.mt/bin` (prints path + version) |
| `mt vault vlt-status` | vlt binary location, version and session state (no secrets printed) |

`add` flags: `--provider` (`ollama|openrouter|openai|anthropic|custom|router`), `--base-url`,
`--api-key`, `--api-keys k1,k2`, `--models a,b`, `--default-model`, `--notes`. Missing flags are
prompted for on a TTY (the API key prompt hides the keystrokes); without a TTY the flag is required.
`--force` overwrites an existing entry, `--user` targets `~/.mt/vault.json` instead of
`<project>/.mt/vault.json`. Entry names may not contain `/`.

Secrets are masked in every output (`sk-…1234`) unless `--reveal` is given. Writes go through
`saveVault`: atomic (temp-then-rename), file mode 0600.

`mt vault init` and `mt init` both keep `.gitignore` covered — `.mt/`, `vault.json`, `*.vault.json`
and `.mt/vault*` are appended only when missing, so running either twice changes nothing.

## Precedence

1. `MT_VAULT=<path>` set: only that file.
2. Otherwise user `~/.mt/vault.json` (`$MT_HOME/vault.json` when `MT_HOME` set), then project
   `<root>/.mt/vault.json`. Project entries override user entries by name (whole entry, no field merge).

Missing file = empty vault. Malformed JSON / bad entry = error naming file + entry, never the secret.

## Refs

`vault://<entry>[/<model>]` or `@vault/<entry>[/<model>]`. Model may contain `:` and `/`
(`vault://my-openrouter/openai/gpt-4o-mini`). Model defaults to `defaultModel`; if the entry lists
`models`, anything else is an error. See [Using a vault entry](#using-a-vault-entry-llmuse).

## vlt backend

`apiKey` / `apiKeys[]` values may be vlt secret references instead of plaintext:
`"apiKey": "vlt:openrouter_main"` resolves at load time via
[vlt](https://github.com/ladzaretti/vlt-cli) (`vlt show openrouter_main --stdout`).
Resolution is **in memory only** — the vault file keeps the original refs and
`saveVault` never persists resolved values.

- **Binary acquisition** (first match wins): `vlt` on PATH → mt-managed
  `$MT_HOME|~/.mt/bin/vlt` → on-demand auto-install into `~/.mt/bin` (Linux only;
  x64/arm64/386). Install or check with `mt vault vlt-install` / `mt vault vlt-status`.
  The install verifies the binary actually runs; on older glibc (e.g. Ubuntu 20.04,
  glibc 2.31) the prebuilt download fails with a static-build hint — build with
  `CGO_ENABLED=0` in a `golang:1.24` container and copy `bin/vlt`/`bin/vltd` to `~/.mt/bin`.
- **Session model**: vlt is served by the `vltd` daemon; after `vlt login` a session
  stays unlocked for `session_duration` (default 1min, extendable in `~/.vlt.toml`
  `[vault] session_duration`). An expired session fails resolution with a
  "run `vlt login`" hint. `VLT_CONFIG_PATH` overrides the config file location.
- **Opt-out**: `MT_VLT=false` disables resolution entirely (refs pass through as-is).
- **Errors are sanitized**: vlt stdout/stderr may contain secret material and never
  reaches error messages or logs; failures name only the entry and secret.
- The router resolves the same refs with its own sync copy
  (`packages/router/server/utils/vlt.ts`), memoized per secret name so the hot-reload
  poll never forks `vlt` repeatedly; a failed `vlt show` clears the memo entry so the
  next reload re-resolves.

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
Router side in detail: [steering/router.md](steering/router.md) (upstreams, routing prefixes, hot reload, keyless
security model); end-to-end flows: [uc.md](uc.md) (UC063–UC065).

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
error naming the ref. `openrouterPool` skips its sticky model pin whenever a layer above the preset
defaults picked the model (vault ref, mt.json `llm.model`, `meta.llm`, per-call input), so no pin is created.

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
