import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runChunkedText } from '../src/core/chunk-processor.js'
import { mockLlmCall } from '../src/core/llm-gate.js'
import { createLlmTranslate } from '../src/core/llm-translate.js'
import { createTranslateText } from '../src/core/translate-text.js'
import { createParagraphTranslator } from '../src/modification/chapter-translator.js'
import { createProofreadTool, createProofreadXmlTool } from '../src/modification/proofread.js'
import { writeDoc } from '../src/modification/schema-doc.js'
import { enrichTermWithLlm, extractGlossaryWithLlm } from '../src/normalization/glossary-llm.js'
import { createLlmSummaryWithFallback } from '../src/normalization/llm-summary.js'
import { createLlmTypoFix } from '../src/normalization/llm-typo-fix.js'
import { createEntitiesTool } from '../src/normalization/schema/entities.js'
import type { SchemaDocLlmCall } from '../src/normalization/schema/llm.js'
import { createNotesSummaryTool, createSummaryTool } from '../src/normalization/schema/summary.js'
import { createVocabularyTool } from '../src/normalization/schema/vocabulary.js'
import { exchangeOf } from './exchange-helper.js'

/** ctx whose settings force a small context window so the budget is tight. */
function smallCtx(contextLimit: number): ToolContext {
  return {
    run: { global: { settings: { 'context.contextLimit': contextLimit }, env: {} } },
  } as unknown as ToolContext
}

const PARAS = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} ${'word '.repeat(60)}end.`)
const BODY = PARAS.join('\n\n')

function chapter(body: string): string {
  return writeDoc({
    title: 'Chapter 1: Test',
    metadata: { chapter: 1, wordCount: 480, tokenCount: 700, charLength: body.length },
    summary: body,
    entities: [],
    vocabulary: [],
  })
}

function reply(content: string) {
  return { content, model: 'mock', tokens: 5, promptTokens: 3, completionTokens: 2 }
}

// contextLimit chosen so each paragraph fits alone but not the whole text.
const TIGHT = 1500
const ROOMY = 200_000
// small-prompt tools (no big bundled system prompt): body alone is ~500 tokens
const SMALL = 330

function countingCall(
  respond: (prompt: string, n: number) => string,
): SchemaDocLlmCall & { calls: string[] } {
  const calls: string[] = []
  const call: SchemaDocLlmCall = async (input) => {
    const prompt = input.messages.map((m) => m.content).join('\n')
    calls.push(prompt)
    return reply(respond(prompt, calls.length))
  }
  return Object.assign(call, { calls })
}

const budgetOpts = { outputReserve: 0, reserve: 0 }

describe('summary chunk modes', () => {
  it('shrink (default): one call, no chunk metadata', async () => {
    const call = countingCall(() => 'A summary sentence.')
    const out = await createSummaryTool({ call }).invoke(exchangeOf(chapter(BODY)), smallCtx(TIGHT))
    expect(call.calls).toHaveLength(1)
    expect(getVariable(out, 'summaryChunks')).toBeUndefined()
  })

  it('chunk: several calls, merged in order, aggregated attempts, chunk variable', async () => {
    const call = countingCall((_, n) => `Summary part ${n}.`)
    const out = await createSummaryTool({ call, chunkMode: 'chunk', ...budgetOpts }).invoke(
      exchangeOf(chapter(BODY)),
      smallCtx(TIGHT),
    )
    expect(call.calls.length).toBeGreaterThan(1)
    const summary = String(getVariable(out, 'summary'))
    expect(summary.indexOf('Summary part 1.')).toBeLessThan(summary.indexOf('Summary part 2.'))
    const rec = getVariable(out, 'summaryChunks') as Array<Record<string, unknown>>
    expect(rec[0]).toMatchObject({ chunks: call.calls.length, limit: TIGHT })
    expect(getVariable(out, 'summaryLlm')).toMatchObject({ attempts: call.calls.length })
  })

  it('auto: single call when the text fits, chunks when it does not', async () => {
    const roomy = countingCall(() => 'One.')
    const a = await createSummaryTool({ call: roomy, chunkMode: 'auto', ...budgetOpts }).invoke(
      exchangeOf(chapter(BODY)),
      smallCtx(ROOMY),
    )
    expect(roomy.calls).toHaveLength(1)
    expect(getVariable(a, 'summaryChunks')).toBeUndefined()

    const tight = countingCall(() => 'Part.')
    await createSummaryTool({ call: tight, chunkMode: 'auto', ...budgetOpts }).invoke(
      exchangeOf(chapter(BODY)),
      smallCtx(TIGHT),
    )
    expect(tight.calls.length).toBeGreaterThan(1)
  })
})

describe('summary-notes chunk modes', () => {
  it('chunk: merges and dedupes notes, counts every chunk attempt', async () => {
    const call = countingCall((_, n) => `- shared note\n- note ${n}`)
    const out = await createNotesSummaryTool({
      call,
      chunkMode: 'chunk',
      count: 20,
      ...budgetOpts,
    }).invoke(exchangeOf(chapter(BODY)), smallCtx(TIGHT))
    expect(call.calls.length).toBeGreaterThan(1)
    const notes = getVariable(out, 'summaryNotes') as string[]
    expect(notes.filter((n) => n === 'shared note')).toHaveLength(1)
    expect(notes).toContain('note 1')
    expect(getVariable(out, 'summaryNotesLlm')).toMatchObject({ attempts: call.calls.length })
    expect(getVariable(out, 'summaryNotesChunks')).toBeDefined()
  })

  it('shrink: no chunk variable', async () => {
    const call = countingCall(() => '- only note')
    const out = await createNotesSummaryTool({ call }).invoke(
      exchangeOf(chapter(BODY)),
      smallCtx(TIGHT),
    )
    expect(call.calls).toHaveLength(1)
    expect(getVariable(out, 'summaryNotesChunks')).toBeUndefined()
  })
})

function proofreadCall(): SchemaDocLlmCall & { calls: string[] } {
  const calls: string[] = []
  const call: SchemaDocLlmCall = async (input) => {
    const content = input.messages[0]?.content ?? ''
    calls.push(content)
    const m = /(<results>[\s\S]*?<\/results>)/.exec(content)
    const xml = (m?.[1] ?? content)
      .replace(/<text>/g, '<proofread>')
      .replace(/<\/text>/g, '</proofread>')
      .replace(/(<proofread>)([\s\S]*?)(<\/proofread>)/g, '$1$2[ok]$3')
    return reply(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`)
  }
  return Object.assign(call, { calls })
}

