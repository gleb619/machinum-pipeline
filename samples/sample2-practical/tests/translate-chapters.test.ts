import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lintLineParity, translateBlockLines } from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, lintParity, run } from './helpers.js'

const EN_DIR = join(CHAPTERS, 'en')
const RU_DIR = join(CHAPTERS, 'ru')
const SCHEMA_DIR = join(CHAPTERS, 'schema')
const GLOSSARY = join(CHAPTERS, 'glossary.json')
const TITLES = join(CHAPTERS, 'titles.json')
const PROMPT_LOG = join(SAMPLE_DIR, '.mt-translate-prompts.jsonl')

let hasFailure = false

async function cleanup(): Promise<void> {
  await clean(RU_DIR, SCHEMA_DIR, GLOSSARY, TITLES, EN_DIR, PROMPT_LOG, join(SAMPLE_DIR, '.mt'))
}

beforeAll(async () => {
  await cleanup()
  const scoped = { MT_ONLY_CHAPTERS: '1,2' }
  run('normalization.ts', { pipeline: 'extractEn', env: scoped })
  run('preparation.ts', { pipeline: 'summary', env: scoped })
  run('preparation.ts', { pipeline: 'glossary', env: scoped })
  run('translation.ts', {
    pipeline: 'translateChapters',
    env: { ...scoped, MT_TRANSLATE_PROMPT_LOG: PROMPT_LOG },
  })
}, 120_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('translate-chapters', () => {
  it('writes one RU chapter per selected chapter', async () => {
    expect((await readdir(RU_DIR)).filter((file) => file.endsWith('.md')).sort()).toEqual([
      'chapter1.md',
      'chapter2.md',
    ])
  })

  it('keeps EN/RU line parity', async () => {
    for (const name of ['chapter1.md', 'chapter2.md']) {
      const en = await readFile(join(EN_DIR, name), 'utf-8')
      const ru = await readFile(join(RU_DIR, name), 'utf-8')
      const report = lintLineParity(en, ru)
      expect(report.ok, JSON.stringify(report.issues.slice(0, 3))).toBe(true)
      expect(report.cyrillicRatio).toBeGreaterThan(0.5)
    }
  })

  it('writes translated titles for the same chapters', async () => {
    const titles = JSON.parse(await readFile(TITLES, 'utf-8')) as Record<
      string,
      { en: string; ru: string }
    >
    expect(Object.keys(titles).sort()).toEqual(['1', '2'])
    expect(titles['1']?.ru).toBe('слово 1: слово слово')
    expect((await readFile(join(RU_DIR, 'chapter1.md'), 'utf-8')).split('\n')[0]).toBe(
      '# слово 1: слово слово',
    )
  })

  it('injects the glossary and the chapter summary into the prompts', async () => {
    const prompts = (await readFile(PROMPT_LOG, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { system: string; user: string })
    const nadia = prompts.find((prompt) => prompt.user.includes('Nadia'))
    if (!nadia) throw new Error('no prompt for a Nadia Okonkwo line')
    expect(nadia.system).toContain('Nadia')
    expect(nadia.system).toContain('Chapter summary (context only')
  })

  it('passes the standalone parity linter', () => {
    const result = lintParity(EN_DIR, RU_DIR)
    expect(result.stdout).toContain('OK: 2 chapter(s)')
    expect(result.status).toBe(0)
  })

  it('supports a retry after a bad mock reply', async () => {
    await clean(RU_DIR, TITLES, PROMPT_LOG, join(SAMPLE_DIR, '.mt'))
    run('translation.ts', {
      pipeline: 'translateChapters',
      env: {
        MT_ONLY_CHAPTERS: '1',
        MT_MOCK_FLAKY: '1',
        MT_TRANSLATE_PROMPT_LOG: PROMPT_LOG,
      },
    })
    expect((await readdir(RU_DIR)).filter((file) => file.endsWith('.md'))).toEqual(['chapter1.md'])
    const prompts = (await readFile(PROMPT_LOG, 'utf-8')).trim().split('\n')
    expect(prompts.length).toBeGreaterThan(3)
  }, 60_000)

  it('translates the whole book in block mode within the request budget', async () => {
    await clean(RU_DIR, TITLES, PROMPT_LOG, EN_DIR, join(SAMPLE_DIR, '.mt'))
    run('normalization.ts', { pipeline: 'extractEn', timeout: 120_000 })
    run('translation.ts', {
      pipeline: 'translateChapters',
      env: {
        MT_TRANSLATE_BLOCK_LINES: '40',
        MT_TRANSLATE_SLOTS: 'glossary',
        MT_TRANSLATE_PROMPT_LOG: PROMPT_LOG,
      },
      timeout: 120_000,
    })
    const calls = (await readFile(PROMPT_LOG, 'utf-8')).trim().split('\n').filter(Boolean).length
    expect(calls).toBeLessThanOrEqual(30)
    const result = lintParity(EN_DIR, RU_DIR)
    expect(result.status, result.stdout).toBe(0)
  }, 180_000)

  it('defaults the body block size to 6 and lets an explicit env override win', () => {
    expect(translateBlockLines({})).toBe(6)
    expect(translateBlockLines({ MT_TRANSLATE_BLOCK_LINES: '3' })).toBe(3)
  })

  it('warns once when the block size exceeds the measured safe size', async () => {
    await clean(RU_DIR, TITLES, PROMPT_LOG, join(SAMPLE_DIR, '.mt'))
    run('translation.ts', {
      pipeline: 'translateChapters',
      env: { MT_ONLY_CHAPTERS: '1', MT_TRANSLATE_BLOCK_LINES: '9' },
    })
    const runsDir = join(SAMPLE_DIR, '.mt', 'runs')
    const files = (await readdir(runsDir, { recursive: true })).filter((file) =>
      file.endsWith('.log'),
    )
    const logs = await Promise.all(files.map((file) => readFile(join(runsDir, file), 'utf-8')))
    expect(logs.join('\n').match(/blockLines=9/g) ?? []).toHaveLength(1)
  }, 60_000)
})
