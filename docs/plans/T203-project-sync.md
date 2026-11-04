# T203 — Project sync: /api/sync/*, mt.json remote.sync, `mt remote sync`, health capabilities

## Keywords

Keywords: sync manifest, /api/sync/manifest, /api/sync/files, remote.sync, mt remote sync, sha256, resolveInsideRoot, atomicWriteFile, /api/health, capabilities, projectId, .mt/remote

## Goal

Idea section 1a. Content-addressed rsync-style delta sync over the admin HTTP API, symmetric (client<->server, server<->server). Delivers: server routes, shared sync library, `mt.json` scope, `mt remote sync` command, enriched `/api/health`.

Layering (decision): sync engine (manifest build, diff, glob scope, apply) lives in **`@mt/core`** (`packages/core/src/sync/`) so webui routes and cli both use it with no cross-imports. HTTP client part for the CLI in `packages/cli/src/utils/remote-client.ts` (also reused by T204/T205). Routes in `packages/webui/server/routes/api/sync/`.

Defaults chosen (open questions):
- `projectId` = slug of local project dir name + 8-char hash of absolute root (stable, no secrets), overridable `mt.json -> remote.projectId`. Server mirror root: `<serveRoot>/.mt/remote/<projectId>/` sandboxed via `resolveInsideRoot` (`packages/webui/server/utils/resolve-inside-root.ts`); path traversal + symlink escape rejected; absolute/`..` paths 400.
- Manifest entry `{ path, size, sha256, mtime }`; diff by sha256 (mtime informational). Hash cache keyed by size+mtime to avoid rehash.
- Transfer: `PUT /api/sync/files` accepts a stream of length-prefixed JSON-header + body frames (no multipart dep); per-file cap `remote.sync.maxFileBytes` default 20 MB, total per request 64 MB, whole-project cap 500 MB; chunked by client; each file written atomic (temp-then-rename); resumable by re-diff.
- Default scope: include `pipelines/**`, `mt.json`, local modules imported by pipelines (static import walk, best effort), input files declared by `.from('jsonl://…'|'md://…')` when relative; exclude `.mt/`, `node_modules/`, `.env*`, vault/keepass/embed files, `.git/`, `dist/`. User override via `mt.json remote.sync.include/exclude` globs. Exclusions are enforced **server-side too** (never accept `.env`/vault paths).
- Delete removed files only with `--prune`. Conflict policy: refuse. `push` writes only sources scope; `pull` writes only paths under the run's target outputs / `.mt/runs/<id>/` (server declares via manifest `scope=outputs&runId=`). Both-changed on push = remote file differs from last-synced hash recorded in `.mt/remote/<projectId>.sync.json` -> refuse unless `--force`.
- Git mode (`remote.sync.mode: "git"`) and `--install` (remote `scripts.install`) = **deferred**, listed as non-goals; note in plan follow-ups.
- `/api/health` extended (authenticated callers only when T202 token set): `{ status, version, capabilities: { chrome, docker, playwright, ollama }, syncVersion: 1 }`. Capability detection cheap + cached 60 s (`which`/`docker info --format` with 2 s timeout); never throws.
- Version guard: client compares `mt` version exact major.minor; mismatch -> refuse unless `--allow-version-mismatch`.
- Config key `mt.json remote: { url, tokenRef, projectId?, sync?: {include, exclude, maxFileBytes, mode} }`; add to config type/validator in `packages/core/src/config.ts` and JSON schema (`packages/vscode` schema, find via grep `mt.json` schema).

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 8h

## Files to touch

- core: new `packages/core/src/sync/{manifest,scope,diff,apply}.ts` + export; `config.ts` (`remote` section); tests `packages/core/tests/sync*.test.ts`
- webui: `routes/api/sync/manifest.ts`, `routes/api/sync/files.ts`, `routes/api/health.ts` (capabilities), register in `standalone.ts` `createBackendApp` router; tests `packages/webui/tests/api/sync*.test.ts`
- cli: new `packages/cli/src/commands/remote.ts` (`mt remote sync [--push|--pull] [--dry-run] [--prune] [--force] [--watch] [--url] [--token-ref]`), register in `packages/cli/src/index.ts`, `utils/remote-client.ts`; tests `packages/cli/tests/commands/remote.test.ts`
- Docs: `docs/steering/core.md`, `webui.md`, `cli.md`, `docs/guiding/architecture.md` (`.mt/remote/`), new section in `docs/guiding/installation.md`; idea doc 1a -> implemented/deferred items
- `docs/SKILL.md`: new command, config key, `.mt/remote/` state dir = mandatory; bump version/date; `pnpm --filter=@mt/cli gen:skill`; verify `mt skill`; drift test must pass

## Steps

- [ ] Read core.md, webui.md, cli.md, structure.md, `resolve-inside-root.ts`, `atomicWriteFile` in core
- [ ] Failing tests (core): manifest of fixture tree, scope globs, diff (new/changed/removed), apply atomic + traversal rejection + excluded `.env` rejected
- [ ] Implement core sync lib
- [ ] Failing + impl webui routes (needs T202 auth middleware in place; tests with and without token)
- [ ] Health capabilities + version
- [ ] CLI `mt remote sync` push/pull/dry-run/prune/watch (watch = fs.watch debounce 300 ms), conflict refusal
- [ ] Round-trip integration test: two in-process `startBackend` servers (server<->server)
- [ ] Docs + SKILL.md + gen:skill; gates; `pnpm build:bin && pnpm smoke:bin`

## Done when

- core, webui, cli sync tests green incl. server<->server roundtrip
- `mt remote sync --dry-run` prints the diff; `.env`/vault never in manifest
- lint, typecheck, samples IT, test:gpu, ci:local reported

Gates (report all before FF-merge, per docs/change-workflow.md): `pnpm lint`, `pnpm typecheck`, `pnpm test` (scoped first), samples IT, `pnpm test:gpu` (needs `MT_OLLAMA_URL`; unreachable = report failure, never skip), `pnpm ci:local`. `pnpm build:bin && pnpm smoke:bin`. Logging only via logger APIs. Atomic writes. No AI attribution trailers.

Deps: blocked by T202. Blocks T204, T205. Size note: if >8h in practice, split core lib (3h) from CLI command (3h).
