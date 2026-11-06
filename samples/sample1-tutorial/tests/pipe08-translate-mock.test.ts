import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, lintParity, run, runScript } from './helpers.js'

const TAGGED_DIR = join(CHAPTERS, 'en-tagged')
const RU_DIR = join(CHAPTERS, 'ru')
const SCHEMA_DIR = join(CHAPTERS, 'schema')
const PROMPT_LOG = join(SAMPLE_DIR, '.mt-translate-prompts.jsonl')

const FIXTURE: Record<string, string> = {
  'chapter1.md': [
    '# Chapter 1: Start',
    '',
    '<term id="arin-vale">Arin Vale</term> walked into the <term id="iron-keep">Iron Keep</term> with <term id="zorg">Zorg</term>.',
    '',
    'The hall was empty and quiet.',
    '',
    '[System: level up!]',
    '',
    '```',
    'Arin Vale in code',
    '```',
    '',
  ].join('\n'),
  'chapter2.md': [
    '# Chapter 2: Next',
    '',
    'They crossed the <term id="silver-river">Silver River</term> at dawn.',
    '',
    'Nothing else happened that day.',
    '',
  ].join('\n'),
}

const GLOSSARY = {
  terms: [
    ['arin-vale', 'Arin Vale', 'character', 'Арин Вейл'],
    ['iron-keep', 'Iron Keep', 'place', 'Железная Крепость'],
    ['zorg', 'Zorg', 'character', null],
    ['silver-river', 'Silver River', 'place', 'Серебряная река'],
  ].map(([id, term, type, ru]) => ({
    id,
    term,
    type,
    count: 2,
    firstChapter: 1,
    ru,
    aliases: [],
  })),
}

const SUMMARY: Record<string, string> = {
  'chapter1.summary.md': '# Chapter 1: Start\n\n## Summary\n\nA hero enters a fortress.\n',
  'chapter2.summary.md': '# Chapter 2: Next\n\n## Summary\n\nA river is crossed.\n',
}

let hasFailure = false

async function cleanRu(): Promise<void> {
  const entries = await readdir(RU_DIR).catch(() => [] as string[])
  await Promise.all(
    entries.filter((file) => file.endsWith('.md')).map((file) => clean(join(RU_DIR, file))),
  )
}

async function cleanup(): Promise<void> {
  await cleanRu()
  await clean(
    TAGGED_DIR,
    SCHEMA_DIR,
    join(CHAPTERS, 'glossary.json'),
    join(CHAPTERS, 'titles.json'),
    PROMPT_LOG,
    join(SAMPLE_DIR, '.mt'),
  )
}

function runTranslate(env: Record<string, string> = {}): string {
  return run('pipe08-translate-mock.ts', {
    env: { MT_TRANSLATE_PROMPT_LOG: PROMPT_LOG, ...env },
  })
}

async function prompts(): Promise<Array<{ system: string; user: string }>> {
  const raw = await readFile(PROMPT_LOG, 'utf-8')
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { system: string; user: string })
}

const strip = (text: string) => text.replace(/<term id="[^"]*">([\s\S]*?)<\/term>/g, '$1')

