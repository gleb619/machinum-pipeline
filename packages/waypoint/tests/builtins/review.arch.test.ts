import { registry } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { createReviewTarget } from '../../src/review.js'

// Register on import
import '../../src/review.js'

describe('review (architectural)', () => {
  it('createReviewTarget is exported as a function', () => {
    expect(typeof createReviewTarget).toBe('function')
  })

  it('createReviewTarget returns an object satisfying Target interface', () => {
    const tgt = createReviewTarget({
      scheme: 'review',
      raw: 'review://./out.md',
      host: '',
      path: './out.md',
      query: {},
    })
    expect(tgt).toHaveProperty('uri')
    expect(tgt.uri).toBe('review://./out.md')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.write).toBe('function')
    expect(typeof tgt.close).toBe('function')
    expect(tgt.checkpoint).toBeUndefined()
  })

  it('review scheme is registered for target resolution', () => {
    const tgt = registry.resolveTarget('review://./out.md')
    expect(tgt).toHaveProperty('uri')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.close).toBe('function')
  })

  it('review scheme is NOT registered as a source', () => {
    expect(() => registry.resolveSource('review://./out.md')).toThrow()
  })
})
