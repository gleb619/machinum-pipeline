import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type PreprocessReport,
  digitMultiset,
  genderPins,
  pinnedGender,
  preprocessSystemPrompt,
  preprocessText,
} from '@mt/tools'
import {
  type ChatCompletionInput,
  type ChatCompletionOutput,
  type Glossary,
  type GlossaryTerm,
  LLM_TYPO_FIX_PROMPT,
  type SchemaDocLlmCall,
  inferRuGrammar,
} from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SKIP_LOG } from '../lib/preprocess.js'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const SCHEMA_DIR = join(CHAPTERS, 'schema')
const QUALITY_FILE = join(SCHEMA_DIR, 'quality.json')
const STATS_FILE = join(SCHEMA_DIR, 'stats.json')
const MAP_FILE = join(SCHEMA_DIR, 'chapter-map.json')
const SPLIT_DIR = join(CHAPTERS, 'split')
const CLEAN_DIR = join(CHAPTERS, 'clean')
const REPORT_FILE = join(SCHEMA_DIR, 'preprocess-report.json')
const BOOK_DIR = join(SAMPLE_DIR, '..', '..', 'books', 'book2')
const CHAPTER_COUNT = 21

/** A backend that throws if it is ever used: the no-op branch must not resolve a model. */
const NO_LLM_ENV = {
  MT_LLM_TOOL: 'router',
  MT_LLM_MODEL: 'stub:free',
  MT_ROUTER_URL: 'http://127.0.0.1:1',
}

const FORCED_ENV = { MT_FORCE_BRANCH: 'preprocess' }

const TEXT = '# Chapter 1: Test\n\nHe recieved the letter.\nShe waited outside.\n'

let hasFailure = false

function parse(text: string): PreprocessReport {
  return JSON.parse(text) as PreprocessReport
}

function scripted(answer: (input: ChatCompletionInput) => string): SchemaDocLlmCall {
  return async (input): Promise<ChatCompletionOutput> => ({
    content: answer(input),
    model: 'mock',
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    finishReason: 'stop',
  })
}

function lastUser(input: ChatCompletionInput): string {
  return [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
}

async function cleanAll(): Promise<void> {
  await clean(
    QUALITY_FILE,
    STATS_FILE,
    MAP_FILE,
    SPLIT_DIR,
    CLEAN_DIR,
    REPORT_FILE,
    join(SAMPLE_DIR, '.mt'),
  )
}

beforeAll(async () => {
  await cleanAll()
  run('normalization.ts', { pipeline: 'stats', timeout: 120_000 })
  run('normalization.ts', { pipeline: 'split', timeout: 120_000 })
  run('preparation.ts', { pipeline: 'quality', timeout: 120_000 })
}, 300_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanAll()
})

describe('preprocess branch decision', () => {
  it('does nothing on a translate verdict: no LLM call, no file', async () => {
    await clean(CLEAN_DIR, REPORT_FILE)
    const output = run('preparation.ts', {
      pipeline: 'preprocess',
      env: NO_LLM_ENV,
      timeout: 120_000,
    })
    const skipLines = output.split('\n').filter((line) => line.includes(SKIP_LOG))
    expect(skipLines).toHaveLength(1)
    expect(existsSync(CLEAN_DIR)).toBe(false)
    expect(existsSync(REPORT_FILE)).toBe(false)
  })
})

describe('forced preprocess on a clean book', () => {
  it('writes every chapter with the source line count and digit multiset', async () => {
    await clean(CLEAN_DIR, REPORT_FILE)
    run('preparation.ts', { pipeline: 'preprocess', env: FORCED_ENV, timeout: 120_000 })

    const files = (await readdir(CLEAN_DIR)).filter((file) => file.endsWith('.md')).sort()
    expect(files).toHaveLength(CHAPTER_COUNT)

    for (let n = 1; n <= CHAPTER_COUNT; n++) {
      const cleaned = await readFile(join(CLEAN_DIR, `chapter${n}.md`), 'utf-8')
      const source = await readFile(join(BOOK_DIR, `chapter-${n}.en.md`), 'utf-8')
      expect(cleaned.split('\n').length, `chapter ${n} line count`).toBe(source.split('\n').length)
      expect(digitMultiset(cleaned), `chapter ${n} digits`).toBe(digitMultiset(source))
    }

    const report = parse(await readFile(REPORT_FILE, 'utf-8'))
    expect(report.version).toBe(1)
    expect(report.verdict).toBe('translate')
    expect(report.forced).toBe(true)
    expect(report.chapters.map((chapter) => chapter.n)).toEqual(
      Array.from({ length: CHAPTER_COUNT }, (_, index) => index + 1),
    )
    expect(report.chapters.every((chapter) => chapter.digitsEqual)).toBe(true)
    expect(report.chapters.every((chapter) => chapter.calls === 1)).toBe(true)
  }, 120_000)

  it('reruns the report byte-identically', async () => {
    await clean(CLEAN_DIR, REPORT_FILE)
    run('preparation.ts', { pipeline: 'preprocess', env: FORCED_ENV, timeout: 120_000 })
    const first = await readFile(REPORT_FILE, 'utf-8')
    run('preparation.ts', { pipeline: 'preprocess', env: FORCED_ENV, timeout: 120_000 })
    expect(await readFile(REPORT_FILE, 'utf-8')).toBe(first)
  }, 180_000)
})

describe('one chapter', () => {
  it('applies a reply with the right line count (one changed line)', async () => {
    const call = scripted((input) => lastUser(input).replace('recieved', 'received'))
    const row = await preprocessText({ n: 1, markdown: TEXT, call })
    expect(row.llmFixed).toBe(true)
    expect(row.linesChanged).toBe(1)
    expect(row.calls).toBe(1)
    expect(row.text).toBe(TEXT.replace('recieved', 'received'))
  })

  it('rejects a reply with a different line count and keeps the original', async () => {
    const call = scripted(() => '# Chapter 1: Test')
    const row = await preprocessText({ n: 1, markdown: TEXT, call })
    expect(row.llmFixed).toBe(false)
    expect(row.linesChanged).toBe(0)
    expect(row.digitsEqual).toBe(true)
    expect(row.text).toBe(TEXT)
  })

  it('keeps the digit multiset of a scripted reply', async () => {
    const call = scripted((input) => lastUser(input).replace('letter', 'note'))
    const row = await preprocessText({ n: 1, markdown: TEXT, call })
    expect(row.llmFixed).toBe(true)
    expect(row.linesChanged).toBe(1)
    expect(digitMultiset(row.text)).toBe(digitMultiset(TEXT))
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

describe('gender normalisation prompt', () => {
  it('merges the pinned gender of a present character into the typo prompt', () => {
    const glossary: Glossary = {
      terms: [termOf({ ruGrammar: inferRuGrammar('Надя') })],
    }
    const pins = genderPins(glossary, 1, 'Nadia walked in.')
    expect(pins).toEqual([{ term: 'Nadia', gender: 'f', label: 'female' }])
    const prompt = preprocessSystemPrompt(pins)
    expect(prompt).toContain(LLM_TYPO_FIX_PROMPT)
    expect(prompt).toContain('- Nadia: female (f)')
  })

  it('leaves the typo prompt untouched without pinned gender data', () => {
    const glossary: Glossary = { terms: [termOf({})] }
    const pins = genderPins(glossary, 1, 'Nadia walked in.')
    expect(pins).toEqual([])
    expect(preprocessSystemPrompt(pins)).toBe(LLM_TYPO_FIX_PROMPT)
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
