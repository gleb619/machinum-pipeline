import { defineTool } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { chapterDoc } from '../src/chapter-doc.js'
import { appendMdOutput, mdOutputEmitter } from '../src/md-outputs.js'
import { schemaDocWriter } from '../src/schema-doc.js'

const ctx = {} as ToolContext
const meta = { chapterNum: 3, summary: 'S' }

describe('appendMdOutput / mdOutputEmitter', () => {
  it('appends without mutating', () => {
    const m = { mdOutputs: [{ name: 'a', subdir: 'd', filename: 'f', content: 'c' }] }
    const out = appendMdOutput(m, { name: 'b', subdir: 'd', filename: 'g', content: 'x' })
    expect((out.mdOutputs as unknown[]).length).toBe(2)
    expect(m.mdOutputs.length).toBe(1)
  })

  it('emitter honours when()', async () => {
    const e = mdOutputEmitter({ name: 'n', subdir: 'd', filename: () => 'f.md', when: () => false })
    const out = await e.invoke({ item: 'md', meta: {} }, ctx)
    expect(out.meta.mdOutputs).toBeUndefined()
  })
})

describe('schemaDocWriter slots', () => {
  it('default emits a schema subdir intent', async () => {
    const out = await schemaDocWriter.invoke({ item: '# T', meta }, ctx)
    const entries = out.meta.mdOutputs as Array<{ subdir: string; filename: string }>
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
    const out = await custom.invoke({ item: '# T', meta }, ctx)
    expect(out.meta.mocked).toBe(true)
    expect(out.meta.mdOutputs).toBeUndefined()
    expect(seen[0]).toContain('## Summary')
    const orig = await schemaDocWriter.invoke({ item: '# T', meta }, ctx)
    expect(orig.meta.mdOutputs).toHaveLength(1)
  })
})

describe('chapterDoc slots', () => {
  it('default unchanged and emit swappable', async () => {
    const env = { item: { title: 'T', body: 'hello' }, meta: { chapterNum: 2 } }
    const out = await chapterDoc.invoke(env, ctx)
    expect(out.meta.mdOutputs).toEqual([
      expect.objectContaining({ subdir: '', filename: 'chapter2.md' }),
    ])
    const alt = chapterDoc.with({
      emit: mdOutputEmitter({ name: 'x', subdir: 'alt', filename: () => 'a.md' }),
    })
    const out2 = await alt.invoke(env, ctx)
    expect(out2.meta.mdOutputs).toEqual([expect.objectContaining({ subdir: 'alt', name: 'x' })])
  })
})
