# Installation — machinum-pipeline

How to get a working `mt` on a machine: prerequisites, install paths, the `mt-cli` wrapper (Linux
name collision), config/secrets, Docker. Arch digest: [onboarding.md](onboarding.md) ·
[architecture.md](architecture.md) · [steering/tech.md](../steering/tech.md).

## What you install

One artifact: the **Bun single-file binary** `mt` (`packages/mt/dist/bin/mt`, ~97 MB). It embeds the
Bun runtime, the CLI, all `@mt/*` packages, the admin UI and the router dashboard — **no Node, no
`node_modules`, no `dist/` on the target machine**.

```bash
mt init          # scaffold a project (mt.json + .mt/)
mt run ./p.ts    # execute a pipeline
mt resume <id>   # resume a paused/failed run
mt ls runs       # list runs
mt inspect <id>  # run details
mt tool <name>   # invoke a tool standalone (JSON on stdin/stdout)
mt serve         # admin backend (h3 + bun:sqlite + embedded UI)
mt router        # LLM proxy (OpenRouter pool, budgets)
mt vault <sub>   # vault: list|show|add|rm|path|init|vlt-install|vlt-status
mt mcp           # MCP server over stdio
```

## Prerequisites

| Tool | Version | Needed for | Notes |
|---|---|---|---|
| git | any | cloning the repo | `git@github.com:gleb619/machinum-pipeline.git` |
| Node.js | ≥ 20 | repo dev, pipelines run as TS | host uses 22.20.0 (nvm) |
| pnpm | 9.15.0 | install + build | pinned in `package.json` (`packageManager`) → `corepack enable` |
| Bun | ≥ 1.2 | **building** the binary only | host 1.3.14; not needed to *run* it |
| glibc | ≥ 2.17 | running the linux-x64 binary | binary links `GLIBC_2.17`; Alpine → musl target |
| docker + compose | any | optional dev services | ollama / qdrant / lightrag for pipelines |
| ollama (or `MT_OLLAMA_URL`) | any | local LLM inference | remote GPU host also works |

## Path A — build from source (recommended)

```bash
git clone git@github.com:gleb619/machinum-pipeline.git
cd machinum-pipeline
corepack enable          # pnpm 9.15.0 per packageManager
pnpm install
pnpm build:bin           # turbo build (deps) + bun compile -> packages/mt/dist/bin/mt
packages/mt/dist/bin/mt --help
```

- `pnpm build:bin` builds the workspace deps (`core`, `tools`, `waypoint`, `cli`, `router`, `backend`)
  and compiles the binary. `pnpm build` alone builds the packages but **not** the binary.
- Binary path: `packages/mt/dist/bin/mt`. Cross builds: `cd packages/mt && bun scripts/build-bin.ts
  --target bun-linux-x64-musl` (→ `dist/bin/mt-linux-x64-musl`) or `--all` for every target.
- **Rebuild after every source change** (`pnpm build:bin`) — a stale binary silently runs old code.
- `pnpm smoke:bin` = build + 15-step offline smoke test of the binary (init, run, serve, router, detach).

## Path B — run from source, no binary

```bash
pnpm install
pnpm --filter=mt exec tsx src/bin.ts --help
pnpm --filter=mt exec tsx src/bin.ts run ./pipelines/p.ts
```

Needs Node + `tsx` (root devDependency) and the workspace installed. Slower per start than the binary,
but no compile step — use while hacking on the CLI.

## Path C — npm package (pre-release)

Not published to npm yet ([steering/product.md](../steering/product.md)). `packages/mt/package.json`
declares `bin: { "mt": "./dist/bin.js" }`, so a global install puts **`mt`** on PATH — which collides
with Linux's `/usr/bin/mt` (see below). Until an aliased bin is published, use the wrapper.

## The `mt` name conflict → `mt-cli` wrapper (Linux)

Linux ships `/usr/bin/mt` (tape control, GNU cpio). This project's binary is also named `mt` → the
first hit on PATH wins, and `/usr/bin/mt` usually does:

```bash
$ which -a mt
/usr/bin/mt        # ← tape tool, not ours
/bin/mt
```

Fix: expose the binary under a different name through a **thin wrapper** in `~/.local/bin` (already on
PATH via `~/.bashrc` + `~/.bash_profile`; otherwise add `export PATH="$HOME/.local/bin:$PATH"`).

`~/.local/bin/mt-cli`:

```bash
#!/usr/bin/env bash
# mt-cli — thin wrapper around the machinum-pipeline standalone `mt` binary.
#   mt-cli <args>  ==  nvm use v22.20.0 && <repo>/packages/mt/dist/bin/mt <args>
set -uo pipefail

MT_CLI_BIN="${MT_CLI_BIN:-/media/boris/data_nvme1n1/WORKSPACES/WORKSPACE/machinum-pipeline/packages/mt/dist/bin/mt}"

if [ ! -x "$MT_CLI_BIN" ]; then
  echo "mt-cli: binary not found or not executable: $MT_CLI_BIN" >&2
  echo "mt-cli: build it with 'pnpm build:bin' in the machinum-pipeline repo" >&2
  exit 127
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  if command -v nvm >/dev/null 2>&1; then
    nvm use v22.20.0 >/dev/null 2>&1 ||
      echo "mt-cli: warning: 'nvm use v22.20.0' failed" >&2
  fi
else
  echo "mt-cli: warning: nvm not found at $NVM_DIR/nvm.sh" >&2
fi

exec "$MT_CLI_BIN" "$@"
```

```bash
chmod +x ~/.local/bin/mt-cli
```

