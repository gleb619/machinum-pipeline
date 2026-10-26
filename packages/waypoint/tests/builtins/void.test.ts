import type { Envelope, TargetContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import type { ParsedUri } from '../../src/uri.js'
import { createVoidTarget } from '../../src/void.js'

const ctx = { run: { global: { settings: {} } } } as TargetContext

function makeTarget(): ReturnType<typeof createVoidTarget> {
  const uri: ParsedUri = { scheme: 'void', raw: 'void://', host: '', path: '', query: {} }
  return createVoidTarget(uri)
}

describe('void target', () => {
  it('open/write/close all resolve without error', async () => {
    const target = makeTarget()

    await expect(target.open(ctx)).resolves.toBeUndefined()
    await expect(
      target.write({ item: 'anything', meta: { some: 'meta' } }, ctx),
    ).resolves.toBeUndefined()
    await expect(target.close(ctx)).resolves.toBeUndefined()
  })

  it('accepts any envelope shape without accumulating state', async () => {
    const target = makeTarget()

    await target.open(ctx)
    for (const item of [1, 'two', { three: 3 }, [4], null]) {
      const env = { item: item as unknown, meta: {} } as Envelope<unknown>
      await target.write(env, ctx)
    }
    await target.close(ctx)

    // Nothing observable to assert — the sink holds no state
    expect(target.uri).toBe('void://')
  })
})
