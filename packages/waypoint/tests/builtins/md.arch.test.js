import { describe, expect, it } from 'vitest'
import { createMdSource, createMdTarget } from '../../src/builtins/md.js'
import { registry } from '../../src/uri.js'
// Register on import
import '../../src/builtins/md.js'
describe('UC-26 — Markdown Source (architectural)', () => {
  it('createMdSource is exported as a function', () => {
    expect(typeof createMdSource).toBe('function')
  })
  it('createMdSource returns an object satisfying Source interface', () => {
    const src = createMdSource({
      scheme: 'md',
      raw: 'md://./test.md',
      path: './test.md',
      host: '',
      fragment: '',
      query: {},
    })
    expect(src).toHaveProperty('uri')
    expect(src).toHaveProperty('lifestyle')
    expect(src.lifestyle).toBe('resumable')
    expect(typeof src.start).toBe('function')
    expect(typeof src.resume).toBe('function')
  })
  it('md scheme is registered for source resolution', () => {
    const src = registry.resolveSource('md://./data.md')
    expect(src).toHaveProperty('uri')
    expect(src.uri).toBe('md://./data.md')
    expect(src.lifestyle).toBe('resumable')
  })
})
describe('UC-26 — Markdown Target (architectural)', () => {
  it('createMdTarget is exported as a function', () => {
    expect(typeof createMdTarget).toBe('function')
  })
  it('createMdTarget returns an object satisfying Target interface', () => {
    const tgt = createMdTarget({
      scheme: 'md',
      raw: 'md://./out.md',
      path: './out.md',
      host: '',
      fragment: '',
      query: {},
    })
    expect(tgt).toHaveProperty('uri')
    expect(tgt.uri).toBe('md://./out.md')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.write).toBe('function')
    expect(typeof tgt.close).toBe('function')
  })
  it('md scheme is registered for target resolution', () => {
    const tgt = registry.resolveTarget('md://./out.md')
    expect(tgt).toHaveProperty('uri')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.close).toBe('function')
  })
})
//# sourceMappingURL=md.arch.test.js.map
