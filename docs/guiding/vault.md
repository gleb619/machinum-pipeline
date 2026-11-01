# Vault

Gitignored store for sensitive LLM endpoint data (URLs, API keys, headers). Implemented in
`packages/core/src/vault.ts`; exposed as `GlobalContext.vault`.

## Format

See [vault.example.json](../vault.example.json) (fake values). `{ "version": 1, "entries": { "<name>": VaultEntry } }`.
`VaultEntry`: `provider` (`ollama|openrouter|openai|anthropic|custom|router`), optional `baseUrl`,
`apiKey`, `apiKeys[]`, `headers{}`, `models[]`, `defaultModel`, `notes`. Entry names contain no `/`.

**No plaintext keys.** `apiKey` / `apiKeys[]` must be refs (`embed:<name>`, `vlt:<name>`, `keepass:<title>`).
A plaintext value is rejected at load, at `saveVault`/`addEntry` and by the router reader, with an error naming
the entry (never the value).

## CLI (`mt vault`)

`mt vault` lives in `packages/cli/src/commands/vault.ts` and imports `@mt/core` only.

| Command | Effect |
|---|---|
| `mt vault list` | One line per entry: name, provider, base URL, model count |
| `mt vault show <name>` | The entry as JSON — secrets masked |
| `mt vault show <name> --reveal` | The entry as JSON — secrets unmasked |
| `mt vault add <name> [flags]` | Adds an entry to the project vault. A plaintext `--api-key` / `--api-keys` (flag or hidden prompt) is stored in the embedded store as `embed:<name>` (`<name>-1`, `<name>-2`, … for a pool); only the ref is written to the vault file. An existing different embedded secret needs `--force` |
| `mt vault rm <name>` | Removes the entry (project vault first, then the user vault) |
| `mt vault path` | The resolved vault paths and whether they exist |
| `mt vault init` | Creates an empty `{ "version": 1, "entries": {} }` vault file |
| `mt vault vlt-install` | Downloads the vlt binary into `~/.mt/bin` (prints path + version) |
| `mt vault vlt-status` | vlt binary location, version and session state (no secrets printed) |
| `mt vault keepass-init` | Creates an empty KeePass database (mode 0600) at `--path`/`MT_KEEPASS_PATH` |
| `mt vault keepass-add <title>` | Adds or updates a KeePass entry (`--secret`, `--username`, `--group`) |
| `mt vault keepass-list` | Entry titles, group paths and UUIDs — never passwords |
| `mt vault keepass-status` | Database path, existence, credential config and unlock state |
| `mt vault embed-init` / `embed-add <name>` / `embed-list` / `embed-status` | Embedded store management; master key resolution and the default-password fallback: see below |
| `mt vault master-key generate [--user] [--path <file>] [--force] [--rekey]` | Creates a random 256-bit master key file (mode 0600, atomic): project `.mt/master.key`, or `~/.mt/master.key` with `--user`. Never overwrites an existing file without `--force`; refuses when a store exists unless `--rekey` (re-wraps the store under the new key, rolled back on failure) or `--force` (store becomes unreadable). Never prints the key |
| `mt vault master-key status` / `show-path` | Active source (`env` / `env-file` / `project` / `user` / `default`), path, file mode; both candidate locations. Never prints the key |
| `mt vault embed-init` | Creates an empty embedded encrypted store (mode 0600) at `--path`/`MT_EMBED_PATH` |
| `mt vault embed-add <name>` | Adds or updates an embedded-store secret (`--secret`, `--username`, `--notes`, `--force`) |
| `mt vault embed-list` | Entry names and usernames — never secrets |
| `mt vault embed-status` | Store path, existence, credential config, unlock state, encryption key count and active `kid` |
| `mt vault embed-rekey` | Changes the **master password** (default -> custom, or custom -> custom). Current password: `MT_EMBED_PASSWORD(_FILE)` or the built-in default. New password: `--new-password-file <file>`, `MT_EMBED_NEW_PASSWORD` / `MT_EMBED_NEW_PASSWORD_FILE`, or a hidden TTY prompt with confirmation - never a CLI value. Wrong current password changes nothing; new == current is refused |
| `mt vault embed-rotate <name>` | Replaces the **value** of an existing secret and re-seals it under the active encryption key; the `embed:<name>` ref stays valid. Value: `--value-file <file>`, stdin or hidden prompt - never a CLI value. Missing name: error pointing at `mt vault add`/`embed-add`. Stamps `rotatedAt` |
| `mt vault embed-keyring generate [--kid <kid>] [--note <t>] [--no-activate]` | Generates a random 256-bit **encryption key** and makes it active (unless `--no-activate`) |
| `mt vault embed-keyring add --kid <kid> [--enc-key-file <file>]` | Adds a supplied encryption key (file, stdin or hidden prompt). Accepted: 64 hex chars, base64 of exactly 32 bytes, or a passphrase of at least 12 chars stretched with scrypt (salt `mt-embed-v2-supplied-key:<kid>`); anything shorter is rejected |
| `mt vault embed-keyring list` | `kid`, status (`active`/`retired`), created, note, secret count - never key material |
| `mt vault embed-keyring use <kid>` / `retire <kid>` | `use`: active key for NEW secrets (previous active becomes retired). `retire`: still decrypts, never used for new secrets; the active key cannot be retired |
| `mt vault embed-keyring rm <kid> [--force]` | Removes a key; refused while any secret still uses it unless `--force` (those secrets then become undecryptable); the active key is never removed |
| `mt vault embed-keyring rotate [--kid <kid>] [--reencrypt]` | Generates and activates a new key; `--reencrypt` re-seals every secret under it, otherwise old secrets stay readable under their old `kid` |
| `mt vault embed-add <name> --kid <kid>` | Stores the secret under a chosen encryption key (default: the active one) |

