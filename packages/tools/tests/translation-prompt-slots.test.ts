import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExchange, variable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultPrompt, registerPrompt } from '../src/core/llm-prompts.js'
import type { Glossary } from '../src/normalization/term-tagger.js'
import {
  buildTranslationPrompt,
  cleanTranslation,
} from '../src/normalization/translation-prompt.js'
import {
  ENTITY_BLOCK_CAP,
  TRANSLATE_SLOTS,
  VOCAB_BLOCK_CAP,
  createChapterBodyTranslator,
  loadChapterEntities,
  loadChapterVocabulary,
  renderEntityBlock,
  renderVocabBlock,
  translateSlots,
  translateSlotsStrict,
} from '../src/normalization/translation-stage.js'

function testCtx(): ToolContext & { run: { logger: { warn: ReturnType<typeof vi.fn> } } } {
  return {
    run: {
      global: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
  } as unknown as ToolContext & { run: { logger: { warn: ReturnType<typeof vi.fn> } } }
}

const glossary: Glossary = {
  terms: [
    {
      id: 'arin',
      term: 'Arin',
      type: 'character',
      count: 3,
      firstChapter: 1,
      ru: 'Арин',
      aliases: [],
    },
  ],
}

const ENTITIES =
  'Named entities in this chapter (keep spelling and gender consistent):\n- Arin (character)'
const VOCAB = 'Recurring terms (translate the same way every time):\nArin (proper, ×3)'

describe('translation prompt slots', () => {
  it('places entity and vocab blocks between glossary and summary', () => {
    const p = buildTranslationPrompt({
      text: '<term id="arin">Arin</term> left.',
      glossary,
      entities: ENTITIES,
      vocabulary: VOCAB,
      summary: 'A short summary.',
    })
    const s = p.systemPrompt
    const glossaryAt = s.indexOf('Glossary (translate these terms')
    const entityAt = s.indexOf(ENTITIES)
    const vocabAt = s.indexOf(VOCAB)
    const termsAt = s.indexOf('<terms>[...]</terms>')
    const summaryAt = s.indexOf('A short summary.')
    expect(glossaryAt).toBeGreaterThan(-1)
    expect(entityAt).toBeGreaterThan(glossaryAt)
    expect(vocabAt).toBeGreaterThan(entityAt)
    expect(termsAt).toBeGreaterThan(vocabAt)
    expect(summaryAt).toBeGreaterThan(termsAt)
  })

  it('renders empty blocks when the slot text is absent or blank', () => {
    const p = buildTranslationPrompt({ text: 'Plain line.', glossary, entities: '  ' })
    expect(p.systemPrompt).not.toContain('Named entities')
    expect(p.systemPrompt).not.toContain('Recurring terms')
  })

  it('mirrors both blocks in the hand-built fallback prompt', () => {
    const original = getDefaultPrompt('translate.system')
    registerPrompt({ name: 'translate.system', template: '' })
    try {
      const p = buildTranslationPrompt({
        text: '<term id="arin">Arin</term> left.',
        glossary,
        entities: ENTITIES,
        vocabulary: VOCAB,
        summary: 'A short summary.',
      })
      const s = p.systemPrompt
      const entityAt = s.indexOf(ENTITIES)
      const vocabAt = s.indexOf(VOCAB)
      const termsAt = s.indexOf('After the translated lines, append exactly one <terms>')
      const summaryAt = s.indexOf('Chapter summary (context only')
      expect(entityAt).toBeGreaterThan(-1)
      expect(vocabAt).toBeGreaterThan(entityAt)
      expect(termsAt).toBeGreaterThan(vocabAt)
      expect(summaryAt).toBeGreaterThan(termsAt)
    } finally {
      if (original) registerPrompt(original)
    }
  })

  it('cleanTranslation still strips the <terms> report after the new blocks (regression)', () => {
    const reply = 'Он вошёл.\n<terms>[{"term":"Arin","ru":"Арин","type":"character"}]</terms>'
    expect(cleanTranslation(reply)).toBe('Он вошёл.')
  })
})

describe('slot renderers', () => {
  it('caps the entity block at whole ranked lines', () => {
    const entities = Array.from({ length: 200 }, (_, i) => ({
      name: `Entity${i}`,
      kind: 'character',
    }))
    const block = renderEntityBlock(entities)
    expect(block.length).toBeLessThanOrEqual(ENTITY_BLOCK_CAP)
    expect(block.startsWith('Named entities in this chapter')).toBe(true)
    const lines = block.split('\n')
    expect(lines[1]).toBe('- Entity0 (character)')
    // the cap stops before the last entity: truncation is by rank, never mid-line
    expect(lines.at(-1)).toMatch(/^- Entity\d+ \(character\)$/)
  })

  it('renders aliases only when present', () => {
    const block = renderEntityBlock([
      { name: 'Arin', kind: 'character', aliases: ['Ari', 'the boy'] },
      { name: 'Iron Keep', kind: 'place' },
    ])
    expect(block).toContain('- Arin (character; aliases: Ari, the boy)')
    expect(block).toContain('- Iron Keep (place)')
  })

  it('keeps only the terms of the chapter, capped', () => {
    const terms = Array.from({ length: 100 }, (_, i) => ({
      term: `term${i} padded`,
      kind: 'phrase',
      count: 100 - i,
      chapters: [1, 2],
    }))
    terms.push({ term: 'other chapter', kind: 'proper', count: 50, chapters: [2] })
    const block = renderVocabBlock(terms, 1)
    expect(block.length).toBeLessThanOrEqual(VOCAB_BLOCK_CAP)
    expect(block).toContain('term0 padded (phrase, ×100)')
    expect(block).not.toContain('other chapter')
  })

  it('falls back to the book top-N for terms without chapters[]', () => {
    const terms = [
      { term: 'bookwide', kind: 'term', count: 1000 },
      ...Array.from({ length: 30 }, (_, i) => ({
        term: `filler${i}`,
        kind: 'term',
        count: 100 - i,
      })),
    ]
    expect(renderVocabBlock(terms, 1)).toContain('bookwide (term, ×1000)')
    const lowRank = Array.from({ length: 30 }, (_, i) => ({
      term: `filler${i}`,
      kind: 'term',
      count: 100 - i,
    }))
    lowRank.push({ term: 'too rare', kind: 'term', count: 1 })
    expect(renderVocabBlock(lowRank, 1)).not.toContain('too rare')
  })
})

describe('MT_TRANSLATE_SLOTS parsing', () => {
  it('defaults to every slot and keeps the declared order', () => {
    expect(translateSlots({})).toEqual([...TRANSLATE_SLOTS])
    expect(translateSlots({ MT_TRANSLATE_SLOTS: 'ner, summary' })).toEqual(['ner', 'summary'])
  })

  it('throws on an unknown slot name', () => {
    expect(() => translateSlots({ MT_TRANSLATE_SLOTS: 'summary,bogus' })).toThrow(
      /unknown MT_TRANSLATE_SLOTS value 'bogus'/,
    )
  })

  it('strict mode is MT_TRANSLATE_SLOTS_STRICT=1', () => {
    expect(translateSlotsStrict({})).toBe(false)
    expect(translateSlotsStrict({ MT_TRANSLATE_SLOTS_STRICT: '1' })).toBe(true)
  })
})

describe('slot artefact loaders', () => {
  function chaptersDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mt-slots-'))
    mkdirSync(join(dir, 'schema'), { recursive: true })
    writeFileSync(
      join(dir, 'schema', 'chapter1.entities.json'),
      JSON.stringify({
        n: 1,
        entities: [
          { id: 'arin', name: 'Arin', kind: 'character', count: 3 },
          { id: 'keep', name: 'Iron Keep', kind: 'place', count: 1 },
        ],
      }),
    )
    writeFileSync(
      join(dir, 'schema', 'vocabulary.json'),
      JSON.stringify({
        version: 1,
        params: {},
        terms: [
          { term: 'Arin', n: 1, count: 3, df: 1, chapters: [1], capRatio: 1, kind: 'proper' },
          { term: 'later', n: 1, count: 4, df: 1, chapters: [2], capRatio: 0, kind: 'term' },
        ],
      }),
    )
    return dir
  }

  it('renders the chapter entity and vocabulary blocks', async () => {
    const dir = chaptersDir()
    expect(await loadChapterEntities(dir, 1, testCtx(), {})).toBe(
      'Named entities in this chapter (keep spelling and gender consistent):\n' +
        '- Arin (character)\n- Iron Keep (place)',
    )
    expect(await loadChapterVocabulary(dir, 1, testCtx(), {})).toBe(
      'Recurring terms (translate the same way every time):\nArin (proper, ×3)',
    )
  })

  it('missing files: empty block, one warn per slot, no throw', async () => {
    const ctx = testCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mt-slots-empty-'))
    expect(await loadChapterEntities(dir, 2, ctx, {})).toBe('')
    expect(await loadChapterVocabulary(dir, 2, ctx, {})).toBe('')
    expect(ctx.run.logger.warn).toHaveBeenCalledTimes(2)
    expect(ctx.run.logger.warn.mock.calls[0]?.[0]).toMatch(/chapter 2.*missing ner slot/)
    expect(ctx.run.logger.warn.mock.calls[1]?.[0]).toMatch(/chapter 2.*missing vocab slot/)
  })

  it('strict mode turns the missing-slot warn into a throw', async () => {
    const ctx = testCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mt-slots-strict-'))
    await expect(
      loadChapterEntities(dir, 1, ctx, { MT_TRANSLATE_SLOTS_STRICT: '1' }),
    ).rejects.toThrow(/missing ner slot/)
    expect(ctx.run.logger.warn).not.toHaveBeenCalled()
  })

  it('present but unparsable JSON throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-slots-bad-'))
    mkdirSync(join(dir, 'schema'), { recursive: true })
    writeFileSync(join(dir, 'schema', 'chapter1.entities.json'), '{ not json')
    writeFileSync(join(dir, 'schema', 'vocabulary.json'), '{"nope":1}')
    await expect(loadChapterEntities(dir, 1, testCtx(), {})).rejects.toThrow(
      /failed to parse ner slot/,
    )
    await expect(loadChapterVocabulary(dir, 1, testCtx(), {})).rejects.toThrow(
      /failed to parse vocab slot/,
    )
  })
})

