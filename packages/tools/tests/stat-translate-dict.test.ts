import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Envelope, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { mockLlmCall } from '../src/core/llm-gate.js'
import { createStatTranslateDict } from '../src/modification/stat-translate-dict.js'
import type { Glossary, GlossaryTerm } from '../src/normalization/term-tagger.js'

const CTX = {} as ToolContext

function term(partial: Partial<GlossaryTerm> & { id: string; term: string }): GlossaryTerm {
  return {
    type: 'term',
    count: 1,
    firstChapter: null,
    ru: null,
    aliases: [],
    ...partial,
  }
}

function makeGlossary(terms: GlossaryTerm[]): Glossary {
  return { terms }
}

interface SimpleMessage {
  role: string
  content: string
}

function entriesContent(messages: SimpleMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'user' && m.content.includes('```json')) return m.content
  }
  return ''
}

function parseEntries(content: string): Array<{ id: string; term: string }> {
  const match = /```json\s*([\s\S]*?)```/.exec(content)
  if (!match) return []
  const parsed = JSON.parse(match[1] as string) as Array<{ id: string; term: string }>
  return Array.isArray(parsed) ? parsed : []
}

function mockAnswer() {
  return mockLlmCall((req) => {
    const entries = parseEntries(entriesContent(req.messages))
    return JSON.stringify({
      translations: entries.map((e) => ({ id: e.id, ru: `Пер-${e.id}` })),
    })
  })
}

describe('statTranslateDict', () => {
  it('translates untranslated entries and records llmUsage', async () => {
    const glossary = makeGlossary([
      term({ id: 'cat', term: 'Cat', type: 'character', ru: 'Кот' }),
      term({ id: 'silver-sword', term: 'Silver Sword', type: 'item' }),
      term({ id: 'dogs', term: 'Dogs', type: 'character' }),
    ])
    const tool = createStatTranslateDict({ batchSize: 5 }).with({ call: mockAnswer() })
    const out = await tool.invoke({ item: glossary, meta: {} }, CTX)
    const result = out.item as Glossary
    expect(result.terms[0]).toEqual(glossary.terms[0])
    expect(result.terms[1]?.ru).toBe('Пер-silver-sword')
    expect(result.terms[2]?.ru).toBe('Пер-dogs')
    expect(out.meta.statTranslateDict).toBe(true)
    expect(out.meta.llmUsage).toMatchObject({
      calls: 1,
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      totalTokens: expect.any(Number),
    })
  })

  it('caps each call at batchSize and leaves the rest untouched', async () => {
    const terms = Array.from({ length: 5 }, (_, i) =>
      term({ id: `t${i}`, term: `Term ${i}`, type: 'term' }),
    )
    const glossary = makeGlossary(terms)
    const tool = createStatTranslateDict({ batchSize: 2 }).with({ call: mockAnswer() })
    const out = await tool.invoke({ item: glossary, meta: {} }, CTX)
    const result = out.item as Glossary
    expect(result.terms[0]?.ru).toBe('Пер-t0')
    expect(result.terms[1]?.ru).toBe('Пер-t1')
    expect(result.terms[2]?.ru).toBeNull()
    expect((out.meta.llmUsage as { calls: number }).calls).toBe(1)
  })

  it('retries on id-parity validation failure and succeeds when the model fixes it', async () => {
    const glossary = makeGlossary([term({ id: 'a', term: 'A' }), term({ id: 'b', term: 'B' })])
    let call = 0
    const tool = createStatTranslateDict({ batchSize: 5 }).with({
      call: mockLlmCall((req) => {
        call++
        const entries = parseEntries(entriesContent(req.messages))
        if (call === 1) {
          // Drop one id to trigger parity failure.
          return JSON.stringify({
            translations: entries.slice(0, 1).map((e) => ({ id: e.id, ru: `Пер-${e.id}` })),
          })
        }
        return JSON.stringify({
          translations: entries.map((e) => ({ id: e.id, ru: `Пер-${e.id}` })),
        })
      }),
    })
    const out = await tool.invoke({ item: glossary, meta: {} }, CTX)
    const result = out.item as Glossary
    expect(result.terms[0]?.ru).toBe('Пер-a')
    expect(result.terms[1]?.ru).toBe('Пер-b')
    expect(call).toBe(2)
  })

  it('fails when id parity never recovers', async () => {
    const glossary = makeGlossary([term({ id: 'a', term: 'A' })])
    const tool = createStatTranslateDict({ batchSize: 5 }).with({
      call: mockLlmCall(() => JSON.stringify({ translations: [{ id: 'wrong', ru: 'X' }] })),
    })
    await expect(tool.invoke({ item: glossary, meta: {} }, CTX)).rejects.toThrow(
      /Returned ids do not match/,
    )
  })

  it('handles batched envelope input', async () => {
    const g1 = makeGlossary([term({ id: 'x', term: 'X' }), term({ id: 'y', term: 'Y' })])
    const g2 = makeGlossary([term({ id: 'z', term: 'Z' })])
    const tool = createStatTranslateDict({ batchSize: 5 }).with({ call: mockAnswer() })
    const env: Envelope<Glossary> = { item: g1, items: [g1, g2], meta: { keep: 1 } }
    const out = await tool.invoke(env, CTX)
    const results = out.item as unknown as Glossary[]
    expect(results).toHaveLength(2)
    expect(results[0]?.terms.find((t) => t.id === 'x')?.ru).toBe('Пер-x')
    expect(results[0]?.terms.find((t) => t.id === 'y')?.ru).toBe('Пер-y')
    expect(results[1]?.terms.find((t) => t.id === 'z')?.ru).toBe('Пер-z')
    expect(out.meta.keep).toBe(1)
    expect((out.meta.llmUsage as { calls: number }).calls).toBe(2)
  })

  it('writes the translated glossary to outFile atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-stat-translate-dict-'))
    const outFile = join(dir, 'dict.json')
    const glossary = makeGlossary([term({ id: 'a', term: 'A' })])
    const tool = createStatTranslateDict({ outFile }).with({ call: mockAnswer() })
    const out = await tool.invoke({ item: glossary, meta: {} }, CTX)
    const result = out.item as Glossary
    expect(result.terms[0]?.ru).toBe('Пер-a')

    const written = JSON.parse(await readFile(outFile, 'utf-8')) as Glossary
    expect(written.terms[0]).toEqual(result.terms[0])

    await rm(dir, { recursive: true, force: true })
  })
})