`add` flags: `--provider` (`ollama|openrouter|openai|anthropic|custom|router`), `--base-url`,
`--api-key`, `--api-keys k1,k2`, `--models a,b`, `--default-model`, `--notes`. Missing flags are
prompted for on a TTY (the API key prompt hides the keystrokes); without a TTY the flag is required.
`--force` overwrites an existing entry, `--user` targets `~/.mt/vault.json` instead of
`<project>/.mt/vault.json`. Entry names may not contain `/`.

KeePass flags: `--path <file>` (database), `--key-file <file>`, `--secret <value>` (entry password,
never logged), `--username <name>`, `--group <path>`. The master password is read from
`MT_KEEPASS_PASSWORD` / `MT_KEEPASS_PASSWORD_FILE`; `keepass-init` / `keepass-add` / `keepass-list`
prompt for it with hidden input when a TTY is attached and no credential is configured.

Embedded-store flags: `--path <file>` (store), `--secret <value>` (never logged), `--username <name>`,
`--notes <text>`, `--force` (overwrite an existing entry). The master password is read from
`MT_EMBED_PASSWORD` / `MT_EMBED_PASSWORD_FILE`; `embed-init` / `embed-add` / `embed-list` prompt for
it with hidden input when a TTY is attached and no credential is configured.

Secrets are masked in every output (`sk-…1234`) unless `--reveal` is given. Vault-entry writes go
through `saveVault`: atomic (temp-then-rename), file mode 0600. KeePass and embedded stores use their
own atomic 0600 writers.

`mt vault init` and `mt init` both keep `.gitignore` covered — `.mt/`, `vault.json`, `*.vault.json`,
`.mt/vault*`, `*.kdbx` and `*.embed.json` are appended only when missing, so running either twice
changes nothing.

## Precedence

1. `MT_VAULT=<path>` set: only that file.
2. Otherwise user `~/.mt/vault.json` (`$MT_HOME/vault.json` when `MT_HOME` set), then project
   `<root>/.mt/vault.json`. Project entries override user entries by name (whole entry, no field merge).

Missing file = empty vault. Malformed JSON / bad entry = error naming file + entry, never the secret.

## Refs

