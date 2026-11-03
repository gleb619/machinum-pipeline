import type { Exchange, SourceContext, TargetContext } from '@mt/core'
import { registry } from '@mt/core'
import { describe, expect, it } from 'vitest'
import '../../src/ephemeral.js'

const tctx = { run: { global: { settings: {} } } } as unknown as TargetContext
const sctx = { run: { global: { settings: {} } } } as unknown as SourceContext

function env(n: number): Exchange<number> {
  return { id: `e${n}`, item: n, meta: {}, variables: {} } as unknown as Exchange<number>
}

async function write(uri: string, values: number[]): Promise<void> {
  const target = registry.resolveTarget<number>(uri)
  await target.open(tctx)
  for (const v of values) await target.write(env(v), tctx)
  await target.close(tctx)
}

async function read(uri: string): Promise<number[]> {
  const out: number[] = []
  for await (const e of registry.resolveSource<number>(uri).start(sctx)) out.push(e.item)
  return out
}

describe('mem:// alias for ephemeral://', () => {
  it('registers source and target', () => {
    expect(registry.hasSource('mem')).toBe(true)
    expect(registry.hasTarget('mem')).toBe(true)
  })

  it('write via mem://, read via ephemeral://', async () => {
    await write('mem://alias-a', [1, 2, 3])
    expect(await read('ephemeral://alias-a')).toEqual([1, 2, 3])
  })

  it('write via ephemeral://, read via mem://', async () => {
    await write('ephemeral://alias-b', [4, 5])
    expect(await read('mem://alias-b')).toEqual([4, 5])
  })

  it('mem:// target clears the shared buffer on open', async () => {
    await write('ephemeral://alias-c', [1, 2])
    await write('mem://alias-c', [9])
    expect(await read('ephemeral://alias-c')).toEqual([9])
  })
})
