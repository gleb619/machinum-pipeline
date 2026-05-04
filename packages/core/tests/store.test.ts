import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/store.js'

describe('Store', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mt-store-test-'))

  it('creates a store with a root path', () => {
    const store = new Store(tmpDir)
    expect(store.getRoot()).toBe(tmpDir)
  })

  it('resolves paths correctly', () => {
    const store = new Store(tmpDir)
    expect(store.resolve('runs', 'test')).toBe(join(tmpDir, 'runs', 'test'))
  })

  it('writes and reads a file', async () => {
    const store = new Store(tmpDir)
    const path = await store.write('hello world', 'test-file.txt')
    expect(path).toContain('test-file.txt')
    const content = await store.read('test-file.txt')
    expect(content).toBe('hello world')
  })

  it('writes and reads JSON', async () => {
    const store = new Store(tmpDir)
    const data = { foo: 'bar', num: 42 }
    await store.writeJson(data, 'test.json')
    const read = await store.readJson<typeof data>('test.json')
    expect(read.foo).toBe('bar')
    expect(read.num).toBe(42)
  })

  it('ensures directory exists', async () => {
    const store = new Store(tmpDir)
    const dir = await store.ensureDir('nested', 'deeply', 'dir')
    expect(existsSync(dir)).toBe(true)
  })

  it('check existence', async () => {
    const store = new Store(tmpDir)
    await store.write('content', 'exists-test.txt')
    expect(await store.exists('exists-test.txt')).toBe(true)
    expect(await store.exists('does-not-exist.txt')).toBe(false)
  })

  it('appends to a file', async () => {
    const store = new Store(tmpDir)
    await store.write('line1\n', 'append-test.txt')
    await store.append('line2\n', 'append-test.txt')
    const content = await store.read('append-test.txt')
    expect(content).toBe('line1\nline2\n')
  })

  it('removes a file', async () => {
    const store = new Store(tmpDir)
    await store.write('to-delete', 'delete-me.txt')
    expect(await store.exists('delete-me.txt')).toBe(true)
    await store.remove('delete-me.txt')
    expect(await store.exists('delete-me.txt')).toBe(false)
  })

  it('atomic write does not leave temp files', async () => {
    const store = new Store(tmpDir)
    await store.write('atomic', 'atomic-test.txt')
    // Temp files should have been renamed
    const dirContent = await import('node:fs/promises').then((m) => m.readdir(tmpDir))
    const tmpFilesLeft = dirContent.filter((f: string) => f.includes('.tmp.'))
    expect(tmpFilesLeft.length).toBe(0)
  })
})