describe('proofread chunk modes', () => {
  it('shrink: one call, no chunk variable', async () => {
    const call = proofreadCall()
    const out = await createProofreadTool({ call }).invoke(exchangeOf(BODY), smallCtx(TIGHT))
    expect(call.calls).toHaveLength(1)
    expect(getVariable(out, 'proofreadChunks')).toBeUndefined()
  })

  it('chunk: groups paragraphs, keeps order, records variable', async () => {
    const call = proofreadCall()
    const out = await createProofreadTool({
      call,
      chunkMode: 'chunk',
      ...budgetOpts,
    }).invoke(exchangeOf(BODY), smallCtx(TIGHT))
    expect(call.calls.length).toBeGreaterThan(1)
    const parts = out.item.split('\n\n')
    expect(parts).toHaveLength(PARAS.length)
    parts.forEach((p, i) => {
      expect(p.startsWith(`Paragraph ${i + 1} `)).toBe(true)
      expect(p.endsWith('[ok]'), `${i}: ${p.slice(-30)} | ${call.calls.length}`).toBe(true)
    })
    expect(getVariable(out, 'proofreadChunks')).toMatchObject({ chunks: call.calls.length })
  })

  it('auto: single call when it fits', async () => {
    const call = proofreadCall()
    await createProofreadTool({ call, chunkMode: 'auto', ...budgetOpts }).invoke(
      exchangeOf(BODY),
      smallCtx(ROOMY),
    )
    expect(call.calls).toHaveLength(1)
  })
})

