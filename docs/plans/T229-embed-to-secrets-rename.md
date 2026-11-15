# T229 — Rename the embed secret backend to secrets (zero 'embed' in repo)

## Keywords

Keywords: secrets, vault, packages/core/src/secrets.ts, packages/core/src/vault.ts, packages/cli/src/commands/vault.ts, packages/router/server/utils, embed ref prefix, MT_EMBED_PATH, vault.embed.json, mt vault embed-list

## Goal

The vault's default secret backend is called "embed" everywhere: the `embed:` ref prefix,
the `MT_EMBED_*` env vars, the `vault.embed.json` / `secrets.embed.json` file names, the
`mt vault embed-*` subcommands, and ~40 `Embed*` symbols in `@mt/core`. Rename that backend
to **secrets** so the repo carries no `embed` vocabulary at all — `git grep -i embed` returns
zero hits outside third-party lockfiles and fixture data.

Core is already half-way there: `packages/core/src/embed.ts` → `packages/core/src/secrets.ts`
landed in dd810eb (T221). What remains is the vocabulary and the public surface (ref prefix,
env vars, CLI, file names) plus the on-disk store format.

**Breaking on purpose.** The ref prefix, env vars, CLI subcommands, file names and the store
format all change. Existing vault files and stores are local + gitignored and must be updated
by hand (re-add the secrets). Document the break in `docs/guiding/vault.md` and `docs/SKILL.md`.

## Scope

### 1. Public vocabulary (breaking)

| Current | New |
| --- | --- |
| `embed:<name>` ref prefix | `secrets:<name>` |
| `MT_EMBED_PATH` | `MT_SECRETS_PATH` |
| `MT_EMBED_PASSWORD` / `MT_EMBED_PASSWORD_FILE` | `MT_SECRETS_PASSWORD` / `MT_SECRETS_PASSWORD_FILE` |
| `MT_EMBED=false` (disable resolution) | `MT_SECRETS=false` |
| `mt vault embed-init\|add\|list\|status\|rekey\|rotate\|keyring` | `mt vault secrets-init\|add\|list\|status\|rekey\|rotate\|keyring` |
| `vault.embed.json` (vault file) | `vault.secrets.json` |
| `~/.mt/secrets.embed.json` (default store) | `~/.mt/secrets.json` |
| ignore patterns `*.embed.json` | `*.secrets.json` (`packages/cli/src/utils/gitignore.ts`, `packages/core/src/sync/scope.ts`) |

Core API — `packages/core/src/secrets.ts`, `packages/core/src/types/secrets.ts`,
`packages/core/src/index.ts` exports:

- types: `EmbedSecret`→`SecretEntry`, `EmbedEntryInfo`→`SecretEntryInfo`,
  `EmbedKeyInfo`→`SecretKeyInfo`, `EmbedKeyringOptions`→`SecretKeyringOptions`,
  `AddEmbedKeyOptions`→`AddSecretKeyOptions`, `GenerateEmbedKeyOptions`→`GenerateSecretKeyOptions`,
  `CreateEmbedOptions`→`CreateSecretStoreOptions`, `RekeyEmbedOptions`→`RekeySecretStoreOptions`,
  `RotateEmbedKeysOptions`→`RotateSecretKeysOptions`, `RotateEmbedSecretOptions`→`RotateSecretOptions`,
  `SetEmbedSecretOptions`→`SetSecretOptions`, `SetEmbedSecretInput`→`SetSecretInput`
- functions: `createEmbedStore`→`createSecretStore`, `defaultEmbedPath`→`defaultSecretStorePath`,
  `embedDisabled`→`secretsDisabled`, `embedCredentialsConfigured`→`secretsCredentialsConfigured`,
  `isEmbedRef`→`isStoreRef`, `listEmbedEntries`→`listSecretEntries`, `listEmbedKeys`→`listSecretKeys`,
  `getEmbedSecret`→`getSecret`, `setEmbedSecret`→`setSecret`, `rotateEmbedSecret`→`rotateSecret`,
  `rekeyEmbedStore`→`rekeySecretStore`, `generateEmbedKey`→`generateSecretKey`,
  `addEmbedKey`→`addSecretKey`, `useEmbedKey`→`useSecretKey`, `retireEmbedKey`→`retireSecretKey`,
  `removeEmbedKey`→`removeSecretKey`, `rotateEmbedKeys`→`rotateSecretKeys`,
  `parseSuppliedEmbedKey`→`parseSuppliedSecretKey`, `resolveEmbedValue`→`resolveSecretValue`,
  `resetEmbedCache`→`resetSecretStoreCache`, `resetEmbedDefaultWarning`→`resetSecretDefaultWarning`,
  `EMBED_REF_PREFIX`→`SECRET_REF_PREFIX`, `DEFAULT_EMBED_PASSWORD`→`DEFAULT_SECRET_PASSWORD`,
  `DEFAULT_EMBED_WARNING`→`DEFAULT_SECRET_WARNING`, internal `EmbedEnvelope`→`SecretEnvelope`

