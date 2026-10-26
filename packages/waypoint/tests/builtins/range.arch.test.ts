import { registry } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { createRangeSource } from '../../src/range.js'

// Register on import
import '../../src/range.js'

describe('range (architectural)', () => {
  it('createRangeSource is exported as a function', () => {
    expect(typeof createRangeSource).toBe('function')
  })

  it('createRangeSource returns an object satisfying Source interface', () => {
    const src = createRangeSource({
      scheme: 'range',
      raw: 'range://1..3',
      host: '1..3',
      path: '',
      query: {},
    })
    expect(src).toHaveProperty('uri')
    expect(src.uri).toBe('range://1..3')
    expect(src).toHaveProperty('lifestyle')
    expect(src.lifestyle).toBe('resumable')
    expect(typeof src.start).toBe('function')
    expect(typeof src.resume).toBe('function')
  })

  it('range scheme is registered for source resolution', () => {
    const src = registry.resolveSource('range://1..3')
    expect(src).toHaveProperty('uri')
    expect(src.uri).toBe('range://1..3')
    expect(src.lifestyle).toBe('resumable')
  })

  it('range scheme is NOT registered as a target', () => {
    expect(() => registry.resolveTarget('range://1..3')).toThrow()
  })
})
