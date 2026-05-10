import { describe, expect, it } from 'vitest'
import { translateText } from './translate-text.js'

describe('translateText', () => {
  it('should have correct name and version', () => {
    expect(translateText.name).toBe('translate-text')
    expect(translateText.version).toBe('1.0.0')
  })

  it('should have invoke as a function', () => {
    expect(typeof translateText.invoke).toBe('function')
  })
})
