import { registry } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { createConsoleTarget } from '../../src/console.js'

// Register on import
import '../../src/console.js'

describe('console (architectural)', () => {
  it('createConsoleTarget is exported as a function', () => {
    expect(typeof createConsoleTarget).toBe('function')
  })

  it('createConsoleTarget returns an object satisfying Target interface', () => {
    const tgt = createConsoleTarget({
      scheme: 'console',
      raw: 'console://',
      host: '',
      path: '',
      query: {},
      fragment: '',
    })
    expect(tgt).toHaveProperty('uri')
    expect(tgt.uri).toBe('console://')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.write).toBe('function')
    expect(typeof tgt.close).toBe('function')
    expect(tgt.checkpoint).toBeUndefined()
  })

  it('console scheme is registered for target resolution', () => {
    const tgt = registry.resolveTarget('console://')
    expect(tgt).toHaveProperty('uri')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.close).toBe('function')
  })

  it('console scheme is NOT registered as a source', () => {
    expect(() => registry.resolveSource('console://')).toThrow()
  })
})
