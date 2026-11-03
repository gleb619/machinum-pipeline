import * as readline from 'node:readline'
import {
  activeRuns,
  handleInitialize,
  handleResourcesList,
  handleResourcesRead,
  handleToolsCall,
  handleToolsList,
} from './handlers.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

let projectRoot: string

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = request

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: handleInitialize(),
        }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: handleToolsList(),
        }

      case 'tools/call':
        return {
          jsonrpc: '2.0',
          id,
          result: await handleToolsCall(
            params as { name: string; arguments: Record<string, unknown> },
            projectRoot,
          ),
        }

      case 'resources/list':
        return {
          jsonrpc: '2.0',
          id,
          result: await handleResourcesList(projectRoot),
        }

      case 'resources/read':
        return {
          jsonrpc: '2.0',
          id,
          result: await handleResourcesRead(params as { uri: string }),
        }

      case 'ping':
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'Method not found',
          },
        }
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    }
  }
}

/**
 * Handle one raw line of stdio input. Returns the JSON-RPC response to write,
 * or `undefined` for notifications (requests without an `id` must not get a reply).
 */
export async function handleMessage(line: string): Promise<JsonRpcResponse | undefined> {
  let request: JsonRpcRequest
  try {
    request = JSON.parse(line) as JsonRpcRequest
  } catch {
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    }
  }

  if (
    typeof request !== 'object' ||
    request === null ||
    request.jsonrpc !== '2.0' ||
    typeof request.method !== 'string'
  ) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Invalid Request',
      },
    }
  }

  if (request.id === undefined) {
    return undefined
  }

  return handleRequest(request)
}

/**
 * Wait for the tracked background runs to settle.
 *
 * Called after stdin closed (the client disconnected). A run started by
 * `pipelines.run` may still be in flight; exiting now would kill it mid-step
 * and leave `state.json` stuck at `running` with no process behind it. So the
 * server stays alive until every tracked run settles.
 *
 * Escape hatch: `SIGINT` (or `SIGHUP` from a closing terminal) during the drain
 * force-exits with code 1 — the operator asked for it, so the drain is abandoned
 * and the in-flight run is left orphaned on purpose. A second stdin EOF cannot
 * be observed: stdin is already ended by the time the drain starts.
 */
export async function drainActiveRuns(): Promise<void> {
  if (activeRuns.size === 0) return

  console.error(`[mcp] stdin closed, waiting for ${activeRuns.size} background run(s) to finish`)
  const forceExit = (): void => {
    console.error('[mcp] interrupted while draining background run(s), exiting now')
    process.exit(1)
  }
  process.on('SIGINT', forceExit)
  process.on('SIGHUP', forceExit)
  try {
    // Runs may start while the drain is running — keep going until none are left.
    while (activeRuns.size > 0) {
      await Promise.allSettled([...activeRuns])
    }
  } finally {
    process.off('SIGINT', forceExit)
    process.off('SIGHUP', forceExit)
  }
  console.error('[mcp] background run(s) finished')
}

/**
 * Serve MCP over stdio until stdin closes.
 *
 * `input` defaults to `process.stdin`; tests pass their own stream to simulate
 * a client that disconnects.
 */
export async function startMcpServer(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  projectRoot = process.env.MT_PROJECT_ROOT || process.cwd()

  const rl = readline.createInterface({
    input,
    output: process.stdout,
    terminal: false,
  })

  for await (const line of rl) {
    if (line.trim() === '') {
      continue
    }

    const response = await handleMessage(line)
    if (response !== undefined) {
      writeResponse(response)
    }
  }

  // The client is gone, but a background run may still be in flight: drain it
  // before the process exits, or the run dies mid-step.
  await drainActiveRuns()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((error) => {
    console.error('Server error:', error)
    process.exit(1)
  })
}