describe('chapter body translator slots', () => {
  function slotDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mt-body-slots-'))
    mkdirSync(join(dir, 'schema'), { recursive: true })
    writeFileSync(join(dir, 'glossary.json'), JSON.stringify({ terms: [] }))
    writeFileSync(join(dir, 'schema', 'chapter1.summary.md'), '# T\n\n## Summary\n\nShort.\n')
    writeFileSync(
      join(dir, 'schema', 'chapter1.entities.json'),
      JSON.stringify({
        n: 1,
        entities: [{ id: 'arin', name: 'Arin', kind: 'character', count: 2 }],
      }),
    )
    writeFileSync(
      join(dir, 'schema', 'vocabulary.json'),
      JSON.stringify({
        version: 1,
        params: {},
        terms: [
          { term: 'Arin', n: 1, count: 2, df: 1, chapters: [1], capRatio: 1, kind: 'proper' },
        ],
      }),
    )
    return dir
  }

  function bodyRun(dir: string, slots: ('summary' | 'glossary' | 'ner' | 'vocab')[]) {
    const systems: string[] = []
    const call = async (input: { systemPrompt: string }) => {
      systems.push(input.systemPrompt)
      return { content: 'Привет', model: 'm', tokens: 0, promptTokens: 0, completionTokens: 0 }
    }
    const body = createChapterBodyTranslator({
      call: call as never,
      chaptersDir: dir,
      log: false,
      slots,
    })
    const env = {
      ...createExchange(
        { text: '# Глава 1' },
        { variables: [variable('chapters', ['# Chapter 1\n\nHello there.'])] },
      ),
      items: [{ text: '# Глава 1' }],
    }
    return body.invoke(env, testCtx()).then(() => systems)
  }

  it('injects every slot by default', async () => {
    const systems = await bodyRun(slotDir(), [...TRANSLATE_SLOTS])
    expect(systems).toHaveLength(1)
    expect(systems[0]).toContain('Short.')
    expect(systems[0]).toContain('Named entities in this chapter')
    expect(systems[0]).toContain('Recurring terms (translate the same way every time)')
  })

  it('slots: [summary] disables the entity and vocabulary blocks', async () => {
    const systems = await bodyRun(slotDir(), ['summary'])
    expect(systems[0]).toContain('Short.')
    expect(systems[0]).not.toContain('Named entities')
    expect(systems[0]).not.toContain('Recurring terms')
  })
})

afterEach(() => vi.restoreAllMocks())