`vault://<entry>[/<model>]` or `@vault/<entry>[/<model>]`. Model may contain `:` and `/`
(`vault://my-openrouter/openai/gpt-4o-mini`). Model defaults to `defaultModel`; if the entry lists
`models`, anything else is an error. See [Using a vault entry](#using-a-vault-entry-llmuse).

## Secret backends

`apiKey` / `apiKeys[]` values must be secret references (plaintext is rejected). Resolution happens
**in memory only** — the vault file keeps the original refs and `saveVault` never persists resolved
values. The embedded store is the default backend; `mt init` generates its master key (see
[Master key](installation.md#master-key-every-new-installation)).

| Ref | Backend | Config |
|---|---|---|
| `vlt:<name>` | [vlt](https://github.com/ladzaretti/vlt-cli) CLI | `MT_VLT`, vlt's own session (`vlt login`) |
| `keepass:<title\|uuid>` | KeePass `.kdbx` (kdbxweb + WASM Argon2) | `MT_KEEPASS_PATH`, `MT_KEEPASS_PASSWORD`, `MT_KEEPASS_KEY_FILE` |
| `embed:<name>` | Embedded encrypted store (scrypt + AES-256-GCM, pure `node:crypto`) | `MT_EMBED_PATH`, `MT_EMBED_PASSWORD` |

### vlt

`"apiKey": "vlt:openrouter_main"` resolves at load time via `vlt show openrouter_main --stdout`.

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

### KeePass

`packages/core/src/keepass.ts` reads `.kdbx` files directly (no external binary, no native
addon): `kdbxweb` parses the database, `hash-wasm` supplies Argon2 (WASM embedded as base64, so
the standalone `mt` binary stays self-contained). `keepass://<title>` is accepted as an alias of
`keepass:<title>`.

- **Lookup**: exact UUID, then `Group/Sub/Title` path, then title (case-insensitive fallback).
  Duplicate titles resolve to the first match; use the UUID or a group path to disambiguate.
  `mt vault keepass-list` prints paths and UUIDs.
- **Config**: `MT_KEEPASS_PATH` (default `$MT_HOME|~/.mt/secrets.kdbx`), `MT_KEEPASS_PASSWORD`
  or `MT_KEEPASS_PASSWORD_FILE` (one trailing newline stripped), optional
  `MT_KEEPASS_KEY_FILE`. A key file alone is enough. Missing credentials are a clear error;
  the core resolver never prompts (pipelines may run without a TTY). The CLI commands prompt
  with hidden input when a TTY is attached.
- **Caching**: an opened database is memoized per process by path + mtime + size + credential
  fingerprint; edits to the file reload it. Decrypted entries never leave the resolver.
- **Provisioning**:
  ```bash
  export MT_KEEPASS_PASSWORD='…'          # CI only; interactive commands prompt
  mt vault keepass-init                    # empty db, mode 0600
  mt vault keepass-add OpenRouter-Key --secret "$OPENROUTER_KEY" --group LLM/API
  mt vault add or --provider openrouter --api-key keepass:OpenRouter-Key
  ```
  KeePassXC can edit the same file; AES-KDF (KDBX 3.1) and Argon2 (KDBX 4) databases are supported.
- **Opt-out**: `MT_KEEPASS=false` disables resolution entirely (refs pass through as-is).
- **Errors are sanitized**: a wrong password, missing file or missing entry names the path/entry
  and never includes the master password or a secret value.
- **Router**: `packages/router/server/utils/keepass.ts` is a standalone duplicate. Loading is
  async (WebCrypto), so a changed vault with `keepass:` refs triggers a background refresh and
  keeps serving the previous result until it completes; `startRouter()` awaits the first load.
  Database mtime is part of the hot-reload signature.

### Embedded store (embed)

`packages/core/src/embed.ts` reads a small JSON file encrypted with AES-256-GCM — no dependency,
no native addon, no external binary; `node:crypto` only. `embed://<name>` is accepted as an alias of
`embed:<name>`.

- **Terminology**: *master password* unlocks the store; *encryption key* (`kid`) is the 256-bit cipher
  key that seals secrets; *secret* is the stored value (API key, token).
- **Format v2 (keyring, envelope encryption)**: the file holds
  `{ version: 2, kdf: "scrypt", n, r, p, salt, iv, tag, ciphertext, secrets }`. `ciphertext` is the
  keyring - `{ "keys": { "<kid>": { "key": <base64 32 bytes>, "createdAt", "status": "active"|"retired",
  "note"? } } }` - sealed under `scryptSync(masterPassword, salt, 32, { N: 16384, r: 8, p: 1,
  maxmem: 64MiB })` with AES-256-GCM, a random 12-byte IV and AAD `mt-embed-v2-keyring`.
  `secrets` maps `<name>` to `{ kid, iv, tag, ciphertext, createdAt, rotatedAt? }`; each secret's
  ciphertext is `{ secret, username?, url?, notes? }` sealed with the encryption key `kid`, its own
  random IV and AAD `mt-embed-v2-secret:<kid>:<name>` (so entries cannot be swapped between names
  or keys). Entry names, `kid`s and timestamps are plaintext; values, usernames, URLs, notes and key
  material are not. KDF parameters are validated against the fixed values before deriving a key.
  Writes are atomic (temp-then-rename), mode 0600, fresh keyring salt/IV per write. Exactly one key
  is `active`; a new store gets a generated key `k1`. v1 stores are not supported (re-create).
- **Threat model**: the keyring limits the blast radius of a single leaked encryption key and lets you
  rotate or retire keys (`embed-keyring rotate --reencrypt`). It does NOT protect a store opened with
  the public built-in default password: anyone with the file can unlock the keyring. Set a private
  master password (`embed-rekey`) first. `embed-rekey` re-wraps the keyring under the new password; if
  the file was ever exposed under the default password, also run
  `embed-keyring rotate --reencrypt` and remove the old key to replace the key material itself.
- **Config**: `MT_EMBED_PATH` (default `$MT_HOME|~/.mt/secrets.embed.json`, outside any repo and
  covered by the `*.embed.json` ignore pattern), `MT_EMBED_PASSWORD` or `MT_EMBED_PASSWORD_FILE`
  (one trailing newline stripped). An explicitly empty password is an error. The core resolver
  never prompts.
- **Master key resolution order** (first hit wins): `MT_EMBED_PASSWORD` > `MT_EMBED_PASSWORD_FILE` >
  project `<root>/.mt/master.key` > user `$MT_HOME|~/.mt/master.key` > built-in default (warns).
  `<root>` is `MT_PROJECT_ROOT`, else the project passed to `loadVault`, else the cwd. A key file
  holds one line (random 256-bit, base64url or hex) used as the master password string; a file
  readable by group/others only produces a warning. `mt init` generates the project key;
  `mt vault master-key generate [--user] [--rekey]` does it for existing installs. The router
  (`packages/router/server/utils/embed.ts`) uses the same order.
- **Built-in default password (fallback only)**: when no env password and no master key file is
  found, the public `DEFAULT_EMBED_PASSWORD` is used so an unconfigured, pre-existing setup keeps
  working. That password is public: the store is only **obfuscated, not protected**. The first use
  per process emits `console.warn` suggesting `mt vault master-key generate --rekey`. New
  installations should not rely on it: `mt init` creates a private master key. A store sealed under
  the default cannot be opened once another source takes over - run
  `mt vault master-key generate --rekey` (or `mt vault embed-rekey`) first.
- **Provisioning**:
  ```bash
  export MT_KEEPASS_PASSWORD='…'          # CI only; interactive commands prompt
  mt vault keepass-init                    # empty db, mode 0600
  mt vault keepass-add OpenRouter-Key --secret "$OPENROUTER_KEY" --group LLM/API
  mt vault add or --provider openrouter --api-key keepass:OpenRouter-Key
  ```
  KeePassXC can edit the same file; AES-KDF (KDBX 3.1) and Argon2 (KDBX 4) databases are supported.
- **Opt-out**: `MT_KEEPASS=false` disables resolution entirely (refs pass through as-is).
- **Errors are sanitized**: a wrong password, missing file or missing entry names the path/entry
  and never includes the master password or a secret value.
- **Router**: `packages/router/server/utils/keepass.ts` is a standalone duplicate. Loading is
  async (WebCrypto), so a changed vault with `keepass:` refs triggers a background refresh and
  keeps serving the previous result until it completes; `startRouter()` awaits the first load.
  Database mtime is part of the hot-reload signature.

### Embedded store (embed)

`packages/core/src/embed.ts` reads a small JSON file encrypted with AES-256-GCM — no dependency,
no native addon, no external binary; `node:crypto` only. `embed://<name>` is accepted as an alias of
`embed:<name>`.

- **Terminology**: *master password* unlocks the store; *encryption key* (`kid`) is the 256-bit cipher
  key that seals secrets; *secret* is the stored value (API key, token).
- **Format v2 (keyring, envelope encryption)**: the file holds
  `{ version: 2, kdf: "scrypt", n, r, p, salt, iv, tag, ciphertext, secrets }`. `ciphertext` is the
  keyring - `{ "keys": { "<kid>": { "key": <base64 32 bytes>, "createdAt", "status": "active"|"retired",
  "note"? } } }` - sealed under `scryptSync(masterPassword, salt, 32, { N: 16384, r: 8, p: 1,
  maxmem: 64MiB })` with AES-256-GCM, a random 12-byte IV and AAD `mt-embed-v2-keyring`.
  `secrets` maps `<name>` to `{ kid, iv, tag, ciphertext, createdAt, rotatedAt? }`; each secret's
  ciphertext is `{ secret, username?, url?, notes? }` sealed with the encryption key `kid`, its own
  random IV and AAD `mt-embed-v2-secret:<kid>:<name>` (so entries cannot be swapped between names
  or keys). Entry names, `kid`s and timestamps are plaintext; values, usernames, URLs, notes and key
  material are not. KDF parameters are validated against the fixed values before deriving a key.
  Writes are atomic (temp-then-rename), mode 0600, fresh keyring salt/IV per write. Exactly one key
  is `active`; a new store gets a generated key `k1`. v1 stores are not supported (re-create).
- **Threat model**: the keyring limits the blast radius of a single leaked encryption key and lets you
  rotate or retire keys (`embed-keyring rotate --reencrypt`). It does NOT protect a store opened with
  the public built-in default password: anyone with the file can unlock the keyring. Set a private
  master password (`embed-rekey`) first. `embed-rekey` re-wraps the keyring under the new password; if
  the file was ever exposed under the default password, also run
  `embed-keyring rotate --reencrypt` and remove the old key to replace the key material itself.
- **Config**: `MT_EMBED_PATH` (default `$MT_HOME|~/.mt/secrets.embed.json`, outside any repo and
  covered by the `*.embed.json` ignore pattern), `MT_EMBED_PASSWORD` or `MT_EMBED_PASSWORD_FILE`
  (one trailing newline stripped). An explicitly empty password is an error. The core resolver
  never prompts.
- **Default password (zero-config)**: with neither variable set, the built-in
  `DEFAULT_EMBED_PASSWORD` is used, so `embed:` works out of the box and the store file is created
  on first `embed-add` / `mt vault add --api-key`. That password is public: the store is only
  **obfuscated, not protected**. The first use per process emits `console.warn`
  ("mt: embedded secret store uses the built-in default password: secrets are only obfuscated, not
  protected. Set MT_EMBED_NEW_PASSWORD … and run `mt vault embed-rekey` …"). A store made with the default
  cannot be opened once `MT_EMBED_PASSWORD` is set - run `mt vault embed-rekey` first (current
  password = the default, new password via `--new-password-file`), then export the new one.
- **Provisioning**:
  ```bash
  mt vault add or --provider openrouter --api-key "$OPENROUTER_KEY"   # -> embed:or in the vault
  # or explicitly:
  export MT_EMBED_PASSWORD='…'               # protects the store; set before the first add
  mt vault embed-add OpenRouter-Key --secret "$OPENROUTER_KEY"
  mt vault add or --provider openrouter --api-key embed:OpenRouter-Key
  ```
- **Caching**: the decrypted store is memoized per process by path + mtime + size + a SHA-256
  fingerprint of the password; concurrent loads share one promise and failed loads are not cached.
  The cache is cleared after writes.
- **Opt-out**: `MT_EMBED=false` disables resolution entirely (refs pass through as-is).
- **Errors are sanitized**: a wrong password, tampered ciphertext or malformed JSON produces one
  error naming the path only — never the master password or a secret value.
- **Router**: `packages/router/server/utils/embed.ts` is a standalone **sync** duplicate
  (readFileSync/statSync/scryptSync), so `embed:` refs resolve directly in the sync hot-reload
  reader — no background refresh needed. Store mtime is part of the hot-reload signature.

## Security

- Plaintext keys never reach disk in the vault file; resolved values are never written back to the vault,
  checkpoints, meta or logs.
- `.mt/vault*`, `vault.json`, `*.vault.json`, `*.kdbx` and `*.embed.json` are gitignored. Never
  commit real vaults, databases or encrypted stores.
- `saveVault` writes atomically with mode 0600.
- `GlobalContext.vault` is non-enumerable: excluded from `JSON.stringify`, spreads, checkpoints, meta, logs.
- Use `maskVault()` before displaying/logging any entry.

### Caveats — what the embedded store does and does not protect

- **Default password is public.** Without `MT_EMBED_PASSWORD(_FILE)` or a `master.key` file the store
  is sealed with a built-in password that ships in the source. That is obfuscation, not protection:
  anyone who gets the store file can open it. `mt init` avoids this by generating a private master
  key; for older installs run `mt vault master-key generate --rekey` *before* adding production keys.
- **Master key file = the store's lock.** Back up `.mt/master.key` (or `~/.mt/master.key`): losing it
  makes the embedded secrets unrecoverable. It is gitignored (`.mt/master.key`, `*.key`); never commit
  it, and keep it 0600. A project key shadows a user-level store opened without it.
- **Re-key is not re-encrypt.** `embed-rekey` only re-wraps the keyring under the new master password;
  the encryption keys stay the same. If a store was ever exposed under the default (or an old) password,
  also run `mt vault embed-keyring rotate --reencrypt` and `embed-keyring rm <old-kid>`, and rotate the
  upstream secrets themselves at the provider — an attacker who copied the old file still holds the old
  keys and the old ciphertexts.
- **Rotation does not revoke.** Rotating an encryption key or a secret value protects future use only.
  Copies of an older store file stay readable with their old password; secrets exposed that way must be
  revoked at the issuer.
- **Metadata is plaintext.** Secret names, `kid`s and timestamps in the store file are not encrypted.
- **Memory and process scope.** Resolved secrets live in process memory for the run (`GlobalContext.vault`);
  anyone who can read the process or its environment (`MT_EMBED_PASSWORD`, `/proc`) can read them. Prefer
  `MT_EMBED_PASSWORD_FILE` with 0600 over an inline env var.
- **No plaintext fallback, no migration.** Plaintext `apiKey`/`apiKeys[]` are rejected at load and write;
  put keys in a backend with `mt vault add --api-key` or the `embed-*` / `keepass-*` / `vlt` commands.
- **Backends differ.** `vlt:` and `keepass:` delegate protection to those tools; their strength is theirs,
  not this store's.

## Router

`@mt/router` reads the same files with its own copy of the reader (`packages/router/server/utils/vault-reader.ts`; the router
is standalone, keep formats in sync). Each entry becomes an upstream named after the entry, routed as `<entry>/<model>`:
`ollama` -> ollama, `openai`/`custom` -> openai-compat (needs `baseUrl`), `openrouter` -> keys join the default `openrouter`
pool (after `OPENROUTER_API_KEYS`). `anthropic` is skipped with a warning, `router` entries are ignored by the router itself (they are client-side refs, below). Env upstreams
(`MT_ROUTER_UPSTREAMS`, `MT_ROUTER_OLLAMA_URL`) win on name conflicts. Edits are picked up without restart (mtime check, at
most every 2s); a broken file keeps the previous entries. `embed:` refs resolve synchronously in the
same poll; `keepass:` refs refresh in the background. Key values are never logged or returned by the
router API.
Router side in detail: [steering/router.md](../steering/router.md) (upstreams, routing prefixes, hot reload, keyless
security model); end-to-end flows: [uc.md](uc.md) (UC063–UC067).

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

Sample pickers (`packages/tools/src/core/llm-picker.ts`, used by sample3 and sample4) pass `MT_LLM_USE` / `settings.llm.use`
to the chosen tool; without an explicit `MT_LLM_MODEL` / `llm.model` the vault model is used.

## Router entry (client side)

A `router` entry points `llm.use` at the router; no upstream key is needed (the router holds them). `apiKey` is
optional and, if set (as a ref, e.g. `embed:router-token`), is sent as the router token (`MT_ROUTER_TOKEN` equivalent). Models are routable ids; list them
with `listRouterModels()` (`GET /api/models`). All values below are fake.

```json
{ "version": 1, "entries": {
  "rt":   { "provider": "router", "baseUrl": "http://localhost:7777", "defaultModel": "openrouter/free" },
  "rtol": { "provider": "router", "baseUrl": "http://localhost:7777", "defaultModel": "ollama/gemma4:latest",
            "apiKey": "embed:router-token" }
} }
```

`llm.use: "vault://rt"` runs the free OpenRouter model through the router; `vault://rt/ollama/gemma4:latest` picks
a model per ref.