describe('proofread-xml chunk modes', () => {
  const xmlIn = `<results>${PARAS.map((p, i) => `<result><id>${i + 1}</id><text>${p}</text></result>`).join('')}</results>`

  it('chunk: several calls, variable recorded', async () => {
    const call = proofreadCall()
    const out = await createProofreadXmlTool({ call, chunkMode: 'chunk', ...budgetOpts }).invoke(
      exchangeOf(xmlIn),
      smallCtx(TIGHT),
    )
    expect(call.calls.length).toBeGreaterThan(1)
    expect(getVariable(out, 'proofreadXmlChunks')).toMatchObject({ chunks: call.calls.length })
    for (let i = 1; i <= PARAS.length; i++) expect(out.item).toContain(`<id>${i}</id>`)
  })

  it('shrink: one call', async () => {
    const call = proofreadCall()
    await createProofreadXmlTool({ call }).invoke(exchangeOf(xmlIn), smallCtx(TIGHT))
    expect(call.calls).toHaveLength(1)
  })
})

describe('translate chunk modes', () => {
  const input = { text: BODY, targetLang: 'ru' }

  it('shrink (default) returns the bare gate: one call', async () => {
    const mock = mockLlmCall(() => ({ content: 'перевод', model: 'm' }))
    const out = await createTranslateText({ backend: 'llm' })
      .with({ call: mock })
      .invoke(exchangeOf(input), smallCtx(TIGHT))
    expect(mock.calls).toHaveLength(1)
    expect(getVariable(out, 'translateChunks')).toBeUndefined()
  })

  it('chunk: translates each chunk, joins in order, records variable, keeps tokens and model', async () => {
    const mock = mockLlmCall((_req, i) => ({
      content: `часть ${i + 1}`,
      model: 'used-model',
    }))
    const out = await createTranslateText({
      backend: 'llm',
      chunkMode: 'chunk',
      outputReserve: 0,
      reserve: 0,
    })
      .with({ call: mock })
      .invoke(exchangeOf(input), smallCtx(550))
    const n = mock.calls.length
    expect(n).toBeGreaterThan(1)
    expect(out.item.translatedText.indexOf('часть 1')).toBeLessThan(
      out.item.translatedText.indexOf('часть 2'),
    )
    expect(out.item.model).toBe('used-model')
    expect(getVariable(out, 'translateChunks')).toMatchObject({ chunks: n, limit: 550 })
  })

  it('auto: one call when the text fits the budget', async () => {
    const mock = mockLlmCall(() => ({ content: 'x', model: 'm' }))
    await createTranslateText({ backend: 'llm', chunkMode: 'auto', outputReserve: 0, reserve: 0 })
      .with({ call: mock })
      .invoke(exchangeOf(input), smallCtx(ROOMY))
    expect(mock.calls).toHaveLength(1)
  })
})

describe('runChunkedText', () => {
  const budgetFor = (limit: number) => () =>
    ({
      limit,
      outputReserve: 0,
      thinkReserve: 0,
      overhead: 0,
      reserve: 0,
      inputBudget: limit,
      model: 'm',
    }) as const

  it('shrink never evaluates the budget', async () => {
    const r = await runChunkedText({
      mode: 'shrink',
      text: BODY,
      budget: () => {
        throw new Error('budget must stay lazy')
      },
      single: async () => 'one',
      chunk: async () => 'chunk',
      merge: (o) => o.join('|'),
    })
    expect(r).toEqual({ value: 'one', chunks: 0 })
  })

  it('auto: single when fits, chunks when not', async () => {
    const fits = await runChunkedText({
      mode: 'auto',
      text: BODY,
      budget: budgetFor(100_000),
      single: async () => 'one',
      chunk: async () => 'c',
      merge: (o) => o.join('|'),
    })
    expect(fits.chunks).toBe(0)
    const tight = await runChunkedText({
      mode: 'auto',
      text: BODY,
      budget: budgetFor(120),
      single: async () => 'one',
      chunk: async () => 'c',
      merge: (o) => o.join('|'),
    })
    expect(tight.chunks).toBeGreaterThan(1)
    expect(tight.value.split('|')).toHaveLength(tight.chunks)
  })
})