Name clashes to resolve deliberately:

- `isSecretRef` (`packages/core/src/vault.ts`) already means "any of `vlt:` / `keepass:` /
  `secrets:`" — keep it as-is; the backend-specific predicate becomes `isStoreRef`.
- `SecretPayload` / `StoredSecret` already exist inside `secrets.ts` as store-internal types —
  keep them, do not fold into `SecretEntry`.

### 2. Router duplicate

`packages/router/server/utils/embed.ts` → `server/utils/secrets.ts`. It stays a deliberate
sync duplicate of core's store code (the router must not import `@mt/*`); keep the duplication
and its arch-test assertion in sync. Also: `vault-reader.ts`, `redact.ts` (`EMBED_REF` regex →
`SECRET_REF`), `standalone.ts`, `tests/helpers/embed-fixture.ts`, `tests/embed.test.ts`.

### 3. On-disk store format (decision)

Store format v2 → v3: AAD strings `mt-embed-v2-keyring` / `mt-embed-v2-secret` /
`mt-embed-v2-supplied-key:` → `mt-secrets-v3-*`, default-password literal
`mt-embed-default-password-NOT-SECRET` → `mt-secrets-default-password-NOT-SECRET`, and the
`version` field 2 → 3.

Consequence: an existing store cannot be opened. Chosen: **clean break** — no v2 read path,
because a legacy-compat module would keep the word "embed" in the repo. Document that users
must re-add their secrets. The alternative (keep legacy AAD constants) is rejected.

### 4. Unrelated "embed" prose (same goal: zero occurrences)

- `packages/mt/src/embed.ts` → `packages/mt/src/bundle.ts`; `registerEmbeddedModules` →
  `registerBundledModules`; Bun plugin name `mt-embedded` → `mt-bundled`; update
  `packages/mt/src/bin.ts`, `packages/mt/tests/exports.test.ts`, `packages/mt/scripts/build-bin.ts`,
  `packages/mt/scripts/smoke-bin.sh`, `packages/mt/scripts/assemble.mjs` comment.
- "embedded router" (cli `serve`, webui/router `standalone.ts`) → "built-in router".
- "embedded as base64" (`packages/plugins/src/keepass.ts`) → "inlined as base64".
- "embeds chunks" (`packages/tools/src/modification/browser-translate.test.ts`) → "includes chunks".
- "Tools must not embed the target root" (`packages/core/src/types/run-events.ts`) → "must not include".
- "copy embedded in the binary" (`packages/core/src/module-loader.ts`, `.github/workflows/ci.yml`) →
  "copy bundled in the binary".
- "embedded agent skill" (`packages/cli/src/commands/skill.ts`) → "bundled agent skill".
- ML vocabulary in `docs/steering/tools.md` (planned-tool table, not implemented): `embedForRAG`
  (TL031) → `vectorizeForRAG`, `embedding` → `vector`, `ToolContext.embedder` → `ToolContext.vectorizer`;
  "Embedding in `mt serve`" heading in `docs/steering/router.md` → "Router in `mt serve`";
  "LaBSE embeddings" (bertalign, `docs/guiding/sft-model.md`) → "LaBSE sentence vectors".

### 5. Docs

- `docs/SKILL.md` — CLI commands + env vars changed → bump `skill-version`,
  `pnpm --filter=@mt/cli gen:skill`, verify `mt skill` matches (drift test
  `packages/cli/tests/commands/skill.test.ts`).
- steering: `core.md`, `cli.md`, `tech.md` (env table), `router.md`, `webui.md`, `structure.md`, `tools.md`.
- guiding: `vault.md` (73 hits — biggest doc), `installation.md`, `lifecycle.md`, `architecture.md`,
  `onboarding.md`, `uc.md`, `remote-run.md`, `remote-browser-translate.md`, `sft-model.md`, `samples.md`,
  `memory.md`, `layout.md`, `README.md`.
- `docs/vault.example.json`, `docs/install.sh`, `docs/ideas/hs-target-and-localhost-translate.md`,
  `Dockerfile`, `docker/entrypoint.sh`.
- `packages/vscode/schemas/mt.schema.json` (secret-ref description).

### 6. Samples

