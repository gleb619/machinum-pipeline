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
mt info          # effective config (secrets masked) + .mt state
mt inspect <id>  # run details
mt tool <name>   # invoke a tool standalone (JSON on stdin/stdout)
mt serve         # admin backend (h3 + bun:sqlite + embedded UI)
mt router        # LLM proxy (OpenRouter pool, budgets)
mt vault <sub>   # vault: list|show|add|rm|path|init|vlt-install|vlt-status
mt skill         # print/install the agent skill (SKILL.md)
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

## Path 0 — install script (no repo checkout)

[`docs/install.sh`](../install.sh) installs `mt` three ways. POSIX `sh`, idempotent, **never uses sudo**,
never prints a master key. It prints its plan first and asks to confirm (`--yes` skips; without a
terminal `--yes` is required).

```bash
# read it first, then run it (preferred over piping)
curl -fsSL https://raw.githubusercontent.com/gleb619/machinum-pipeline/main/docs/install.sh -o install.sh
less install.sh && sh install.sh --dry-run
sh install.sh --user-master-key            # released binary -> ~/.local/bin/mt + ~/.mt/master.key

# one-liner (prints the plan, then asks on /dev/tty)
curl -fsSL https://raw.githubusercontent.com/gleb619/machinum-pipeline/main/docs/install.sh | sh -s -- --docker
```

| Flag | Meaning |
|---|---|
| `--no-docker` (default) | download `mt-<target>` from GitHub Releases, verify sha256 against `SHA256SUMS`, install |
| `--docker` | `docker pull ghcr.io/gleb619/machinum-pipeline:<v>` + install a wrapper command that runs it |
| `--from-source` | clone, `corepack` pnpm shim in a temp dir, `pnpm build:bin`, install (needs git, node>=20, corepack, bun) |
| `--version <v>` | release to install (default: latest GitHub release; fails with a hint if none is published) |
| `--prefix <dir>` / `MT_INSTALL_DIR` | install into `<dir>/bin` (default `~/.local/bin`) |
| `--name <n>` | command name; use `--name mt-cli` to dodge Linux's `/usr/bin/mt` (the script warns on collision) |
| `--user-master-key` | run `mt vault master-key generate --user`, unless `MT_EMBED_PASSWORD(_FILE)` or `~/.mt/master.key` exists |
| `--force`, `--yes`, `--dry-run` | reinstall same version / no prompt / show plan only |
| `--uninstall` | remove the command only (`~/.mt`, vault and `master.key` are never touched) |

Targets: `linux-x64`, `linux-x64-musl` (auto-picked on Alpine), `linux-arm64`, `linux-arm64-musl`,
`darwin-x64`, `darwin-arm64`. Windows: use `--docker` under WSL.

**`curl | sh` caution.** Piping runs whatever the URL serves at that moment. Download, read, then run;
or pin a tag in the URL (`.../v0.1.0/docs/install.sh`). The script itself only fetches release assets
and refuses to install on a checksum mismatch.

**Verify a binary by hand:**

```bash
v=0.1.0; t=linux-x64
curl -fsSLO https://github.com/gleb619/machinum-pipeline/releases/download/v$v/mt-$t
curl -fsSLO https://github.com/gleb619/machinum-pipeline/releases/download/v$v/SHA256SUMS
grep " mt-$t\$" SHA256SUMS | sha256sum -c -        # macOS: shasum -a 256 -c -
```