describe('entities chunk modes', () => {
  const entityCall = () =>
    countingCall((prompt) => {
      const n = /Paragraph (\d+)/.exec(prompt)?.[1] ?? '1'
      return `index,name\n1,Paragraph ${n}\n2,word`
    })

  it('shrink: one call, no chunk variable', async () => {
    const call = entityCall()
    const out = await createEntitiesTool({ call }).invoke(
      exchangeOf(chapter(BODY)),
      smallCtx(SMALL),
    )
    expect(call.calls).toHaveLength(1)
    expect(getVariable(out, 'entitiesChunks')).toBeUndefined()
  })

  it('chunk: merges entities across chunks, dedupes, reindexes, aggregates attempts', async () => {
    const call = entityCall()
    const out = await createEntitiesTool({ call, chunkMode: 'chunk', ...budgetOpts }).invoke(
      exchangeOf(chapter(BODY)),
      smallCtx(SMALL),
    )
    expect(call.calls.length).toBeGreaterThan(1)
    const entities = getVariable(out, 'entities') as Array<{ index: number; name: string }>
    expect(entities.filter((e) => e.name === 'word')).toHaveLength(1)
    expect(entities.length).toBeGreaterThan(2)
    expect(entities.map((e) => e.index)).toEqual(entities.map((_, i) => i + 1))
    expect(getVariable(out, 'entitiesLlm')).toMatchObject({ attempts: call.calls.length })
    expect(getVariable(out, 'entitiesChunks')).toBeDefined()
  })

  it('auto: one call when it fits', async () => {
    const call = entityCall()
    await createEntitiesTool({ call, chunkMode: 'auto', ...budgetOpts }).invoke(
      exchangeOf(chapter(BODY)),
      smallCtx(ROOMY),
    )
    expect(call.calls).toHaveLength(1)
  })
})

describe('vocabulary chunk modes', () => {
  it('chunk: dedupes terms across chunks and honours the limit', async () => {
    const call = countingCall(() => 'word\nparagraph\nend')
    const out = await createVocabularyTool({ call, chunkMode: 'chunk', ...budgetOpts }).invoke(
      exchangeOf(chapter(BODY)),
      smallCtx(SMALL),
    )
    expect(call.calls.length).toBeGreaterThan(1)
    expect(getVariable(out, 'vocabulary')).toEqual(['paragraph', 'end'])
    expect(getVariable(out, 'vocabularyChunks')).toBeDefined()
    expect(getVariable(out, 'vocabularyLlm')).toMatchObject({ attempts: call.calls.length })
  })

  it('shrink: one call', async () => {
    const call = countingCall(() => 'word\nparagraph')
    await createVocabularyTool({ call }).invoke(exchangeOf(chapter(BODY)), smallCtx(SMALL))
    expect(call.calls).toHaveLength(1)
  })
})

describe('llm-summary chunk modes', () => {
  it('passes chunk options to the summary tool', async () => {
    const call = countingCall((_, n) => `Part ${n}.`)
    const tool = createLlmSummaryWithFallback({ call, chunkMode: 'chunk', ...budgetOpts })
    const out = await tool.invoke(exchangeOf(chapter(BODY)) as never, smallCtx(TIGHT))
    expect(call.calls.length).toBeGreaterThan(1)
    expect(getVariable(out as never, 'summaryChunks')).toBeDefined()
  })
})

describe('llm-typo-fix chunk modes', () => {
  const text = PARAS.join('\n\n')

  it('shrink: one call', async () => {
    const call = countingCall((p) => p)
    await createLlmTypoFix({ call }).invoke(exchangeOf(text), smallCtx(SMALL))
    expect(call.calls).toHaveLength(1)
  })

  it('chunk: fixes every chunk, keeps order, records variable', async () => {
    const call = countingCall((p) => p.replace(/end\./g, 'END.'))
    const out = await createLlmTypoFix({ call, chunkMode: 'chunk', ...budgetOpts }).invoke(
      exchangeOf(text),
      smallCtx(SMALL),
    )
    expect(call.calls.length).toBeGreaterThan(1)
    const parts = out.item.split('\n\n')
    expect(parts).toHaveLength(PARAS.length)
    parts.forEach((p, i) => {
      expect(p.startsWith(`Paragraph ${i + 1} `)).toBe(true)
      expect(p.endsWith('END.')).toBe(true)
    })
    expect(getVariable(out, 'llmFixed')).toBe(true)
    expect(getVariable(out, 'llmTypoFixChunks')).toMatchObject({ chunks: call.calls.length })
  })

  it('chunk: a chunk whose reply changes the line count keeps its original text', async () => {
    const call = countingCall((p, n) => (n === 1 ? `${p}\nextra line` : p))
    const out = await createLlmTypoFix({ call, chunkMode: 'chunk', ...budgetOpts }).invoke(
      exchangeOf(text),
      smallCtx(SMALL),
    )
    expect(out.item).toBe(text)
    expect(getVariable(out, 'llmFixed')).toBe(false)
  })
})

