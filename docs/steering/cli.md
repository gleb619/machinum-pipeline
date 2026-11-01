# @mt/cli
← [Architecture](../guiding/architecture.md)

Path: `packages/cli/`

The `mt` binary. Loads pipelines at runtime via `tsx`/`jiti` — no consumer build step required.
Imports from `@mt/core` and `@mt/waypoint` only; `@mt/backend/standalone` is imported lazily for
`mt serve` (see [import layers](tech.md#import-layer-rules-enforced)).

## Distribution

- **npm**: `mt` package (`packages/mt`) ships the CLI as bin `mt` (Node >= 20; `.ts` pipelines need
  `NODE_OPTIONS='--import tsx'` or Node >= 22.18 type stripping).
- **Single-file binary** (Bun, no node/pnpm/node_modules): `pnpm build:bin` -> `packages/mt/dist/bin/mt`
  (92.4 MiB on linux-x64). Includes `mt serve` (h3 API + `bun:sqlite` + embedded admin UI).
  Pipelines are imported at runtime by Bun (TS works natively).

  ### Import matrix inside the binary

  | Import in a pipeline | Works | How |
  |---|---|---|
  | `mt`, `mt/tools`, `mt/waypoint` (+ legacy `@mt/core\|tools\|waypoint`) | yes | Bun runtime plugin `packages/mt/src/embed.ts`; same module instances as the Runner |
  | `node:*` builtins | yes | Bun |
  | relative `./x`, `../lib/helper` (.ts/.js, extension optional) | yes | Bun resolver |
  | package in `node_modules` next to/above the pipeline, entry point `<pkg>/index.js` | yes | Bun resolver (no install step, no network) |
  | package whose `main`/`exports` point into a subdirectory (e.g. `lib/index.js`) | yes, for direct imports | the pipeline loader resolves the specifier per importer (`packages/mt/src/pipeline-loader.ts`) and rewrites it to an absolute path — Bun's compiled-binary resolver only finds `<pkg>/index.js` |
  | `zod` | yes | resolved per importer: the project's own copy wins, the embedded copy is the fallback |
  | native addons (`.node`, e.g. `better-sqlite3`, `sharp`) | no | Bun cannot load them; the failure carries an explicit hint ("not supported by the binary") |
  | any other npm package | only if installed next to/above the pipeline | not embedded; add it to the project |

  ### Cross-target matrix

  `bun scripts/build-bin.ts --all` builds every target; `bun scripts/build-bin.ts --target <t>` builds one.
  Building a foreign target downloads that Bun runtime once (needs network, then cached); the produced
  binary is offline. The smoke test runs against any binary: `scripts/smoke-bin.sh --bin <path>`.

  | Target | Binary | Builds | Runtime verified |
  |---|---|---|---|
  | `bun-linux-x64` | `dist/bin/mt` | yes | yes — host, `pnpm smoke:bin` |
  | `bun-linux-x64-musl` | `dist/bin/mt-linux-x64-musl` | yes | yes — alpine 3.20 container (`apk add libstdc++`), full smoke passes |
  | `bun-linux-arm64` | `dist/bin/mt-linux-arm64` | yes | yes — arm64v8/debian container under qemu-user |
  | `bun-linux-arm64-musl` | `dist/bin/mt-linux-arm64-musl` | yes | yes — alpine arm64 container under qemu-user |
  | `bun-darwin-x64` | `dist/bin/mt-darwin-x64` | yes | no macOS runner available |
  | `bun-darwin-arm64` | `dist/bin/mt-darwin-arm64` | yes | no macOS runner available |
  | `bun-windows-x64` | `dist/bin/mt-windows-x64.exe` | yes | no Windows runner available |

  The musl builds are dynamically linked against musl **and** `libstdc++`/`libgcc` (Bun 1.3.14 links
  them that way), so an alpine image needs `apk add libstdc++`; the glibc builds need their own libc.

  ### Size

  An empty `bun build --compile` program is 90.2 MiB — the Bun runtime is the floor, so the binary
  cannot get below ~90 MB without a different runtime. The app code adds ~2.2 MiB:

  | Binary | Size |
  |---|---|
  | `mt-linux-x64` | 92.4 MiB |
  | `mt-linux-x64-musl` | 89.1 MiB |
  | `mt-linux-arm64` | 91.5 MiB |
  | `mt-darwin-arm64` | 62.7 MiB |
  | `mt-windows-x64.exe` | 96.1 MiB |

  `--minify` is on (saves 1.3 MB). `tiktoken` is replaced by the pure-JS `gpt-tokenizer` in the binary
  (`packages/mt/scripts/tiktoken-shim.ts`): Bun's bundler mis-compiles tiktoken's WebAssembly module,
  so the token counter traps without the shim.

## Commands

| Command | File | Description |
|---|---|---|
| `mt init` | `init.ts` | Scaffold `.mt/`, `mt.json` in a consumer project; keeps `.gitignore` covered |
| `mt run <pipeline.ts> [--pipeline <name>]` | `run.ts` | Execute the default suite, an implicit suite of all exported pipelines, or one named export (pipeline or suite); build GlobalContext, start one Runner per pipeline. Runs the `scripts.start` hook before and `scripts.end` hook after (success or failure); `scripts.error` on failure, `scripts.stop` on SIGINT pause, `scripts.exit` before process exit |
| `mt install` | `install.ts` | Run the `scripts.install` lifecycle hook pipeline from mt.json (one-time project setup); `--pipeline <name>` for named exports |
| `mt resume <runId> [pipeline.ts]` | `resume.ts` | Load checkpoint.json, resume from first non-done node; pipeline file/id come from state.json (file arg overrides the file); runs `scripts.resume` before resuming. Only an individual pipeline can be resumed — never a suite as a whole |
| `mt ls runs` | `list.ts` | List all runs with state/timing summary |
| `mt inspect <runId>` | `inspect.ts` | Show checkpoint tree, events, run metadata |
| `mt tool <name> [--pipeline <file>]` | `tool.ts` | Invoke a tool standalone (JSON exchange on stdin/stdout (`id`/`variables` optional, normalized by `toExchange`)); the tool is found by scanning the tool steps of the pipelines declared in `mt.json` (`discoverPipelines` + `importPipelineModule`, see `utils/find-tool.ts`), `--pipeline` restricts the search to one file. Unknown name lists the available tools; a TTY stdin prints a usage hint instead of hanging |
| `mt serve [--port N\|0] [--host H] [--detach]` | `serve.ts` | Start admin API + UI (`@mt/backend/standalone`); `--detach` re-execs self in background (`.mt/backend/{pid,server.log}`); port 0 = random free port |
| `mt router [--port N\|0] [--host H] [--mock] [--log-dir D] [-d\|--detach]` | `router.ts` | Start the keyless LLM gateway + dashboard (`@mt/router/standalone`); no `--token` flag — the token is `MT_ROUTER_TOKEN`; `--detach` re-execs self in background (`.mt/router/{pid,server.log}`) |
| `mt skill [--out <f>] [--install [dir]] [--target claude\|codex\|opencode\|agents] [--force] [--path]` | `skill.ts` | Print the agent skill (`docs/SKILL.md`, embedded at build time via `src/generated/skill-content.ts`, generated by `scripts/gen-skill.mjs`) to stdout; `--out` atomic write (no overwrite without `--force`); `--install` writes `<dir>/SKILL.md` (default `.agent/skills/mt`; presets `.claude/.codex/.opencode/.agent` + `/skills/mt`); notices on stderr; drift test in `tests/commands/skill.test.ts` |
| `mt vault <sub>` | `vault.ts` | Manage the vault: `list`, `show`, `add`, `rm`, `path`, `init`, `vlt-install`, `vlt-status`, `keepass-init`, `keepass-add`, `keepass-list`, `keepass-status`, `embed-init`, `embed-add`, `embed-list`, `embed-status`, `embed-rekey`, `embed-rotate`, `embed-keyring`, `master-key` (secrets masked unless `--reveal`) |

## Pipeline Loading

`tool.ts` resolves the tool before reading stdin (a bad name must not hang the terminal), then builds a minimal RunContext/ToolContext like the Runner's (`loadGlobalContext` + a `tool-<uuid>` runId, checkpoint id `standalone`).

Both `run.ts` and `resume.ts` use `@mt/core`'s `loadGlobalContext()` plus a local loader:

```typescript
const ctx = await loadGlobalContext(projectRoot) // mt.json + secrets.envFile — same loader as the backend
const runnable = await loadRunnable(pipelineFilePath, pipelineName) // run.ts → Pipeline | PipelineSuite
// resume.ts: const pipeline = await loadPipeline(pipelineFilePath, state.pipelineId, state.pipelineName)
```

`mt run <file>` resolves the runnable in this order:

1. `--pipeline <name>` — exactly that export, whether it is a `Pipeline` or a `PipelineSuite`.
2. Default export is a suite (`isPipelineSuite`) — run it as declared (`mode` from the suite).
3. Otherwise — build an **implicit suite** from every exported `Pipeline` (`isPipeline`: object with a
   string `id` and a `steps` array). The default export comes first (falling back to `pipeline`), then
   the remaining exports alphabetically, deduped by identity. Id: `<file-basename>-suite`
   (e.g. `basic-md-processing-suite`), mode `'sync'`. The suite is run, not awaited from sample code.

A `--pipeline` export that is an id-only legacy object is still accepted. Errors name the missing/invalid
export.

For suites the CLI logs `Starting suite: <id> (<n> pipelines, mode: <mode>)`, collects each Runner via
`onRunner` (binding the DuplexLogger run id), pauses every collected Runner on SIGINT, and on success
prints `✅ Suite complete.` plus each `pipeline.id -> runId`.

`resume` always reads `.mt/runs/<runId>/state.json` for `pipelineId` (and `pipelineFile`/`pipelineName`
when the file argument is missing). It resolves a named export first, otherwise finds the `Pipeline` whose
`id` equals `pipelineId` among the module exports **including `suite.pipelines`**. If the export is a suite
without that pipeline it fails with a clear message: a suite cannot be resumed as a whole.

The loader uses `tsx`/`jiti` dynamic import — the consumer file is **not** compiled ahead of time. Plain
`import`, `console.log`, and conditionals all work inside pipeline files.

The single-file binary installs its own loader (`@mt/core`'s `setPipelineModuleLoader`, implemented in
`packages/mt/src/pipeline-loader.ts`): it resolves every bare specifier of the pipeline against the
pipeline's own directory and rewrites it to an absolute path, because Bun's compiled-binary resolver
only finds packages whose entry point is `<pkg>/index.js`. The project's own copy of a library
therefore wins over the copy embedded in the binary, and the pipeline id stays the one derived from
the original file.

## Key Files

### `src/index.ts`
Entry point: `main()` function, arg parsing, dispatch to command modules. Handles top-level errors and process exit codes.

### `src/commands/run.ts`
1. `loadGlobalContext(projectRoot)` → `GlobalContext` (from `@mt/core`; no CLI-local `mt.json` parsing)
2. `loadRunnable(file, name?)` → `Pipeline | PipelineSuite` (named export → default suite → implicit suite)
3. `runLifecycleScript(ctx, 'start')` → no-op unless `scripts.start` is defined in mt.json
4. Pipeline: `new Runner(pipeline, ctx)` → `runner.start()`; suite: `suite.run(ctx, { onRunner })`, one
   Runner per pipeline (sync sequential, or `Promise.all` in `'parallel'` mode)
5. Listen for SIGINT → pause the pipeline Runner (or every collected suite Runner) →
   `runLifecycleScript(ctx, 'stop')` → `runLifecycleScript(ctx, 'exit')`
6. On main run failure → `runLifecycleScript(ctx, 'error')`
7. `runLifecycleScript(ctx, 'end')` in a finally-style path (runs on success AND failure; an
   end-hook error is logged as a warning and never masks the main outcome)
8. `runLifecycleScript(ctx, 'exit')` before the process exits

### `src/commands/install.ts`
`mt install` — runs the `scripts.install` pipeline from mt.json via the shared
`commands/utils/lifecycle.ts` helper (`runLifecycleScript(ctx, name)`): resolves the script path
inside the project root, `importPipelineModule`, default/named (`--pipeline <name>`) export,
`new Runner(...)` → `runner.start()`. Exits 1 with a clear message when `scripts.install` is
undefined or the script file is invalid.

### `src/commands/resume.ts`
Same as `run.ts` but calls `runner.resume(runId)` instead of `runner.start()`, and runs
`runLifecycleScript(ctx, 'resume')` before resuming. On resume failure it also runs
`runLifecycleScript(ctx, 'error')`. `state.json` is always read for `pipelineId`; the pipeline file is
the explicit `[pipeline.ts]` argument when given, otherwise `pipelineFile` recorded in
`.mt/runs/<runId>/state.json` (written by `mt run` since T096). The pipeline is then found by matching
`pipelineId` against module exports, including pipelines nested in a suite export. A suite itself cannot
be resumed: if only a non-matching suite is found, the command explains that the run belongs to one of its
pipelines. Runs started by older versions without a recorded file get an error naming the exact
`mt resume <runId> <pipeline.ts>` fallback. `Runner.resume()` throws `pipelineId mismatch` when the loaded
pipeline's `id` differs from the recorded run.

### `src/commands/serve.ts`
- `serveCommand()` lazy-imports `@mt/backend/standalone` and calls `startBackend()` (plain h3 on `node:http`; no Nitro
  at runtime). SIGINT/SIGTERM close the server. UI dir: `$MT_UI_DIR` > `<pkg>/dist/ui` > `packages/frontend/dist`;
  in the Bun binary the UI is embedded (`globalThis.__MT_UI__`).
- `detachServe()` re-spawns `process.execPath` (the binary itself when compiled) in the foreground mode, detached
- `parseArgs()` handles `--port`, `--host`, `--detach`

### `src/utils/logger.ts` — `DuplexLogger`
Writes to both console (with ANSI colour) and a log file under `.mt/runs/<runId>/`. Implements `Logger` from `@mt/core/types`.

### `src/commands/router.ts`
- `routerCommand()` lazy-imports `@mt/router/standalone` and calls `startRouter()`; keys come from
  `loadGlobalContext()` (`mt.json → secrets.envFile`, `process.env` wins) as `OPENROUTER_API_KEYS`
- Dashboard dir: `$MT_ROUTER_UI_DIR` > `<pkg>/dist/router-ui` > `packages/router/public`
- `detachRouter()` re-spawns `process.execPath ... router` detached; PID + logs under `.mt/router/`
- No `--token` flag: the bearer token is `MT_ROUTER_TOKEN` only, and the router's bind guard refuses a
  non-loopback `MT_ROUTER_HOST` / `--host` without it — see [router.md](router.md#security-model-t119)

### `src/commands/vault.ts`
`mt vault` — `list` / `show` / `add` / `rm` / `path` / `init` over the `@mt/core` vault. Plaintext keys are never written: `add` moves `--api-key(s)` into the embedded store (`embed:<name>`), embed commands never prompt (default password fallback + warning). Writes go
through `saveVault` (atomic, mode 0600). Secrets are masked in every output unless `--reveal` is
given. `--user` targets `~/.mt/vault.json`, otherwise `<project>/.mt/vault.json`; `MT_VAULT` wins
over both. `list`/`show` and the file-editing flows load with `resolveRefs: false` so stored
`vlt:` / `keepass:` / `embed:` refs display and round-trip unchanged. `vlt-install` runs `installVlt()`
(prints path + version); `vlt-status` prints binary location, version and session state (probes
`vlt find`, never prints secrets). `keepass-init` / `keepass-add` / `keepass-list` /
`keepass-status` manage the KeePass backend (`--path`, `--key-file`, `--secret`, `--username`,
`--group`); the master password comes from `MT_KEEPASS_PASSWORD` / `_FILE` or a hidden TTY prompt,
and no secret is ever printed. `embed-init` / `embed-add` / `embed-list` / `embed-status` manage
the embedded encrypted store (`--path`, `--secret`, `--username`, `--notes`, `--force`); the master
password comes from `MT_EMBED_PASSWORD` / `_FILE` or a hidden TTY prompt. `embed-add --kid <kid>`
seals under a chosen encryption key. `embed-rekey` changes the master password (new one via
`--new-password-file`, `MT_EMBED_NEW_PASSWORD(_FILE)` or a confirmed hidden prompt); `embed-rotate <name>`
replaces a secret value (`--value-file`, stdin or hidden prompt); `embed-keyring
generate|add|list|use|retire|rm|rotate` manages the encryption keys (`--kid`, `--enc-key-file`,
`--note`, `--no-activate`, `--reencrypt`, `--force`). Passwords, secret values and encryption keys are
never accepted as CLI argument values and never printed. The router reads those same files as upstream key sources
([router.md](router.md#vault-t118)). Details: [docs/vault.md](../guiding/vault.md).

### `src/commands/skill.ts`
`docs/SKILL.md` is the single source. `scripts/gen-skill.mjs` (run by `pnpm --filter=@mt/cli build` and `gen:skill`; `--check` verifies) writes the committed `src/generated/skill-content.ts` (`SKILL_MD`, `SKILL_VERSION`), so the text ships inside the npm package and the Bun binary with no runtime read of `./docs`. Editing `docs/SKILL.md` without regenerating fails `skill.test.ts`. Keep the preset table (`SKILL_TARGETS`) small.

### `src/commands/master-key.ts`
`mt vault master-key generate [--user] [--path <file>] [--force] [--rekey]` / `status` / `show-path`, and `ensureProjectMasterKey()` used by `mt init`. Generate writes via core `writeMasterKeyFile` (0600, atomic); refuses to overwrite a key file without `--force`, refuses when an embed store exists unless `--rekey` (re-wraps via `rekeyEmbedStore`, key file rolled back on failure; refused when the password comes from `MT_EMBED_PASSWORD(_FILE)`) or `--force`. The key is never printed or taken as an argument. `mt init` creates `.mt/master.key` (skip: `--no-master-key`; auto-skip when a key is configured or an embed store exists), gitignored via `.mt/master.key` and `*.key`.

### `src/utils/gitignore.ts`
`ensureIgnorePatterns()` — appends the missing ignore lines (`.mt/`, `vault.json`, `*.vault.json`,
`.mt/vault*`, `*.kdbx`, `*.embed.json`, `.mt/master.key`, `*.key`) to `.gitignore`; idempotent, never duplicates a line.

### `src/utils/args.ts`
`parseInitArgs()` — parses `mt init` flags (`--settings <json>`/`-s`, `--force`); unknown flags fail with usage. `--force` overwrites an existing `mt.json`/`pipelines/example.ts` (without it `initCommand` refuses, exit 1).

## Adding a New Command

1. Create `packages/cli/src/commands/<name>.ts` exporting an async function
2. Wire into the dispatch in `packages/cli/src/index.ts`
3. Add to help text in `index.ts`
4. Write tests in `packages/cli/tests/commands/<name>.test.ts`

## Tests

```
packages/cli/tests/
├── index.test.ts              # Top-level dispatch
├── index.arch.test.ts         # Arch: all commands registered
├── commands/
│   ├── run.test.ts            # run command (mock Runner) + start/end lifecycle hooks
│   ├── install.test.ts        # install command (mock Runner): missing/absent script, named export
│   ├── resume.test.ts         # resume command
│   ├── init.test.ts           # init scaffolding
│   ├── list.test.ts           # ls runs output format
│   ├── inspect.test.ts        # inspect checkpoint tree
│   ├── skill.test.ts          # skill output/install/out/usage + drift guard vs docs/SKILL.md
│   ├── tool.test.ts           # tool stdin/stdout pipe
│   ├── vault.test.ts          # vault command (init/add/list/show/rm/path)
│   ├── router.arch.test.ts    # Arch: router command wiring + lazy @mt/router/standalone import
│   └── serve.arch.test.ts     # serve command shape
└── utils/
    ├── logger.test.ts         # DuplexLogger behaviour
    └── args.test.ts           # arg parsing
```

## Dependency Rule

`@mt/cli` imports from `@mt/core` only. `@mt/backend/standalone` (`mt serve`) and
`@mt/router/standalone` (`mt router`) are reached through lazy `await import()` — never statically;
`--detach` additionally re-executes the `mt` binary as a child process.
