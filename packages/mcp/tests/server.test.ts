import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMessage, startMcpServer } from '../src/server.js'

describe('handleMessage', () => {
  it('returns undefined for notifications (no id)', async () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(await handleMessage(line)).toBeUndefined()
  })

  it('returns undefined for other notifications without id', async () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    })
    expect(await handleMessage(line)).toBeUndefined()
  })

  it('replies to ping with an empty result', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })
    expect(await handleMessage(line)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('returns -32600 for valid JSON with wrong shape', async () => {
    const line = JSON.stringify({ jsonrpc: '1.0', method: 'ping', id: 1 })
    const response = await handleMessage(line)
    expect(response?.error?.code).toBe(-32600)
    expect(response?.id).toBeNull()
  })

  it('returns -32600 for JSON missing method', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1 })
    const response = await handleMessage(line)
    expect(response?.error?.code).toBe(-32600)
  })

  it('returns -32700 for unparsable JSON', async () => {
    const response = await handleMessage('this is not json')
    expect(response?.error?.code).toBe(-32700)
    expect(response?.id).toBeNull()
  })

  it('returns -32601 for unknown method with id', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'foo/bar' })
    const response = await handleMessage(line)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32601, message: 'Method not found' },
    })
  })
})

describe('resources/list error handling', () => {
  let projectRoot: string
  let output: string
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-mcp-server-'))
    vi.stubEnv('MT_PROJECT_ROOT', projectRoot)
    output = ''
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk)
      return true
    })
  })

  afterEach(async () => {
    writeSpy.mockRestore()
    vi.unstubAllEnvs()
    await rm(projectRoot, { recursive: true, force: true })
  })

  it('returns a JSON-RPC error instead of crashing on malformed mt.json', async () => {
    await writeFile(join(projectRoot, 'mt.json'), '{ bad }')

    const input = new PassThrough()
    const server = startMcpServer(input)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' })}\n`)
    input.end()
    await server

    const lines = output.trim().split('\n')
    const response = JSON.parse(lines.at(-1) ?? '{}')
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: expect.stringMatching(/Invalid mt\.json/) },
    })
  })
})
