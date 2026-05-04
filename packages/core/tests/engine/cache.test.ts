import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Cache } from '../../src/engine/cache.js'

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
    await cache.set(
      key,
      { toolName: 'fixTypos', version: '1.0.0', input: { text: 'hello world' } },
      { result: 'hello world' },
    )

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

    await cache.set(
      key,
      { toolName: 'fixTypos', version: '1.0.0', input: { text: 'hello' } },
      { result: 'ok' },
    )

    const existsAfter = await cache.has(key)
    expect(existsAfter).toBe(true)
  })

  it('deletes a cache entry', async () => {
    const key = cache.computeKey({
      toolName: 'fixTypos',
      version: '1.0.0',
      input: { text: 'hello' },
    })
    await cache.set(
      key,
      { toolName: 'fixTypos', version: '1.0.0', input: { text: 'hello' } },
      { result: 'ok' },
    )

    await cache.delete(key)

    const result = await cache.get(key)
    expect(result).toBeUndefined()
  })

  it('clears all cache entries', async () => {
    const key1 = cache.computeKey({ toolName: 't1', version: '1.0.0', input: { a: 1 } })
    const key2 = cache.computeKey({ toolName: 't2', version: '1.0.0', input: { b: 2 } })

    await cache.set(key1, { toolName: 't1', version: '1.0.0', input: { a: 1 } }, 'value1')
    await cache.set(key2, { toolName: 't2', version: '1.0.0', input: { b: 2 } }, 'value2')

    expect(await cache.has(key1)).toBe(true)
    expect(await cache.has(key2)).toBe(true)

    await cache.clear()

    expect(await cache.has(key1)).toBe(false)
    expect(await cache.has(key2)).toBe(false)

    // Cache dir still exists after clear
    await cache.set(key1, { toolName: 't1', version: '1.0.0', input: { a: 1 } }, 'value1')
    expect(await cache.get(key1)).toEqual('value1')
  })
})
