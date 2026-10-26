import { describe, expect, it } from 'vitest'
import { handleMessage } from '../src/server.js'

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