- `samples/sample1-tutorial/vault.embed.json` → `vault.secrets.json`; entry `demo-embed` →
  `demo-secrets`; `mt.json` `demo.vaultRef` → `vault://demo-secrets`; `demo/embed.sh` →
  `demo/secrets.sh`; `demo/lib.sh`; `package.json` scripts; `pipelines/pipe10-secrets.ts`
  (doc comment + `DEFAULT_REF`); `tests/pipe10-secrets.test.ts`; `README.md`.

### 7. Known exemptions (documented, still contain the word)

- `pnpm-lock.yaml`, `sandbox/pnpm-lock.yaml` — third-party `sass-embedded`.
- `packages/tools/tests/it/router-vault.it.test.ts` — regex filters upstream Ollama model names
  (`/embed|bge|ocr/i`).
- `samples/depricated/**/jsonl/*.jsonl` — third-party novel text inside the fixtures.
- `docs/kanban.md`, `docs/plans/*` — historical rows/plans; the board is a record, not product vocabulary.
- `packages/router/.output/`, `packages/router/.nitro/` — build artifacts (gitignored).

## Steps

- [ ] 1. Core: rename the backend vocabulary in `packages/core/src/secrets.ts`,
      `packages/core/src/types/secrets.ts`, `packages/core/src/vault.ts` and the `index.ts`
      exports; store format v3 + new AAD; rename the core tests
      (`embed.test.ts`→`secrets.test.ts`, `embed-rotate.test.ts`→`secrets-rotate.test.ts`).
      Check: `pnpm --filter=@mt/core test` green.
- [ ] 2. CLI: `mt vault secrets-*` subcommands + help text, env vars, gitignore pattern,
      `init`/`master-key`/`serve`/`skill` commands; rename `vault-embed.test.ts`→`vault-secrets.test.ts`.
      Check: `pnpm --filter=@mt/cli test` green.
- [ ] 3. Router: `server/utils/embed.ts`→`secrets.ts` (keep the sync duplicate), `vault-reader.ts`,
      `redact.ts`, `standalone.ts`, fixtures + tests. Check: `pnpm --filter=@mt/router test` green.
- [ ] 4. Webui + plugins: `standalone.ts`, `serve-auth.ts`, `sync-root.ts`,
      `packages/plugins/src/{index,keepass}.ts`; webui tests. Check: `pnpm --filter=@mt/webui test` green.
- [ ] 5. `packages/mt`: `src/embed.ts`→`src/bundle.ts`, `bin.ts`, `exports.test.ts`, build scripts;
      `packages/tools` prose in `browser-translate.test.ts`; `packages/vscode/schemas/mt.schema.json`.
      Check: `pnpm --filter=@mt/tools test` and `pnpm --filter=@mt/mt test` green.
- [ ] 6. Samples: sample1 vault file, demo script, `mt.json`, `pipe10-secrets.ts`, its test, README.
      Check: `pnpm test` sample IT green (pipe10 resolves a `secrets:` ref end-to-end).
- [ ] 7. Docs: `docs/SKILL.md` (+ `gen:skill`, bump `skill-version`), steering, guiding,
      `vault.example.json`, `install.sh`, `Dockerfile`, `entrypoint.sh`, ideas.
      Check: `mt skill` output matches `docs/SKILL.md`; drift test green.
- [ ] 8. Grep gate: `git grep -nIi "embed" -- . ':!pnpm-lock.yaml' ':!sandbox/pnpm-lock.yaml'
      ':!packages/tools/tests/it/router-vault.it.test.ts' ':!docs/kanban.md' ':!docs/plans/*'
      ':!samples/depricated/*' ':!packages/router/.output/*' ':!packages/router/.nitro/*'`
      → no output. Then full gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm ci:local`,
      and `pnpm test:gpu` before any FF-merge (GPU gate is required for the merge, not for the
      rename itself).
- [ ] 9. Migration note: add a short "breaking rename" section to `docs/guiding/vault.md` and
      `docs/SKILL.md` (old `embed:` refs, `MT_EMBED_*`, `*.embed.json` stores are no longer read).

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 8h
Estimated: -

## Done when

- The grep gate in step 8 prints nothing.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm ci:local` are green; `pnpm test:gpu` green
  before the FF-merge.
- `mt vault secrets-add` → `secrets:<name>` ref → resolved in a run (sample1 `pipe10-secrets` passes).
- A v3 store is written and a v2 store is rejected with a clear "wrong format" error.
- `mt skill` matches `docs/SKILL.md` (drift test green).
- No `embed` in the repo outside the documented exemptions in scope section 7.

<!-- provenance: row=b9cb9f84e72d layout=347ba342e2da -->