Why a wrapper and not a symlink: `nvm use v22.20.0` must run **before** the call, and `nvm` is a shell
function — a symlink cannot source it. The wrapper keeps the repo path in one place and survives a
rebuild (the path does not change).

- `MT_CLI_BIN` overrides the binary path (another checkout, a musl build, a copy in `/opt`).
- The binary is self-contained: the `nvm use` step is about the surrounding toolchain, not the binary.
- Inside a container there is no `/usr/bin/mt` conflict — see [Docker](#docker).

## Verify

```bash
mt-cli --help        # Usage: mt <command> [options]
mt-cli --version     # mt 0.1.0
mt-cli init          # scaffolds mt.json + .mt/ (+ .mt/master.key) in the current dir
```

## Master key (every new installation)

The embedded secret store (`embed:<name>` refs) is sealed under a master password. Without one it
falls back to a **public** built-in password, which only obfuscates. So every new installation gets
its own random 256-bit master key.

- **New project:** `mt init` writes `.mt/master.key` (mode 0600), adds `.mt/master.key` and `*.key`
  to `.gitignore`, and prints a reminder. Skip with `mt init --no-master-key`. It is also skipped
  (with a notice) when a key is already configured or an embedded store already exists.
- **Existing or global install:** `mt vault master-key generate --rekey` (project) or
  `mt vault master-key generate --user --rekey` (`~/.mt/master.key`). `--rekey` re-wraps an existing
  store under the new key; without it generate refuses when a store exists. An existing key file is
  never overwritten without `--force`.
- **Inspect:** `mt vault master-key status` (active source: env / env-file / project / user /
  default; never prints the key), `mt vault master-key show-path`.
- **Resolution order:** `MT_EMBED_PASSWORD` > `MT_EMBED_PASSWORD_FILE` > `<root>/.mt/master.key` >
  `~/.mt/master.key` > built-in default (warns).
- **Back it up.** Losing the file makes embedded secrets unrecoverable. It is gitignored; never commit it.
- **CI / Docker:** do not bake a key into an image. Mount a secret and point
  `MT_EMBED_PASSWORD_FILE=/run/secrets/mt_master_key` at it (or generate one at container start with
  `mt vault master-key generate --user`, on a persistent volume).
- **Install scripts and the Docker image** (`docs/install.sh`, `Dockerfile`, added separately) must
  generate a master key on first install rather than shipping the default.

## Configuration & secrets

| What | Where | Notes |
|---|---|---|
| project config | `mt.json` (cwd) | `secrets.envFile` → `.env` (gitignored) |
| API keys | `OPENROUTER_API_KEYS` | comma-separated key pool |
| router endpoint | `MT_ROUTER_URL` | default `http://localhost:7777` |
| vault | `~/.mt/vault.json`, `<root>/.mt/vault.json` | refs `@vault/entry/model` in `llm.use` |
| logging | `MT_LOG_LEVEL`, `MT_DEBUG` | per-run CLI logs |
| run state | `.mt/` in the project root | `runs/`, `cache/`, `worktrees/`, `mt.sqlite` |

Secret refs also resolve through `vlt:` / `keepass:` / `embed:` (see [steering/tech.md](../steering/tech.md#environment-variables)).
Never log key material; vault files are gitignored.

## Docker

**Status: no image/Dockerfile in the repo yet.** Two separate needs:

1. **Run `mt` inside a container** — planned shape: build stage `node:22` (pnpm install + build) →
   compile stage `oven/bun` (`bun scripts/build-bin.ts`) → runtime stage with just the binary.
   The runtime needs **no** Node; it needs glibc ≥ 2.17 (Debian/Ubuntu base) or the **musl** build for
   Alpine, plus a writable project dir (`.mt/` state) and a writable `HOME` (vault).
   Sketch:

   ```dockerfile
   FROM node:22-bookworm AS build
   WORKDIR /app
   COPY .. .
   RUN corepack enable && pnpm install --frozen-lockfile && pnpm build:bin

   FROM debian:bookworm-slim
   COPY --from=build /app/packages/mt/dist/bin/mt /usr/local/bin/mt
   WORKDIR /work
   ENV HOME=/work
   VOLUME ["/work"]
   ENTRYPOINT ["mt"]
   ```

   `docker run --rm -v "$PWD:/work" myimage run ./pipelines/p.ts`
   `MT_OLLAMA_URL` / `OPENROUTER_API_KEYS` come in as env vars; secrets via `env_file`, not baked in.
   Inside the container the name is plain `mt` — the `mt-cli` wrapper is a host-side workaround only.

2. **Dev services for pipelines** — the `dockerComposeEmitter` tool
   (`packages/tools/src/core/docker-compose.ts`) writes a `docker-compose.yml` with presets for
   `ollama`, `qdrant`, `lightrag` (the `lightrag` image is a placeholder — pin a real one first).

## Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `mt` prints tape usage | you ran `/usr/bin/mt` | use `mt-cli` |
| `mt-cli: binary not found` | never built, or repo moved | `pnpm build:bin`; or set `MT_CLI_BIN` |
| binary behaves like an old version | stale binary | rebuild: `pnpm build:bin` |
| `mt-cli` not found in a new terminal | `~/.local/bin` not on PATH | add to `~/.profile` / `~/.bashrc` |
| `GLIBC_2.x not found` | ancient distro / Alpine | use the musl target |
| `mt serve` port busy | default port taken | `mt serve --port <p>` |
| 401 / 429 from the LLM | keys missing or pool exhausted | `OPENROUTER_API_KEYS`, vault refs |
| pipeline fails on a missing package | binary has no `node_modules` | project-local deps must be installed next to the pipeline |