describe('glossary-llm chunk modes', () => {
  const chapters = [{ chapter: 1, text: BODY }]
  const glossaryCall = () =>
    countingCall((prompt) => {
      const n = /Paragraph (\d+)/.exec(prompt)?.[1] ?? '0'
      return JSON.stringify([
        { name: `Term ${n}`, category: 'Character', description: `d${n}`, references: ['Shared'] },
        { name: 'Shared', category: 'Location', description: 'common', references: [`Term ${n}`] },
      ])
    })

  it('shrink: one call over the (truncated) corpus', async () => {
    const call = glossaryCall()
    const r = await extractGlossaryWithLlm(smallCtx(TIGHT), { call, chapters })
    expect(call.calls).toHaveLength(1)
    expect(r.entries.length).toBeGreaterThan(0)
  })

  it('chunk: merges entries by name, unions references, aggregates attempts', async () => {
    const call = glossaryCall()
    const r = await extractGlossaryWithLlm(smallCtx(TIGHT), {
      call,
      chapters,
      chunkMode: 'chunk',
      ...budgetOpts,
    })
    expect(call.calls.length).toBeGreaterThan(1)
    expect(r.entries.filter((e) => e.name === 'Shared')).toHaveLength(1)
    const shared = r.entries.find((e) => e.name === 'Shared')
    expect(shared?.references.length).toBeGreaterThan(1)
    expect(r.entries.length).toBeGreaterThan(2)
    expect(r.meta.attempts).toBe(call.calls.length)
  })

  it('enrich chunk: merges bullet facts without duplicates', async () => {
    const call = countingCall((_, n) => `- shared fact\n- fact ${n}`)
    const r = await enrichTermWithLlm(smallCtx(SMALL), {
      call,
      term: 'Paragraph',
      chapters,
      chunkMode: 'chunk',
      ...budgetOpts,
    })
    expect(call.calls.length).toBeGreaterThan(1)
    expect(r.description.split('\n').filter((l) => l === '- shared fact')).toHaveLength(1)
    expect(r.meta.attempts).toBe(call.calls.length)
  })
})

describe('llm-translate chunk modes', () => {
  const input = { text: BODY, targetLang: 'ru' }

  it('createLlmTranslate chunk: several calls, ordered join, variable', async () => {
    const mock = mockLlmCall((_req, i) => ({ content: `часть ${i + 1}`, model: 'm' }))
    const out = await createLlmTranslate({ chunkMode: 'chunk', outputReserve: 0, reserve: 0 })
      .with({ call: mock })
      .invoke(exchangeOf(input), smallCtx(550))
    expect(mock.calls.length).toBeGreaterThan(1)
    expect(getVariable(out, 'translateChunks')).toMatchObject({ chunks: mock.calls.length })
  })

  it('createLlmTranslate default is the bare gate', async () => {
    const mock = mockLlmCall(() => ({ content: 'x', model: 'm' }))
    await createLlmTranslate().with({ call: mock }).invoke(exchangeOf(input), smallCtx(550))
    expect(mock.calls).toHaveLength(1)
  })
})

describe('chapter-translator chunk modes', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubRouter(): { calls: number } {
    const state = { calls: 0 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        state.calls++
        return new Response(JSON.stringify({ translatedText: `часть ${state.calls}` }), {
          status: 200,
        })
      }),
    )
    return state
  }

  const para = { text: PARAS[0] as string, targetLang: 'ru' }

  it('default (shrink): oversized paragraph is one translator call', async () => {
    const state = stubRouter()
    await createParagraphTranslator().invoke(exchangeOf(para), smallCtx(120))
    expect(state.calls).toBe(1)
  })

  it('chunkMode builds a chunking default translator: oversized paragraph is split', async () => {
    const state = stubRouter()
    const out = await createParagraphTranslator({
      chunkMode: 'chunk',
      outputReserve: 0,
      reserve: 0,
    }).invoke(exchangeOf(para), smallCtx(120))
    expect(out.item.paragraphsTranslated).toBe(1)
    expect(state.calls).toBeGreaterThan(1)
  })
})
