# @mt/cli
← [Architecture](../architecture.md)

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
| `mt init` | `init.ts` | Scaffold `.mt/`, `mt.json` in a consumer project |
| `mt run <pipeline.ts>` | `run.ts` | Execute a pipeline; build GlobalContext, load module, start Runner |
| `mt resume <runId>` | `resume.ts` | Load checkpoint.json, resume from first non-done node |
| `mt ls runs` | `list.ts` | List all runs with state/timing summary |
| `mt inspect <runId>` | `inspect.ts` | Show checkpoint tree, events, run metadata |
| `mt tool <name>` | `tool.ts` | Invoke a tool standalone (JSON envelope on stdin/stdout) |
| `mt serve [--port N\|0] [--host H] [--detach]` | `serve.ts` | Start admin API + UI (`@mt/backend/standalone`); `--detach` re-execs self in background (`.mt/backend/{pid,server.log}`); port 0 = random free port |

## Pipeline Loading

Both `run.ts` and `resume.ts` use `@mt/core`'s `loadGlobalContext()` plus a local `loadPipeline()`:

```typescript
const ctx = await loadGlobalContext(projectRoot) // mt.json + secrets.envFile — same loader as the backend
const pipeline = await loadPipeline(pipelineFilePath, pipelineName)
// pipeline is a Pipeline instance (result of definePipeline().…)
```

`loadPipeline()` uses `tsx`/`jiti` dynamic import — the consumer file is **not** compiled ahead of time. Plain `import`, `console.log`, and conditionals all work inside pipeline files.

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
2. `loadPipeline(file, name?)` → `Pipeline`
3. `new Runner(pipeline, ctx)` → `runner.start()`
4. Listen for SIGINT → `runner.pause()`

### `src/commands/resume.ts`
Same as `run.ts` but calls `runner.resume(runId)` instead of `runner.start()`.

### `src/commands/serve.ts`
- `serveCommand()` lazy-imports `@mt/backend/standalone` and calls `startBackend()` (plain h3 on `node:http`; no Nitro
  at runtime). SIGINT/SIGTERM close the server. UI dir: `$MT_UI_DIR` > `<pkg>/dist/ui` > `packages/frontend/dist`;
  in the Bun binary the UI is embedded (`globalThis.__MT_UI__`).
- `detachServe()` re-spawns `process.execPath` (the binary itself when compiled) in the foreground mode, detached
- `parseArgs()` handles `--port`, `--host`, `--detach`

### `src/utils/logger.ts` — `DuplexLogger`
Writes to both console (with ANSI colour) and a log file under `.mt/runs/<runId>/`. Implements `Logger` from `@mt/core/types`.

### `src/utils/args.ts`
`parseInitArgs()` — parses `mt init` flags (`--force`, `--yes`, `--template`).

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
│   ├── run.test.ts            # run command (mock Runner)
│   ├── resume.test.ts         # resume command
│   ├── init.test.ts           # init scaffolding
│   ├── list.test.ts           # ls runs output format
│   ├── inspect.test.ts        # inspect checkpoint tree
│   ├── tool.test.ts           # tool stdin/stdout pipe
│   └── serve.arch.test.ts     # serve command shape
└── utils/
    ├── logger.test.ts         # DuplexLogger behaviour
    └── args.test.ts           # arg parsing
```

## Dependency Rule

`@mt/cli` imports from `@mt/core` only. It may dynamically spawn `@mt/backend` or `@mt/router` as child processes but does not statically import them.
