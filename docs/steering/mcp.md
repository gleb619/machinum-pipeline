# @mt/mcp

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

| Tool name | Arguments | Description |
|---|---|---|
| `pipelines.list` | — | List discovered pipeline files |
| `pipelines.run` | `{ file, args? }` | Start a pipeline run |
| `runs.list` | — | List all runs with status |
| `runs.inspect` | `{ runId }` | Full checkpoint tree + metadata |
| `runs.pause` | `{ runId }` | Pause a running pipeline |
| `runs.resume` | `{ runId }` | Resume a paused run |
| `tools.invoke` | `{ toolName, envelope }` | Invoke a processing tool directly |
| `book.read` | `{ path }` | Read book chapter index |
| `chapter.read` | `{ path }` | Read a single chapter |

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
└── methods.arch.test.ts   # Arch: all MCP methods implemented
```

## Dependency Rule

`@mt/mcp` imports from `@mt/core` (and optionally `@mt/cli` for pipeline loading utilities). It does not import from `@mt/backend`, `@mt/router`, or `@mt/waypoint` directly.
