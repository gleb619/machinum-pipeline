# @mt/mcp
← [Architecture](../architecture.md)

Path: `packages/mcp/`

MCP (Model Context Protocol) server over **stdio only** — no HTTP. Wraps `@mt/core` and `@mt/cli` functionality, exposing pipeline and run operations to MCP clients (e.g. Claude Desktop, VS Code Copilot, Cursor).

## Transport

Pure stdio JSON-RPC. No HTTP, no WebSocket. Launched as a subprocess by the MCP host:

```bash
mt mcp           # via CLI
# or directly:
node packages/mcp/.output/server.js
```

## Exposed MCP Methods

Implemented in `src/handlers.ts`:

| Method | Description |
|---|---|
| `initialize` | MCP handshake; returns server capabilities |
| `tools/list` | Lists all available tools |
| `tools/call` | Invokes a named tool with arguments |
| `resources/list` | Lists readable resources (pipelines, runs) |
| `resources/read` | Reads a specific resource by URI |

### Tool Surface (via `tools/call`)

| Tool name | Arguments | Description | Status |
|---|---|---|---|
| `pipelines.list` | — | List discovered pipeline files | Done |
| `pipelines.run` | `{ file, args? }` | Start a pipeline run | Done |
| `runs.list` | — | List all runs with status | Done |
| `runs.inspect` | `{ runId }` | Full checkpoint tree + metadata | Done |
| `runs.pause` | `{ runId }` | Pause a running pipeline | Deferred |
| `runs.resume` | `{ runId }` | Resume a paused run | Deferred |
| `tools.invoke` | `{ toolName, envelope }` | Invoke a processing tool directly | Deferred |
| `book.read` | `{ path }` | Read book chapter index | Deferred |
| `chapter.read` | `{ path }` | Read a single chapter | Deferred |

The implemented tools live in a single `TOOLS` registry in `src/handlers.ts`: `tools/list`
returns its descriptors, `tools/call` dispatches through it. Unknown tool names and invalid
arguments answer with `{ content: [{ type: 'text', text: '…' }], isError: true }` — a failed
call is never a JSON-RPC error.

Tool semantics:

- `pipelines.list` — reads `mt.json` through `discoverPipelines()`; every entry carries `file`
  (path relative to the project root), `declared` (the raw `mt.json` entry) and `path` (absolute).
- `pipelines.run` — `file` is resolved inside the project root: absolute paths and `..` segments
  are rejected. The module is loaded with `importPipelineModule()`, the run is started with the
  core `Runner` in the background, and the response returns `{ runId }` as soon as the Runner
  minted it — the caller never waits for the pipeline to finish. `args` is optional and is handed
  to a pipeline module whose default export is a factory function; a module exporting a ready
  pipeline ignores it.
- `runs.list` — reads `.mt/runs/*/state.json` through `Store`; each entry carries `runId`,
  `status`, `startedAt`, `updatedAt` and `pipelineId`.
- `runs.inspect` — returns the run's `state.json` as stored: the full checkpoint tree plus the
  run metadata. `runId` must be a single directory name (no path separators, no `..`).

The project root of the server is `MT_PROJECT_ROOT`, falling back to the current working
directory.

## Key Files

```
packages/mcp/src/
├── server.ts      # startMcpServer(): reads stdin, dispatches to handlers, writes stdout
│                  # handleRequest(): JSON-RPC message router
│                  # writeResponse(): serialises JSON-RPC response to stdout
└── handlers.ts    # handleInitialize, handleToolsList, handleToolsCall,
                   # handleResourcesList, handleResourcesRead
```

### `server.ts`

```typescript
// Reads line-delimited JSON from stdin
// Dispatches to handler by method name
// Writes JSON response to stdout
// No network I/O
```

### `handlers.ts`

Each handler receives the parsed JSON-RPC params and returns a JSON-serialisable result. Handlers call `@mt/core` APIs directly — they do not shell out to `mt` CLI.

## Tests

```
packages/mcp/tests/
├── server.arch.test.ts    # Arch: server exports, stdio wiring
├── methods.arch.test.ts   # Arch: all MCP methods implemented
├── layers.arch.test.ts    # Arch: @mt/mcp imports only @mt/core
└── tools.test.ts          # Behaviour: tool surface, dispatch, run state
```

## Dependency Rule

`@mt/mcp` imports from `@mt/core` (and optionally `@mt/cli` for pipeline loading utilities). It does not import from `@mt/backend`, `@mt/router`, or `@mt/waypoint` directly.
