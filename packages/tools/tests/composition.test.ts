import { createExchange, defineTool, getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { appendMdOutput, mdOutputEmitter } from '../src/core/md-outputs.js'
import { chapterDoc } from '../src/modification/chapter-doc.js'
import { schemaDocWriter } from '../src/modification/schema-doc.js'

const ctx = {} as ToolContext
const meta = { chapterNum: 3, summary: 'S' }

describe('appendMdOutput / mdOutputEmitter', () => {
  it('appends without mutating', () => {
    const m = appendMdOutput(createExchange('x'), {
      name: 'a',
      subdir: 'd',
      filename: 'f',
      content: 'c',
    })
    const out = appendMdOutput(m, { name: 'b', subdir: 'd', filename: 'g', content: 'x' })
    expect(getVariable<unknown[]>(out, 'mdOutputs')?.length).toBe(2)
    expect(getVariable<unknown[]>(m, 'mdOutputs')?.length).toBe(1)
    expect(out.id).toBe(m.id)
  })

  it('emitter honours when()', async () => {
    const e = mdOutputEmitter({ name: 'n', subdir: 'd', filename: () => 'f.md', when: () => false })
    const out = await e.invoke({ id: 'ex-test', variables: [], item: 'md', meta: {} }, ctx)
    expect(getVariable(out, 'mdOutputs')).toBeUndefined()
  })
})

describe('schemaDocWriter slots', () => {
  it('default emits a schema subdir intent', async () => {
    const out = await schemaDocWriter.invoke(
      { id: 'ex-test', variables: [], item: '# T', meta },
      ctx,
    )
    const entries = getVariable(out, 'mdOutputs') as Array<{ subdir: string; filename: string }>
    expect(entries).toHaveLength(1)
    expect(entries[0]?.subdir).toBe('schema')
    expect(entries[0]?.filename).toBe('chapter3.schema.md')
  })

  it('mock emit slot replaces output, build kept, original untouched', async () => {
    const seen: string[] = []
    const mock = defineTool<string, string>({
      name: 'mock-emit',
      version: '1',
      mdDescription: 'mock',
      invoke: async (env) => {
        seen.push(env.item)
        return { ...env, meta: { ...env.meta, mocked: true } }
      },
    })
    const custom = schemaDocWriter.with({ emit: mock })
    const out = await custom.invoke({ id: 'ex-test', variables: [], item: '# T', meta }, ctx)
    expect(out.meta.mocked).toBe(true)
    expect(getVariable(out, 'mdOutputs')).toBeUndefined()
    expect(seen[0]).toContain('## Summary')
    const orig = await schemaDocWriter.invoke(
      { id: 'ex-test', variables: [], item: '# T', meta },
      ctx,
    )
    expect(getVariable(orig, 'mdOutputs')).toHaveLength(1)
  })
})

describe('chapterDoc slots', () => {
  it('default unchanged and emit swappable', async () => {
    const env = createExchange({ title: 'T', body: 'hello' }, { meta: { chapterNum: 2 } })
    const out = await chapterDoc.invoke(env, ctx)
    expect(getVariable(out, 'mdOutputs')).toEqual([
      expect.objectContaining({ subdir: '', filename: 'chapter2.md' }),
    ])
    const alt = chapterDoc.with({
      emit: mdOutputEmitter({ name: 'x', subdir: 'alt', filename: () => 'a.md' }),
    })
    const out2 = await alt.invoke(env, ctx)
    expect(getVariable(out2, 'mdOutputs')).toEqual([
      expect.objectContaining({ subdir: 'alt', name: 'x' }),
    ])
  })
})
