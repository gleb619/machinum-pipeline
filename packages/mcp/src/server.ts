import * as readline from 'node:readline'
import {
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

export async function startMcpServer(): Promise<void> {
  projectRoot = process.env.MT_PROJECT_ROOT || process.cwd()

  const rl = readline.createInterface({
    input: process.stdin,
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((error) => {
    console.error('Server error:', error)
    process.exit(1)
  })
}
