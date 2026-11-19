import type { ToolContext } from '@mt/core'
import { createExchange, getVariable, setVariable } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { sortChapters, writeGlossary, writeSummaries, writeTitles } from './book-outputs.js'

const ctx = {} as ToolContext

interface MdOutput {
  name: string
  subdir?: string
  filename: string
  content: string
}

function outputsOf(exchange: { variables: unknown }): MdOutput[] {
  return getVariable<MdOutput[]>(exchange as never, 'mdOutputs') ?? []
}

describe('writeSummaries', () => {
  const markdown = `# Chapter 1: Start\n\n${Array.from({ length: 60 }, () => 'word').join(' ')}`

  it('emits one schema summary file from summaryByItem', async () => {
    const env = setVariable(createExchange(markdown), 'summaryByItem', [
      'The first event happened today. Then the second event happened.',
    ])
    const out = await writeSummaries.invoke(env, ctx)
    const [entry] = outputsOf(out)
    expect(entry?.filename).toBe('chapter1.summary.md')
    expect(entry?.subdir).toBe('schema')
    expect(entry?.content).toBe(
      '# Chapter 1: Start\n\n## Summary\n\n- The first event happened today.\n- Then the second event happened.\n',
    )
  })

  it('uses the single `summary` variable for a one-chapter batch', async () => {
    const env = setVariable(createExchange(markdown), 'summary', 'Only one sentence.')
    const out = await writeSummaries.invoke(env, ctx)
    expect(outputsOf(out)[0]?.content).toContain('- Only one sentence.')
  })
})

describe('writeGlossary', () => {
  it('emits glossary.json from the glossaryJson variable', async () => {
    const env = setVariable(createExchange(''), 'glossaryJson', '{"terms":[]}\n')
    const out = await writeGlossary.invoke(env, ctx)
    const [entry] = outputsOf(out)
    expect(entry).toMatchObject({
      filename: 'glossary.json',
      subdir: '',
      content: '{"terms":[]}\n',
    })
  })
})

describe('writeTitles', () => {
  it('emits titles.json pairing EN headings with translated ones', async () => {
    const chapters = ['# Chapter 1: Start', '# Chapter 2: End']
    const translated = [
      { text: '# Глава 1: Начало', titleTranslated: true },
      { text: '# Глава 2: Конец', titleTranslated: true },
    ]
    const env = setVariable(createExchange(translated), 'chapters', chapters)
    const out = await writeTitles.invoke(env, ctx)
    const [entry] = outputsOf(out)
    expect(entry?.filename).toBe('titles.json')
    expect(JSON.parse(entry?.content ?? '{}')).toEqual({
      '1': { en: 'Chapter 1: Start', ru: 'Глава 1: Начало' },
      '2': { en: 'Chapter 2: End', ru: 'Глава 2: Конец' },
    })
  })
})

describe('sortChapters', () => {
  it('sorts EN and RU headings by chapter number', async () => {
    const env = createExchange(['# Chapter 10: Ten', '# Глава 2: Two', '# Chapter 1: One'])
    const out = await sortChapters.invoke(env, ctx)
    expect(out.item).toEqual(['# Chapter 1: One', '# Глава 2: Two', '# Chapter 10: Ten'])
  })
})
