import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Glossary, GlossaryTerm } from '@mt/tools'
import { inferRuGrammar } from '@mt/tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type PreprocessReport,
  chapterNeedsWork,
  digitMultiset,
  genderPins,
  loadPreprocessGlossary,
  pinnedGender,
  readPreprocessPlan,
  serializePreprocessReport,
} from './preprocess.js'

let root: string

function chaptersDir(): string {
  return join(root, 'chapters')
}

function writeQuality(value: unknown): void {
  mkdirSync(join(chaptersDir(), 'schema'), { recursive: true })
  writeFileSync(join(chaptersDir(), 'schema', 'quality.json'), JSON.stringify(value), 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bookkit-preprocess-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readPreprocessPlan', () => {
  it('defaults to a translate no-op when quality.json is missing', () => {
    const plan = readPreprocessPlan({ root, env: {} })
    expect(plan).toMatchObject({ verdict: 'translate', forced: false, skip: true })
    expect(plan.chapters.size).toBe(0)
  })

  it('reads the verdict and per-chapter gate results', () => {
    writeQuality({
      verdict: 'preprocess',
      chapters: [{ n: 1, pass: true }, { n: 2, pass: false }, { n: 3 }],
    })
    const plan = readPreprocessPlan({ root, env: {} })
    expect(plan).toMatchObject({ verdict: 'preprocess', forced: false, skip: false })
    expect([...plan.chapters.entries()]).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ])
  })

  it('honours MT_FORCE_BRANCH=preprocess even on a translate verdict', () => {
    writeQuality({ verdict: 'translate', chapters: [{ n: 1, pass: true }] })
    const plan = readPreprocessPlan({ root, env: { MT_FORCE_BRANCH: 'preprocess' } })
    expect(plan).toMatchObject({ verdict: 'translate', forced: true, skip: false })
  })

  it('honours a custom forceBranchEnv option', () => {
    writeQuality({ verdict: 'translate' })
    const plan = readPreprocessPlan({
      root,
      env: { MY_FORCE: 'preprocess' },
      forceBranchEnv: 'MY_FORCE',
    })
    expect(plan.forced).toBe(true)
    expect(plan.skip).toBe(false)
  })

  it('falls back to translate when the file is unreadable JSON', () => {
    mkdirSync(join(chaptersDir(), 'schema'), { recursive: true })
    writeFileSync(join(chaptersDir(), 'schema', 'quality.json'), '{not json', 'utf-8')
    const plan = readPreprocessPlan({ root, env: {} })
    expect(plan).toMatchObject({ verdict: 'translate', skip: true })
  })
})

describe('chapterNeedsWork', () => {
  it('processes failed, missing and unknown chapters; skips passing ones', () => {
    const plan = {
      verdict: 'preprocess' as const,
      forced: false,
      skip: false,
      chapters: new Map([
        [1, true],
        [2, false],
      ]),
    }
    expect(chapterNeedsWork(plan, 1)).toBe(false)
    expect(chapterNeedsWork(plan, 2)).toBe(true)
    expect(chapterNeedsWork(plan, 3)).toBe(true)
    expect(chapterNeedsWork({ ...plan, forced: true }, 1)).toBe(true)
  })
})

describe('loadPreprocessGlossary', () => {
  it('returns an empty glossary when the file is missing or invalid', () => {
    expect(loadPreprocessGlossary(root)).toEqual({ terms: [] })
    writeFileSync(join(root, 'glossary.json'), '[]', 'utf-8')
    expect(loadPreprocessGlossary(root)).toEqual({ terms: [] })
  })

  it('reads terms from glossary.json', () => {
    writeFileSync(
      join(root, 'glossary.json'),
      JSON.stringify({ terms: [{ id: 'nadia' }] }),
      'utf-8',
    )
    expect(loadPreprocessGlossary(root).terms).toHaveLength(1)
  })
})

describe('digitMultiset', () => {
  it('is order-independent and ignores non-digits', () => {
    expect(digitMultiset('a1 b2 c1')).toBe('112')
    expect(digitMultiset('21')).toBe(digitMultiset('12'))
    expect(digitMultiset('no digits')).toBe('')
  })
})

describe('serializePreprocessReport', () => {
  it('sorts chapters, fixes field order and appends one newline', () => {
    const report: PreprocessReport = {
      version: 1,
      verdict: 'preprocess',
      forced: false,
      chapters: [
        { n: 2, llmFixed: true, linesChanged: 3, digitsEqual: true, calls: 1 },
        { n: 1, llmFixed: false, linesChanged: 0, digitsEqual: true, calls: 0 },
      ],
    }
    const text = serializePreprocessReport(report)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
    const parsed = JSON.parse(text) as PreprocessReport
    expect(parsed).toEqual({
      version: 1,
      verdict: 'preprocess',
      forced: false,
      chapters: [
        { n: 1, llmFixed: false, linesChanged: 0, digitsEqual: true, calls: 0 },
        { n: 2, llmFixed: true, linesChanged: 3, digitsEqual: true, calls: 1 },
      ],
    })
    expect(Object.keys(parsed.chapters[0] ?? {})).toEqual([
      'n',
      'llmFixed',
      'linesChanged',
      'digitsEqual',
      'calls',
    ])
  })
})

function termOf(overrides: Partial<GlossaryTerm>): GlossaryTerm {
  return {
    id: 'nadia',
    term: 'Nadia',
    type: 'character',
    count: 1,
    firstChapter: 1,
    ru: null,
    aliases: [],
    ...overrides,
  }
}

describe('genderPins / pinnedGender', () => {
  it('pins the gender of a character present in the chapter', () => {
    const glossary: Glossary = { terms: [termOf({ ruGrammar: inferRuGrammar('Надя') })] }
    const pins = genderPins(glossary, 1, 'Nadia walked in.')
    expect(pins).toEqual([{ term: 'Nadia', gender: 'f', label: 'female' }])
  })

  it('leaves characters without gender data out', () => {
    expect(genderPins({ terms: [termOf({})] }, 1, 'Nadia walked in.')).toEqual([])
  })

  it('omits characters that do not occur in the chapter text', () => {
    const glossary: Glossary = { terms: [termOf({ ruGrammar: inferRuGrammar('Надя') })] }
    expect(genderPins(glossary, 1, 'Someone else walked in.')).toEqual([])
  })

  it('takes the effective gender from genderTimeline at the chapter', () => {
    const term = termOf({
      ruGrammar: inferRuGrammar('Иван'),
      genderTimeline: [{ chapter: 3, value: 'f', evidence: { chapter: 3, quote: 'she' } }],
    })
    expect(pinnedGender(term, 2)).toBe('m')
    expect(pinnedGender(term, 3)).toBe('f')
  })
})
