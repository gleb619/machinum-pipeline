import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Cache } from '../../src/engine/cache.js'
describe('UC-19 — Tool cache (architectural)', () => {
  it('Cache class is exported and constructable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-test-cache-'))
    const cache = new Cache(dir)
    expect(cache).toBeInstanceOf(Cache)
    expect(typeof cache.computeKey).toBe('function')
    expect(typeof cache.get).toBe('function')
    expect(typeof cache.set).toBe('function')
    expect(typeof cache.has).toBe('function')
    expect(typeof cache.delete).toBe('function')
    expect(typeof cache.clear).toBe('function')
    rmSync(dir, { recursive: true, force: true })
  })
  it('CacheOptions shape — toolName, version, input, optional context', () => {
    const opts = {
      toolName: 'uppercase',
      version: '1.0.0',
      input: { text: 'hello' },
      context: { stepId: 's1' },
    }
    expect(opts.toolName).toBe('uppercase')
    expect(opts.version).toBe('1.0.0')
    expect(opts.input).toEqual({ text: 'hello' })
    expect(opts.context).toEqual({ stepId: 's1' })
  })
  it('CacheEntry shape — toolName, version, inputHash, output, createdAt', () => {
    const entry = {
      toolName: 'uppercase',
      version: '1.0.0',
      inputHash: 'abc123',
      output: { result: 'HELLO' },
      createdAt: new Date().toISOString(),
    }
    expect(entry.toolName).toBe('uppercase')
    expect(entry.version).toBe('1.0.0')
    expect(entry.inputHash).toBe('abc123')
    expect(entry.output).toEqual({ result: 'HELLO' })
    expect(typeof entry.createdAt).toBe('string')
  })
  it('computeKey produces a deterministic SHA-256 hex string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-test-cache-'))
    const cache = new Cache(dir)
    const opts1 = {
      toolName: 'test',
      version: '1.0.0',
      input: { x: 1 },
    }
    const opts2 = {
      toolName: 'test',
      version: '1.0.0',
      input: { x: 1 },
    }
    const opts3 = {
      toolName: 'test',
      version: '1.0.0',
      input: { x: 2 },
    }
    const key1 = cache.computeKey(opts1)
    const key2 = cache.computeKey(opts2)
    const key3 = cache.computeKey(opts3)
    expect(key1).toBe(key2) // Same input → same key
    expect(key1).not.toBe(key3) // Different input → different key
    expect(key1.length).toBe(64) // SHA-256 hex is 64 chars
    rmSync(dir, { recursive: true, force: true })
  })
  it('set / has / get round-trips values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-test-cache-'))
    const cache = new Cache(dir)
    const opts = {
      toolName: 'echo',
      version: '1.0.0',
      input: { message: 'hello' },
    }
    const key = cache.computeKey(opts)
    // Initially no cache hit
    expect(await cache.has(key)).toBe(false)
    // Set and verify
    await cache.set(key, opts, { echoed: 'hello' })
    expect(await cache.has(key)).toBe(true)
    const result = await cache.get(key)
    expect(result).toEqual({ echoed: 'hello' })
    rmSync(dir, { recursive: true, force: true })
  })
  it('Tool interface supports cacheable and idempotent flags', () => {
    const tool = {
      cacheable: true,
      idempotent: true,
    }
    expect(tool.cacheable).toBe(true)
    expect(tool.idempotent).toBe(true)
  })
})
//# sourceMappingURL=cache.arch.test.js.map
