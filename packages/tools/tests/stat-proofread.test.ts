import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import type { Glossary } from '../src/normalization/term-tagger.js'
import {
  StatProofreadError,
  buildProofreadReport,
  checkTermConsistency,
  checkTranslatedShare,
  createStatProofread,
  proofreadFeedback,
} from '../src/verification/stat-proofread.js'

const ctx = {} as ToolContext

const glossary: Glossary = {
  terms: [
    {
      id: 'hero',
      term: 'Aelwyn',
      type: 'character',
      count: 5,
      firstChapter: 1,
      ru: 'Аэлвин',
      aliases: ['Ael'],
    },
    {
      id: 'place',
      term: 'Everspring',
      type: 'place',
      count: 3,
      firstChapter: 1,
      ru: 'Эверспринг',
      aliases: [],
    },
    {
      id: 'untranslated',
      term: 'UntranslatedTerm',
      type: 'term',
      count: 1,
      firstChapter: 2,
      ru: null,
      aliases: [],
    },
  ],
}

const cleanRu = 'Аэлвин прибыл в Эверспринг. Здесь было холодно.'
const inconsistentRu = 'Aelwyn прибыл в Everspring. Здесь было холодно.'
const mostlyLatin = 'Aelwyn arrived in Everspring. It was cold there.'

describe('checkTermConsistency', () => {
  it('passes when no glossary terms appear', () => {
    expect(checkTermConsistency('Просто текст.', { terms: [] })).toEqual([])
  })

  it('flags source terms left in the translation', () => {
    const issues = checkTermConsistency(inconsistentRu, glossary)
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.term).sort()).toEqual(['Aelwyn', 'Everspring'])
    const aelwyn = issues.find((i) => i.term === 'Aelwyn')
    expect(aelwyn?.expected).toBe('Аэлвин')
    expect(aelwyn?.detail).toContain('Аэлвин')
  })

  it('flags aliases too', () => {
    const issues = checkTermConsistency('Ael улыбнулся.', glossary)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.term).toBe('Ael')
    expect(issues[0]?.expected).toBe('Аэлвин')
  })

  it('accepts correct RU forms', () => {
    expect(checkTermConsistency(cleanRu, glossary)).toEqual([])
  })

  it('ignores terms without a RU translation', () => {
    expect(checkTermConsistency('UntranslatedTerm here.', glossary)).toEqual([])
  })
})

describe('checkTranslatedShare', () => {
  it('reports high Cyrillic share for clean RU text', () => {
    const r = checkTranslatedShare(cleanRu)
    expect(r.cyrillicShare).toBeGreaterThan(0.5)
    expect(r.untranslatedShare).toBe(0)
    expect(r.issues).toEqual([])
  })

  it('flags low Cyrillic share', () => {
    const r = checkTranslatedShare(mostlyLatin, { minCyrillicShare: 0.3 })
    expect(r.issues.some((i) => i.kind === 'low-cyrillic')).toBe(true)
    expect(r.cyrillicShare).toBe(0)
  })

  it('flags high untranslated share', () => {
    const r = checkTranslatedShare(mostlyLatin, { maxUntranslatedShare: 0.2 })
    expect(r.issues.some((i) => i.kind === 'untranslated-segment')).toBe(true)
    expect(r.untranslatedShare).toBeGreaterThan(0.9)
  })

  it('respects boundary thresholds', () => {
    const halfHalf = 'ab аб'
    const r = checkTranslatedShare(halfHalf, { minCyrillicShare: 0.5, maxUntranslatedShare: 0.5 })
    expect(r.issues).toEqual([])
    expect(r.cyrillicShare).toBe(0.5)
    expect(r.untranslatedShare).toBe(0.5)
  })
})

describe('buildProofreadReport', () => {
  it('marks a clean text ok', () => {
    const report = buildProofreadReport(cleanRu, { glossary })
    expect(report.ok).toBe(true)
    expect(report.issues).toEqual([])
    expect(report.cyrillicShare).toBeGreaterThan(0)
  })

  it('reports both term and share issues', () => {
    const report = buildProofreadReport(inconsistentRu, { glossary, maxUntranslatedShare: 0.2 })
    expect(report.ok).toBe(false)
    expect(report.issues.map((i) => i.kind).sort()).toEqual([
      'term-consistency',
      'term-consistency',
      'untranslated-segment',
    ])
  })
})

describe('proofreadFeedback', () => {
  it('has the measured numbers and issue details', () => {
    const report = buildProofreadReport(mostlyLatin, { maxUntranslatedShare: 0.2 })
    const fb = proofreadFeedback(report)
    expect(fb).toContain(`Cyrillic share ${report.cyrillicShare}`)
    expect(fb).toContain(`untranslated share ${report.untranslatedShare}`)
    expect(fb).toContain('issue(s)')
    expect(fb).toContain('low-cyrillic')
    expect(fb).toContain('untranslated-segment')
  })
})

describe('createStatProofread tool', () => {
  it('writes the proofread variable for clean text', async () => {
    const out = await createStatProofread({ glossary }).invoke(
      { id: 'ex-test', variables: [], item: cleanRu, meta: {} },
      ctx,
    )
    expect(getVariable<{ ok: boolean }>(out, 'proofread')?.ok).toBe(true)
    expect(out.item).toBe(cleanRu)
  })

  it('flags an injected inconsistency with exact issue', async () => {
    const out = await createStatProofread({ glossary }).invoke(
      { id: 'ex-test', variables: [], item: inconsistentRu, meta: {} },
      ctx,
    )
    const report = getVariable<{
      ok: boolean
      issues: Array<{ kind: string; term?: string }>
    }>(out, 'proofread') as { ok: boolean; issues: Array<{ kind: string; term?: string }> }
    expect(report.ok).toBe(false)
    const termIssues = report.issues.filter((i) => i.kind === 'term-consistency')
    expect(termIssues).toHaveLength(2)
    expect(termIssues.map((i) => i.term).sort()).toEqual(['Aelwyn', 'Everspring'])
  })

  it('handles share-threshold boundary cases', async () => {
    const half = 'ab аб'
    const out = await createStatProofread({
      minCyrillicShare: 0.5,
      maxUntranslatedShare: 0.5,
    }).invoke({ id: 'ex-test', variables: [], item: half, meta: {} }, ctx)
    expect(getVariable<{ ok: boolean }>(out, 'proofread')?.ok).toBe(true)
  })

  it('throws a retryable StatProofreadError in fix:llm mode', async () => {
    const run = createStatProofread({ glossary, fix: 'llm' }).invoke(
      { id: 'ex-test', variables: [], item: inconsistentRu, meta: {} },
      ctx,
    )
    await expect(run).rejects.toBeInstanceOf(StatProofreadError)
    await expect(run).rejects.toMatchObject({
      retryable: true,
      feedback: expect.stringContaining('Cyrillic share'),
    })
  })

  it('does not mutate text by default', async () => {
    const out = await createStatProofread({ glossary }).invoke(
      { id: 'ex-test', variables: [], item: inconsistentRu, meta: {} },
      ctx,
    )
    expect(out.item).toBe(inconsistentRu)
  })
})
