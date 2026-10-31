import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { mockLlmCall } from '../src/core/llm-gate.js'
import { createTranslateText } from '../src/core/translate-text.js'
import { createProofreadTool, createProofreadXmlTool } from '../src/modification/proofread.js'
import { writeDoc } from '../src/modification/schema-doc.js'
import type { SchemaDocLlmCall } from '../src/normalization/schema/llm.js'
import { createNotesSummaryTool, createSummaryTool } from '../src/normalization/schema/summary.js'
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
