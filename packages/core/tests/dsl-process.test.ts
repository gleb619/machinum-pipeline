import { describe, expect, it, vi } from 'vitest'
import { definePipeline, defineProcess } from '../src/dsl.js'

describe('defineProcess', () => {
  it('runs function installers immediately and is chainable', () => {
    const a = vi.fn()
    const b = vi.fn()
    const builder = defineProcess()
      .install(a)
      .install(b, () => {})
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(builder).toBeDefined()
  })

  it('runs object installers via .install()', () => {
    const install = vi.fn()
    defineProcess().install({ install })
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('.pipeline() returns the pipeline unchanged', () => {
    const pipeline = definePipeline({ id: 'p' })
    const out = defineProcess().pipeline(pipeline)
    expect(out).toBe(pipeline)
    expect(out.id).toBe('p')
  })

  it('full chain: install then pipeline as a default-export shape', () => {
    const seen: string[] = []
    const out = defineProcess()
      .install(() => {
        seen.push('installed')
      })
      .pipeline(definePipeline({ id: 'orchestration' }))
    expect(seen).toEqual(['installed'])
    expect(out.id).toBe('orchestration')
  })

  it('.config({ env }) attaches envDefaults to the pipeline at .pipeline()', () => {
    const pipeline = definePipeline({ id: 'p' })
    const out = defineProcess()
      .config({ env: { A: '1' } })
      .pipeline(pipeline)
    expect(out).toBe(pipeline)
    expect(out.envDefaults).toEqual({ A: '1' })
  })

  it('.config() merges across calls; later values win', () => {
    const out = defineProcess()
      .config({ env: { A: '1', B: '1' } })
      .config({ env: { B: '2' } })
      .pipeline(definePipeline({ id: 'p' }))
    expect(out.envDefaults).toEqual({ A: '1', B: '2' })
  })
})
