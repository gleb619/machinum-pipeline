import { describe, it, expect, beforeEach } from 'vitest'
import { Cache } from '../../src/engine/cache.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Cache', () => {
  let cache: Cache
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mt-cache-test-'))
    cache = new Cache(tempDir)
  })

  it('computes consistent keys for same inputs', () => {
    const key1 = cache.computeKey({
      toolName: 'fixTypos',
      version: '1.0.0',
      input: { text: 'hello world' },
    })
    const key2 = cache.computeKey({
      toolName: 'fixTypos',
      version: '1.0.0',
      input: { text: 'hello world' },
    })
    expect(key1).toBe(key2)
  })

  it('computes different keys for different inputs', () => {
    const key1 = cache.computeKey({
      toolName: 'fixTypos',
      version: '1.0.0',
      input: { text: 'hello world' },
    })
    const key2 = cache.computeKey({
      toolName: 'fixTypos',
      version: '1.0.0',
      input: { text: 'different text' },
    })
    expect(key1).not.toBe(key2)
  })

  it('returns undefined for cache miss', async () => {
    const result = await cache.get('nonexistent-key')
    expect(result).toBeUndefined()
  })

  it('stores and retrieves a value', async () => {
    const key = cache.computeKey({
      toolName: 'fixTypos',
      version: '1.0.0',
      input: { text: 'hello world' },
    })
    await cache.set(key, { toolName: 'fixTypos', version: '1.0.0', input: { text: 'hello world' } }, { result: 'hello world' })

    const result = await cache.get(key)
    expect(result).toEqual({ result: 'hello world' })
  })

  it('checks existence correctly', async () => {
    const key = cache.computeKey({
      toolName: 'fixTypos',
      version: '1.0.0',
      input: { text: 'hello' },
    })

    const existsBefore = await cache.has(key)
    expect(existsBefore).toBe(false)

    await cache.set(key, { toolName: 'fixTypos', version: '1.0.0', input: { text: 'hello' } }, { result: 'ok' })

    const existsAfter = await cache.has(key)
    expect(existsAfter).toBe(true)
  })

  it('deletes a cache entry', async () => {
    const key = cache.computeKey({
      toolName: 'fixTypos',
      version: '1.0.0',
      input: { text: 'hello' },
    })
    await cache.set(key, { toolName: 'fixTypos', version: '1.0.0', input: { text: 'hello' } }, { result: 'ok' })

    await cache.delete(key)

    const result = await cache.get(key)
    expect(result).toBeUndefined()
  })
})