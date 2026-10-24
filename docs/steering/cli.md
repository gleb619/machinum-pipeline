# @mt/cli
← [Architecture](../architecture.md)

Path: `packages/cli/`

The `mt` binary. Loads pipelines at runtime via `tsx`/`jiti` — no consumer build step required. Imports only from `@mt/core`.

## Distribution

- **npm**: `mt` package (`packages/mt`) ships the CLI as bin `mt` (Node >= 20; `.ts` pipelines need
  `NODE_OPTIONS='--import tsx'` or Node >= 22.18 type stripping).
- **Single-file binary** (Bun, no node/pnpm/node_modules): `pnpm build:bin` -> `packages/mt/dist/bin/mt`
  (~98 MB on linux-x64). Includes `mt serve` (h3 API + `bun:sqlite` + embedded admin UI).
  Pipelines are imported at runtime by Bun (TS works natively). Import matrix inside the binary:

  | Import in a pipeline | Works | How |
  |---|---|---|
  | `mt`, `mt/tools`, `mt/waypoint` (+ legacy `@mt/core\|tools\|waypoint`) | yes | Bun runtime plugin `packages/mt/src/embed.ts`; same module instances as the Runner |
  | `node:*` builtins | yes | Bun |
  | relative `./x`, `../lib/helper` (.ts/.js, extension optional) | yes | Bun resolver |
  | package in `node_modules` found by walking up from the pipeline file | yes | Bun resolver (no install step, no network) |
  | `zod` | yes | embedded fallback, used only if cwd has no own `zod` in `node_modules` |
  | any other npm package | only if present in a `node_modules` next to/above the pipeline | not embedded; add it to the project |
  | native addons (`.node`) from the project's `node_modules` | best effort, untested | |

  Cross targets: `bun scripts/build-bin.ts --target <t>` -> `dist/bin/mt-<os>-<arch>[-musl][.exe]`
  (`bun-linux-x64|arm64[-musl]`, `bun-darwin-x64|arm64`, `bun-windows-x64`). Building a foreign target
  downloads that Bun runtime once (needs network, then cached); the produced binary is offline. Only the
  host target is smoke-tested.

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

Both `run.ts` and `resume.ts` use `buildGlobalContext()` + `loadPipeline()`:

```typescript
const ctx = await buildGlobalContext(mtJsonPath)
const pipeline = await loadPipeline(pipelineFilePath, ctx)
// pipeline is a Pipeline instance (result of definePipeline().…)
```

`loadPipeline()` uses `tsx`/`jiti` dynamic import — the consumer file is **not** compiled ahead of time. Plain `import`, `console.log`, and conditionals all work inside pipeline files.

## Key Files

### `src/index.ts`
Entry point: `main()` function, arg parsing, dispatch to command modules. Handles top-level errors and process exit codes.

### `src/commands/run.ts`
1. `buildGlobalContext(mtJsonPath)` → `GlobalContext`
2. `loadPipeline(file, ctx)` → `Pipeline`
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
