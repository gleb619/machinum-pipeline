import { createExchange, setVariable } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { exchangeField } from '../../src/fields.js'

describe('exchangeField', () => {
  it('prefers the variable over legacy meta', () => {
    const ex = setVariable(createExchange('a', { meta: { summary: 'old' } }), 'summary', 'new')
    expect(exchangeField<string>(ex, 'summary')).toBe('new')
  })

  it('falls back to meta, then undefined', () => {
    const ex = createExchange('a', { meta: { summary: 'legacy' } })
    expect(exchangeField<string>(ex, 'summary')).toBe('legacy')
    expect(exchangeField<string>(ex, 'missing')).toBeUndefined()
  })
})
