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

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const { id, method, params } = request

  try {
    switch (method) {
      case 'initialize':
        writeResponse({
          jsonrpc: '2.0',
          id,
          result: handleInitialize(),
        })
        break

      case 'tools/list':
        writeResponse({
          jsonrpc: '2.0',
          id,
          result: handleToolsList(),
        })
        break

      case 'tools/call':
        writeResponse({
          jsonrpc: '2.0',
          id,
          result: await handleToolsCall(
            params as { name: string; arguments: Record<string, unknown> },
          ),
        })
        break

      case 'resources/list':
        writeResponse({
          jsonrpc: '2.0',
          id,
          result: await handleResourcesList(projectRoot),
        })
        break

      case 'resources/read':
        writeResponse({
          jsonrpc: '2.0',
          id,
          result: await handleResourcesRead(params as { uri: string }),
        })
        break

      default:
        writeResponse({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'Method not found',
          },
        })
    }
  } catch (error) {
    writeResponse({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    })
  }
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

    let request: JsonRpcRequest
    try {
      request = JSON.parse(line) as JsonRpcRequest
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        writeResponse({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error',
          },
        })
        continue
      }
    } catch {
      writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      })
      continue
    }

    await handleRequest(request)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((error) => {
    console.error('Server error:', error)
    process.exit(1)
  })
}