beforeAll(async () => {
  await cleanup()
  runScript('prepare-input.ts')
  await mkdir(TAGGED_DIR, { recursive: true })
  await mkdir(SCHEMA_DIR, { recursive: true })
  for (const [name, text] of Object.entries(FIXTURE)) {
    await writeFile(join(TAGGED_DIR, name), text, 'utf-8')
  }
  for (const [name, text] of Object.entries(SUMMARY)) {
    await writeFile(join(SCHEMA_DIR, name), text, 'utf-8')
  }
  await writeFile(join(CHAPTERS, 'glossary.json'), JSON.stringify(GLOSSARY), 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('pipe08 translate (mock LLM, glossary + summary)', () => {
  it('keeps EN/RU line parity, structure and strips <term> tags', async () => {
    runTranslate()
    expect((await readdir(RU_DIR)).filter((file) => file.endsWith('.md')).sort()).toEqual([
      'chapter1.md',
      'chapter2.md',
    ])
    for (const [name, tagged] of Object.entries(FIXTURE)) {
      const en = strip(tagged).split('\n')
      const ru = (await readFile(join(RU_DIR, name), 'utf-8')).split('\n')
      expect(ru).toHaveLength(en.length)
      en.forEach((line, index) => {
        const translated = ru[index] as string
        expect(translated.trim() === '').toBe(line.trim() === '')
        expect(/^\[.*\]$/.test(translated.trim())).toBe(/^\[.*\]$/.test(line.trim()))
      })
      expect(ru.join('\n')).not.toContain('<term')
    }
    const first = await readFile(join(RU_DIR, 'chapter1.md'), 'utf-8')
    expect(first).toContain('\nArin Vale in code\n')
    expect(first.split('\n')[0]).toBe('# слово 1: слово')
  })

  it('writes translated titles', async () => {
    const titles = JSON.parse(await readFile(join(CHAPTERS, 'titles.json'), 'utf-8')) as Record<
      string,
      { en: string; ru: string }
    >
    expect(titles['1']).toEqual({ en: 'Chapter 1: Start', ru: 'слово 1: слово' })
    expect(Object.keys(titles).sort()).toEqual(['1', '2'])
  })

  it('injects the summary and only the glossary terms present in each line', async () => {
    const all = await prompts()
    const arin = all.find((prompt) => prompt.user.startsWith('Arin Vale walked'))
    if (!arin) throw new Error('prompt for the Arin line not captured')
    expect(arin.user).not.toContain('<term')
    expect(arin.system).toContain('Arin Vale = Арин Вейл')
    expect(arin.system).toContain('Iron Keep = Железная Крепость')
    expect(arin.system).toMatch(/transliterate[\s\S]*Zorg/)
    expect(arin.system).toContain('A hero enters a fortress.')
    expect(arin.system).not.toContain('Серебряная река')
    expect(arin.system).not.toContain('A river is crossed.')

    const plain = all.find((prompt) => prompt.user === 'The hall was empty and quiet.')
    expect(plain?.system).not.toContain('Glossary')

    const river = all.find((prompt) => prompt.user.startsWith('They crossed'))
    expect(river?.system).toContain('Silver River = Серебряная река')
    expect(river?.system).not.toContain('Арин')
  })

  it('lint-parity passes on good output and fails on a broken copy', async () => {
    const enDir = join(CHAPTERS, 'en-check')
    await mkdir(enDir, { recursive: true })
    try {
      for (const [name, tagged] of Object.entries(FIXTURE)) {
        await writeFile(join(enDir, name), strip(tagged), 'utf-8')
      }
      const good = lintParity(enDir, RU_DIR)
      expect(good.status).toBe(0)
      expect(good.stdout).toContain('OK')

      const ru1 = join(RU_DIR, 'chapter1.md')
      const original = await readFile(ru1, 'utf-8')
      await writeFile(ru1, original.replace('\n\n[', '\n['), 'utf-8')
      const bad = lintParity(enDir, RU_DIR)
      expect(bad.status).toBe(1)
      expect(bad.stdout).toContain('line-count')
      await writeFile(ru1, original, 'utf-8')
    } finally {
      await clean(enDir)
    }
  })

  it('MT_ONLY_CHAPTERS limits the run and a bad reply is retried', async () => {
    await cleanRu()
    await clean(PROMPT_LOG, join(SAMPLE_DIR, '.mt'))
    runTranslate({ MT_ONLY_CHAPTERS: '1', MT_MOCK_FLAKY: '1' })
    expect((await readdir(RU_DIR)).filter((file) => file.endsWith('.md'))).toEqual(['chapter1.md'])
    expect(await prompts()).toHaveLength(5)
  }, 30_000)
})

describe('pipe08 work modes and generic translators', () => {
  it('runs plain, xml and properties modes with Cyrillic output', async () => {
    for (const mode of ['plain', 'xml', 'properties']) {
      run('pipe08-translate-mock.ts', { pipeline: `${mode}ModePipeline` })
      const report = await readFile(join(CHAPTERS, `translate-${mode}`, 'chapter1.md'), 'utf-8')
      expect(report).toContain('## Output')
      expect(report).toMatch(/[Ѐ-ӿ]/)
    }
  })

  it('runs the generic paragraph and title translators', async () => {
    run('pipe08-translate-mock.ts', { pipeline: 'paragraphsPipeline' })
    run('pipe08-translate-mock.ts', { pipeline: 'titlePipeline' })
    const paragraphs = await readFile(
      join(CHAPTERS, 'translate-paragraphs', 'chapter1.md'),
      'utf-8',
    )
    const title = await readFile(join(CHAPTERS, 'translate-title', 'chapter1.md'), 'utf-8')
    expect(paragraphs).toContain('paragraphsTranslated')
    expect(title).toContain('titleTranslated')
    expect(paragraphs).toMatch(/[Ѐ-ӿ]/)
    expect(title).toMatch(/[Ѐ-ӿ]/)
  })
})