macOS binaries are not code-signed/notarized. Files fetched with `curl` carry no quarantine flag; if you
download through a browser run `xattr -d com.apple.quarantine mt-darwin-arm64`.

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
- **Install script and Docker image:** `install.sh --user-master-key` and the image's entrypoint both
  generate a key on first use instead of shipping the default (details in [Docker](#docker)).

## Teach your agent: `mt skill --install`

The binary embeds an agent skill (`docs/SKILL.md`) that explains project layout, the DSL, CLI, secrets and
common errors to any coding agent.

```bash
mt skill --install                    # .agent/skills/mt/SKILL.md in the current project
mt skill --install --target claude    # .claude/skills/mt/SKILL.md (also: codex, opencode, agents)
mt skill > path/SKILL.md              # or redirect stdout
mt skill --out ./SKILL.md --force     # explicit file, overwrite
mt skill --path                       # embedded skill-version
```

Re-run with `--force` after upgrading `mt`.

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

Image: `ghcr.io/gleb619/machinum-pipeline:<X.Y.Z | X.Y | latest>` (linux/amd64 + arm64, Debian slim,
non-root user `mt` uid 1000, `WORKDIR /work`, `MT_HOME=/home/mt/.mt`). Built by the
[`Dockerfile`](../../Dockerfile) from the **released binary** (sha256-verified), not from npm: the
artifact is a Bun binary, and the `mt` npm name is unscoped, which GitHub Packages' npm registry does not accept.
Inside the container the name is plain `mt` (no `/usr/bin/mt` clash). No HEALTHCHECK: it is a CLI.
The release is published by `.github/workflows/release.yml` on a `vX.Y.Z` tag (the package may need to be
made public once in the GitHub package settings).

```bash
sh install.sh --docker --yes        # installs a wrapper `mt` in ~/.local/bin
mt run ./pipelines/p.ts             # == docker run --rm -it --user $(id -u):$(id -g) -v $PWD:/work -w /work -v ~/.mt:/home/mt/.mt ... image run ./pipelines/p.ts

# or by hand
docker run --rm -v "$PWD":/work -v "$HOME/.mt":/home/mt/.mt ghcr.io/gleb619/machinum-pipeline:latest run ./pipelines/p.ts
```

What to mount:

| Mount | Why |
|---|---|
| `$PWD` -> `/work` | project: `mt.json`, `pipelines/`, `.mt/` run state |
| `~/.mt` -> `/home/mt/.mt` | `master.key`, embedded secret store (`secrets.embed.json`), user vault. Without it every `--rm` container forgets its key and its secrets |

Env passed by the wrapper: `OPENROUTER_API_KEYS`, `MT_OLLAMA_URL`, `MT_ROUTER_URL`, `MT_LOG_LEVEL`, `MT_DEBUG`,
`MT_EMBED_PASSWORD`. Extra flags: `MT_DOCKER_ARGS="-p 3000:3000"` (for `mt serve`), `MT_IMAGE` overrides the image.
`localhost` inside the container is the container: point `MT_OLLAMA_URL` at the host/GPU address.

**Master key in Docker.** Never bake a key into an image or commit it.

- *First run (default):* the entrypoint (`mt-entrypoint`) generates `/home/mt/.mt/master.key` (mode 0600) when no key
  source exists (no `MT_EMBED_PASSWORD(_FILE)`, no `$MT_HOME/master.key`, no `<project>/.mt/master.key`). It prints
  only the path. It skips `--help`, `--version`, `skill`, `init` and `vault master-key ...`, and `MT_NO_AUTO_KEY=1` disables it.
  This only helps if `/home/mt/.mt` **persists** (host dir or named volume `-v mt-home:/home/mt/.mt`).
- *CI / orchestrators:* mount a secret and point at it, no key file is created:
  `docker run -v ./mt_master_key:/run/secrets/mt_master_key:ro -e MT_EMBED_PASSWORD_FILE=/run/secrets/mt_master_key ...`
  (compose: `secrets:` + the same env var; GitHub Actions: write the secret to a file, never echo it).
- *Back it up:* lose `master.key` (or the secret) and `embed:` secrets are gone. `docker run --rm -v ~/.mt:/home/mt/.mt ... vault master-key status` shows the active source without printing the key.

Build the image yourself:

```bash
docker build --build-arg MT_VERSION=0.1.0 -t mt .                      # from the GitHub release
pnpm build:bin && docker build --build-arg MT_SOURCE=local -t mt .     # from packages/mt/dist/bin/mt (BuildKit)
```

**Dev services for pipelines** are a separate topic: the `dockerComposeEmitter` tool
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
| `install.sh`: could not determine the latest release | no release published / rate limited | `--version <v>` or `--from-source` |
| `docker pull` denied | ghcr package still private | make it public in package settings, or `docker login ghcr.io` |
| secrets vanish between `docker run`s | `~/.mt` not mounted | mount a volume/dir at `/home/mt/.mt` or use `MT_EMBED_PASSWORD_FILE` |
| `mt serve` port busy | default port taken | `mt serve --port <p>` |
| 401 / 429 from the LLM | keys missing or pool exhausted | `OPENROUTER_API_KEYS`, vault refs |
| pipeline fails on a missing package | binary has no `node_modules` | project-local deps must be installed next to the pipeline |
