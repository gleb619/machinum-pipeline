# @mt/cli
← [Architecture](../architecture.md)

Path: `packages/cli/`

The `mt` binary. Loads pipelines at runtime via `tsx`/`jiti` — no consumer build step required. Imports only from `@mt/core`.

## Distribution

- **npm**: `mt` package (`packages/mt`) ships the CLI as bin `mt` (Node >= 20; `.ts` pipelines need
  `NODE_OPTIONS='--import tsx'` or Node >= 22.18 type stripping).
- **Single-file binary** (Bun, no node/pnpm/node_modules): `pnpm build:bin` -> `packages/mt/dist/bin/mt`.
  Pipelines are imported at runtime by Bun (TS works natively). Bare `mt`, `mt/tools`, `mt/waypoint`
  (and legacy `@mt/core|tools|waypoint`) resolve to the copies embedded in the binary via a Bun runtime
  plugin (`packages/mt/src/embed.ts`), so the pipeline shares the Runner's module instances. Other bare
  imports from a pipeline (third-party npm packages) are NOT available unless a `node_modules` exists next
  to the pipeline. `mt serve` is excluded from the binary (prints a message, exit 1).
  Cross targets: `bun scripts/build-bin.ts --target bun-linux-arm64|bun-darwin-arm64|bun-windows-x64`.

## Commands

| Command | File | Description |
|---|---|---|
| `mt init` | `init.ts` | Scaffold `.mt/`, `mt.json` in a consumer project |
| `mt run <pipeline.ts>` | `run.ts` | Execute a pipeline; build GlobalContext, load module, start Runner |
| `mt resume <runId>` | `resume.ts` | Load checkpoint.json, resume from first non-done node |
| `mt ls runs` | `list.ts` | List all runs with state/timing summary |
| `mt inspect <runId>` | `inspect.ts` | Show checkpoint tree, events, run metadata |
| `mt tool <name>` | `tool.ts` | Invoke a tool standalone (JSON envelope on stdin/stdout) |
| `mt serve [--detach]` | `serve.ts` | Start admin backend; `--detach` forks as background process |

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
- `serveCommand()` starts the `@mt/backend` Nuxt app in-process
- `detachServe()` forks a child process with `--detach` flag
- `parseArgs()` handles `--port`, `--detach`, `--no-open`

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
