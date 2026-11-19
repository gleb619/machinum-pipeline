import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExchange, getVariable } from '@mt/core'
import type { MdOutputEntry, ToolContext } from '@mt/core'
import { MD_OUTPUTS_VARIABLE } from '@mt/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GLOSSARY_INDEX_FILE,
  type GlossaryIndexInput,
  PRIOR_TERMS_HEADER,
  PRIOR_TERMS_MAX,
  buildGlossaryIndex,
  createGlossaryIndexTool,
  indexableTerms,
  priorTermsEnabled,
  priorTermsMax,
  renderPriorTerms,
  serializeGlossaryIndex,
} from './glossary-index.js'

const tempDirs: string[] = []

function fixture(withGlossary = true): {
  chaptersDir: string
  glossary: GlossaryIndexInput
} {
  const chaptersDir = mkdtempSync(join(tmpdir(), 'mt-glossary-index-'))
  tempDirs.push(chaptersDir)
  mkdirSync(join(chaptersDir, 'en'), { recursive: true })
  writeFileSync(
    join(chaptersDir, 'en', 'chapter1.md'),
    '# Chapter 1\n\nArin walked in. Arin left. Ash watched.\n',
  )
  writeFileSync(join(chaptersDir, 'en', 'chapter2.md'), '# Chapter 2\n\nArin met Bren.\n')
  writeFileSync(join(chaptersDir, 'en', 'chapter3.md'), '# Chapter 3\n\nCora found Bren.\n')
  const glossary: GlossaryIndexInput = {
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
      {
        id: 'bren',
        term: 'Bren',
        type: 'character',
        count: 2,
        firstChapter: 2,
        ru: 'Брен',
        aliases: [],
      },
      {
        id: 'cora',
        term: 'Cora',
        type: 'place',
        count: 1,
        firstChapter: 3,
        ru: 'Кора',
        aliases: [],
      },
      {
        id: 'ghost',
        term: 'Ghost',
        type: 'character',
        count: 0,
        firstChapter: null,
        ru: 'Призрак',
        aliases: [],
      },
      {
        id: 'ash',
        term: 'Ash',
        type: 'character',
        count: 1,
        firstChapter: 1,
        ru: 'Эш',
        aliases: [],
        ignored: true,
      },
    ],
  }
  if (withGlossary) {
    writeFileSync(join(chaptersDir, 'glossary.json'), JSON.stringify(glossary, null, 2))
  }
  return { chaptersDir, glossary }
}

function ctxStub(logs: string[] = []): ToolContext {
  const push = (message: string) => logs.push(message)
  return {
    run: {
      global: { env: {}, settings: {} },
      logger: { info: push, debug: push, warn: push, error: push },
    },
  } as unknown as ToolContext
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('indexableTerms', () => {
  it('keeps approved, non-ignored terms (even ones never found in the text)', () => {
    const { glossary } = fixture()
    expect(indexableTerms(glossary).map((term) => term.term)).toEqual([
      'Arin',
      'Bren',
      'Cora',
      'Ghost',
    ])
  })

  it('honours the book-wide ignored list', () => {
    const { glossary } = fixture()
    expect(indexableTerms({ ...glossary, ignored: ['cora'] }).map((term) => term.term)).toEqual([
      'Arin',
      'Bren',
      'Ghost',
    ])
  })
})

describe('buildGlossaryIndex', () => {
  it('maps every active term to the chapters it occurs in', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    const byTerm = (term: string) => index.terms.find((entry) => entry.term === term)

    expect(byTerm('Arin')).toMatchObject({
      id: 'arin',
      type: 'character',
      ru: 'Арин',
      chapters: [1, 2],
      firstChapter: 1,
      count: 3,
    })
    expect(byTerm('Bren')).toMatchObject({ chapters: [2, 3], firstChapter: 2, count: 2 })
    expect(byTerm('Cora')).toMatchObject({ chapters: [3], firstChapter: 3, count: 1 })
  })

  it('drops hallucinated (count 0) and ignored terms', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    expect(index.terms.map((term) => term.term)).toEqual(['Arin', 'Bren', 'Cora'])
  })

  it('is deterministic across runs', async () => {
    const { chaptersDir, glossary } = fixture()
    const first = await buildGlossaryIndex({ chaptersDir, glossary })
    const second = await buildGlossaryIndex({ chaptersDir, glossary })
    expect(second).toEqual(first)
  })
})

