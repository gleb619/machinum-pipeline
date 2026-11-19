import { registry } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { createEmitTarget } from '../../src/emit.js'

// Register on import
import '../../src/emit.js'

describe('emit (architectural)', () => {
  it('createEmitTarget is exported as a function', () => {
    expect(typeof createEmitTarget).toBe('function')
  })

  it('createEmitTarget returns an object satisfying Target interface', () => {
    const target = createEmitTarget({
      scheme: 'emit',
      raw: 'emit://channel',
      host: 'channel',
      path: '',
      query: {},
      fragment: '',
    })
    expect(target).toHaveProperty('uri')
    expect(target.uri).toBe('emit://channel')
    expect(typeof target.open).toBe('function')
    expect(typeof target.write).toBe('function')
    expect(typeof target.close).toBe('function')
    expect(typeof target.checkpoint).toBe('function')
  })

  it('emit scheme is registered for target resolution', () => {
    const target = registry.resolveTarget('emit://channel')
    expect(target).toHaveProperty('uri')
    expect(typeof target.open).toBe('function')
    expect(typeof target.close).toBe('function')
  })

  it('emit scheme is NOT registered as a source', () => {
    expect(() => registry.resolveSource('emit://channel')).toThrow()
  })
})
