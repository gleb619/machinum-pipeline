import type { Envelope, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { tokenCounter } from '../src/token-counter.js'

describe('tokenCounter', () => {
  it('counts tokens', async () => {
    const env: Envelope<string> = { item: 'hello world', meta: {} }
    const res = await tokenCounter.invoke(env, {} as ToolContext)
    expect(res.meta.tokenCount).toBeGreaterThan(0)
    expect(res.item).toBe('hello world')
  })
})
