import { registry } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { createVoidTarget } from '../../src/void.js'

// Register on import
import '../../src/void.js'

describe('void (architectural)', () => {
  it('createVoidTarget is exported as a function', () => {
    expect(typeof createVoidTarget).toBe('function')
  })

  it('createVoidTarget returns an object satisfying Target interface', () => {
    const tgt = createVoidTarget({
      scheme: 'void',
      raw: 'void://',
      host: '',
      path: '',
      query: {},
    })
    expect(tgt).toHaveProperty('uri')
    expect(tgt.uri).toBe('void://')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.write).toBe('function')
    expect(typeof tgt.close).toBe('function')
    expect(tgt.checkpoint).toBeUndefined()
  })

  it('void scheme is registered for target resolution', () => {
    const tgt = registry.resolveTarget('void://')
    expect(tgt).toHaveProperty('uri')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.close).toBe('function')
  })

  it('void scheme is NOT registered as a source', () => {
    expect(() => registry.resolveSource('void://')).toThrow()
  })
})
