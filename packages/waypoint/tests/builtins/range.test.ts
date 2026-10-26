import type { Envelope, SourceContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { createRangeSource } from '../../src/range.js'
import type { ParsedUri } from '../../src/uri.js'

const ctx = { run: { global: { settings: {} } } } as SourceContext

function makeSource(raw: string, query: Record<string, string> = {}) {
  const hostAndPath = raw.replace(/^range:\/\//, '')
  const uri: ParsedUri = { scheme: 'range', raw, host: hostAndPath, path: '', query }
  return createRangeSource(uri)
}

async function collect(envs: AsyncIterable<Envelope<number>>): Promise<Envelope<number>[]> {
  const out: Envelope<number>[] = []
  for await (const env of envs) out.push(env)
  return out
}

describe('range source', () => {
  it('emits 1..10 in order, one envelope per number', async () => {
    const source = makeSource('range://1..10')
    const envelopes = await collect(source.start(ctx))

    expect(envelopes).toHaveLength(10)
    expect(envelopes.map((env) => env.item)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    for (const env of envelopes) expect(env.meta).toEqual({})
  })

  it('applies step param (1..10 step 3 → 1,4,7,10)', async () => {
    const source = makeSource('range://1..10', { step: '3' })
    const envelopes = await collect(source.start(ctx))

    expect(envelopes.map((env) => env.item)).toEqual([1, 4, 7, 10])
  })

  it('supports downward ranges (5..3 → 5,4,3)', async () => {
    const source = makeSource('range://5..3')
    const envelopes = await collect(source.start(ctx))

    expect(envelopes.map((env) => env.item)).toEqual([5, 4, 3])
  })

  it('supports downward ranges with step (10..1 step 4 → 10,6,2)', async () => {
    const source = makeSource('range://10..1', { step: '4' })
    const envelopes = await collect(source.start(ctx))

    expect(envelopes.map((env) => env.item)).toEqual([10, 6, 2])
  })

  it('emits a single envelope for 0..0', async () => {
    const source = makeSource('range://0..0')
    const envelopes = await collect(source.start(ctx))

    expect(envelopes).toHaveLength(1)
    expect(envelopes[0].item).toBe(0)
  })

  it('emits a single envelope for 3..3', async () => {
    const source = makeSource('range://3..3')
    const envelopes = await collect(source.start(ctx))

    expect(envelopes).toHaveLength(1)
    expect(envelopes[0].item).toBe(3)
  })

  it('throws on missing ".." separator', () => {
    expect(() => makeSource('range://1-10')).toThrow(/missing "\.\." separator/)
  })

  it('throws on non-integer start', () => {
    expect(() => makeSource('range://1.5..10')).toThrow(/start must be an integer/)
  })

  it('throws on non-integer end', () => {
    expect(() => makeSource('range://1..abc')).toThrow(/end must be an integer/)
  })

  it('throws on empty range component', () => {
    expect(() => makeSource('range://..10')).toThrow(/start must be an integer/)
    expect(() => makeSource('range://1..')).toThrow(/end must be an integer/)
  })

  it('throws on non-integer step', () => {
    expect(() => makeSource('range://1..10', { step: 'abc' })).toThrow(/step must be an integer/)
  })

  it('throws on zero or negative step', () => {
    expect(() => makeSource('range://1..10', { step: '0' })).toThrow(
      /step must be a positive integer/,
    )
    expect(() => makeSource('range://10..1', { step: '-2' })).toThrow(
      /step must be a positive integer/,
    )
  })

  describe('resume', () => {
    it('skips exactly N envelopes (cursor=4 → starts at 5th)', async () => {
      const source = makeSource('range://1..10')
      const startItems = (await collect(source.start(ctx))).map((env) => env.item)
      const resumeItems = (await collect(source.resume(ctx, 4))).map((env) => env.item)

      expect(resumeItems).toEqual(startItems.slice(4))
      expect(resumeItems[0]).toBe(5)
    })

    it('non-number cursor skips nothing', async () => {
      const source = makeSource('range://1..5')
      const envelopes = await collect(source.resume(ctx, 'not-a-number'))

      expect(envelopes.map((env) => env.item)).toEqual([1, 2, 3, 4, 5])
    })
  })
})
