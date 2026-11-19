import { describe, expect, it } from 'vitest'
import { compactArrays } from './json-format.js'

describe('compactArrays', () => {
  it('collapses a short numeric array onto one line', () => {
    const json = JSON.stringify({ chapters: [1, 2, 3] }, null, 2)
    expect(compactArrays(json)).toContain('"chapters": [1, 2, 3]')
  })

  it('collapses short string arrays and keeps the rest of the document', () => {
    const json = JSON.stringify({ terms: [{ aliases: ['a', 'b'], term: 'x' }] }, null, 2)
    const compact = compactArrays(json)
    expect(compact).toContain(`"aliases": ["a", "b"]`)
    expect(compact).toContain('"term": "x"')
  })

  it('leaves an array that would exceed the 100-column budget expanded', () => {
    const values = Array.from({ length: 30 }, (_, index) => `value-${index}`)
    const json = JSON.stringify({ terms: values }, null, 2)
    expect(compactArrays(json)).toBe(json)
  })

  it('is a no-op on an already compact array and on JSON without arrays', () => {
    expect(compactArrays('{"a":[1,2]}')).toBe('{"a":[1,2]}')
    expect(compactArrays('{"a":1}')).toBe('{"a":1}')
  })

  it('collapses only the innermost array of a nested one', () => {
    const json = JSON.stringify({ rows: [[1, 2]] }, null, 2)
    expect(compactArrays(json)).toBe(['{', '  "rows": [', '    [1, 2]', '  ]', '}'].join('\n'))
  })
})