describe('renderPriorTerms', () => {
  it('renders nothing for chapter 1', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    expect(renderPriorTerms(index, 1)).toBe('')
  })

  it('renders only terms first seen before the chapter', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    const block = renderPriorTerms(index, 2)
    expect(block.startsWith(PRIOR_TERMS_HEADER)).toBe(true)
    expect(block).toContain('- Arin → Арин')
    expect(block).not.toContain('Bren')
    expect(block).not.toContain('Cora')
  })

  it('respects the term cap', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    const block = renderPriorTerms(index, 4, { maxTerms: 2 })
    expect(block.split('\n')).toHaveLength(3)
    expect(block).toContain('Arin')
    expect(block).toContain('Bren')
    expect(block).not.toContain('Cora')
  })

  it('renders nothing when the cap is zero', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    expect(renderPriorTerms(index, 4, { maxTerms: 0 })).toBe('')
  })
})

describe('prior-terms env', () => {
  it('reads MT_PRIOR_TERMS_MAX with the 40-term default', () => {
    expect(priorTermsMax({})).toBe(PRIOR_TERMS_MAX)
    expect(priorTermsMax({ MT_PRIOR_TERMS_MAX: '7' })).toBe(7)
    expect(priorTermsMax({ MT_PRIOR_TERMS_MAX: 'nope' })).toBe(PRIOR_TERMS_MAX)
  })

  it('lets MT_PRIOR_TERMS=0 disable the block', () => {
    expect(priorTermsEnabled({})).toBe(true)
    expect(priorTermsEnabled({ MT_PRIOR_TERMS: '0' })).toBe(false)
  })
})

describe('serializeGlossaryIndex', () => {
  it('keeps short chapter arrays inline and ends with one newline', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    const json = serializeGlossaryIndex(index)
    expect(json).toContain('"chapters": [1, 2]')
    expect(json.endsWith('\n')).toBe(true)
  })
})

describe('createGlossaryIndexTool', () => {
  it('emits the index as an md output instead of writing a file', async () => {
    const { chaptersDir } = fixture()
    const tool = createGlossaryIndexTool({ chaptersDir })
    const out = await tool.invoke(createExchange<unknown>(''), ctxStub())
    const outputs = getVariable<MdOutputEntry[]>(out, MD_OUTPUTS_VARIABLE) ?? []
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      name: 'glossary-index',
      subdir: '',
      filename: GLOSSARY_INDEX_FILE,
    })
    const parsed = JSON.parse(outputs[0]?.content ?? '{}')
    expect(parsed.terms.map((term: { term: string }) => term.term)).toEqual([
      'Arin',
      'Bren',
      'Cora',
    ])
  })

  it('honours a custom index filename', async () => {
    const { chaptersDir } = fixture()
    const tool = createGlossaryIndexTool({ chaptersDir, indexFile: 'terms.json' })
    const out = await tool.invoke(createExchange<unknown>(''), ctxStub())
    const outputs = getVariable<MdOutputEntry[]>(out, MD_OUTPUTS_VARIABLE) ?? []
    expect(outputs[0]?.filename).toBe('terms.json')
  })

  it('logs and emits nothing when glossary.json is missing', async () => {
    const { chaptersDir } = fixture(false)
    const logs: string[] = []
    const tool = createGlossaryIndexTool({ chaptersDir })
    const out = await tool.invoke(createExchange<unknown>(''), ctxStub(logs))
    expect(logs).toContain('index: no glossary')
    expect(getVariable(out, MD_OUTPUTS_VARIABLE)).toBeUndefined()
  })
})
