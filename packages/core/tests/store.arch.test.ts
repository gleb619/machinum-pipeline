import { describe, expect, it } from 'vitest'
import { Store } from '../src/store.js'

describe('UC-52 - Store persistence (architectural)', () => {
  it('Store class is exported', () => {
    expect(typeof Store).toBe('function')
  })
  it('constructor accepts root path', () => {
    const store = new Store('/tmp/test-store')
    expect(store.getRoot()).toBe('/tmp/test-store')
  })
  it('resolve joins root with parts', () => {
    const store = new Store('/tmp/test-store')
    const resolved = store.resolve('runs', 'r1', 'artifacts', 'file.txt')
    expect(resolved).toBe('/tmp/test-store/runs/r1/artifacts/file.txt')
  })
  it('write method exists and has atomic signature', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.write).toBe('function')
    // write(content: string, ...parts: string[]): Promise<string>
    expect(store.write.length).toBeGreaterThanOrEqual(1)
  })
  it('writeJson method exists', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.writeJson).toBe('function')
  })
  it('append method exists', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.append).toBe('function')
  })
  it('appendLines method exists', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.appendLines).toBe('function')
  })
  it('read method exists', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.read).toBe('function')
  })
  it('readJson method exists', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.readJson).toBe('function')
  })
  it('exists method exists', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.exists).toBe('function')
  })
  it('ensureDir method exists', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.ensureDir).toBe('function')
  })
  it('remove method exists', () => {
    const store = new Store('/tmp/test-store')
    expect(typeof store.remove).toBe('function')
  })
  it('Store has 1 constructor parameter', () => {
    expect(Store.length).toBe(1)
  })
})
