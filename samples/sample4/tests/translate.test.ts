import { execSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const TSX_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'tsx')
const CHAPTERS = join(SAMPLE_DIR, 'chapters')
const TAGGED_DIR = join(CHAPTERS, 'en-tagged')
const RU_DIR = join(CHAPTERS, 'ru')
const PROMPT_LOG = join(SAMPLE_DIR, '.mt-translate-prompts.jsonl')

// Tiny synthetic tagged chapters (not real book text).
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

/** Drops generated RU chapters but keeps chapters/ru/.gitkeep. */
async function cleanRu(): Promise<void> {
  for (const f of await readdir(RU_DIR).catch(() => [] as string[])) {
    if (f.endsWith('.md')) await rm(join(RU_DIR, f), { force: true })
  }
}

async function clean(): Promise<void> {
  await cleanRu()
  for (const d of ['en-tagged', 'schema']) {
    await rm(join(CHAPTERS, d), { recursive: true, force: true })
  }
  await rm(join(CHAPTERS, 'glossary.json'), { force: true })
  await rm(join(CHAPTERS, 'titles.json'), { force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
  await rm(PROMPT_LOG, { force: true })
}

function runTranslate(env: Record<string, string> = {}): void {
  execSync(`"${MT_BIN}" run ./pipelines/translate.ts`, {
    cwd: SAMPLE_DIR,
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_OPTIONS: '--import tsx',
      MT_LLM_TOOL: 'mock',
      MT_TRANSLATE_PROMPT_LOG: PROMPT_LOG,
      ...env,
    },
    timeout: 60_000,
  })
}

async function prompts(): Promise<Array<{ system: string; user: string }>> {
  const raw = await readFile(PROMPT_LOG, 'utf-8')
  return raw
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { system: string; user: string })
}

const strip = (s: string) => s.replace(/<term id="[^"]*">([\s\S]*?)<\/term>/g, '$1')

beforeAll(async () => {
  await clean()
  await mkdir(TAGGED_DIR, { recursive: true })
  await mkdir(join(CHAPTERS, 'schema'), { recursive: true })
  for (const [name, text] of Object.entries(FIXTURE)) {
    await writeFile(join(TAGGED_DIR, name), text, 'utf-8')
  }
  for (const [name, text] of Object.entries(SUMMARY)) {
    await writeFile(join(CHAPTERS, 'schema', name), text, 'utf-8')
  }
  await writeFile(join(CHAPTERS, 'glossary.json'), JSON.stringify(GLOSSARY), 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean()
})

describe('translate pipeline (mock LLM, synthetic chapters)', () => {
  it('runs to completion', () => {
    runTranslate()
  })

  it('keeps EN/RU line parity, structure and strips <term> tags', async () => {
    expect((await readdir(RU_DIR)).filter((f) => f.endsWith('.md')).sort()).toEqual([
      'chapter1.md',
      'chapter2.md',
    ])
    for (const [name, tagged] of Object.entries(FIXTURE)) {
      const en = strip(tagged).split('\n')
      const ru = (await readFile(join(RU_DIR, name), 'utf-8')).split('\n')
      expect(ru).toHaveLength(en.length)
      en.forEach((line, i) => {
        const r = ru[i] as string
        expect(r.trim() === '').toBe(line.trim() === '')
        expect(/^\[.*\]$/.test(r.trim())).toBe(/^\[.*\]$/.test(line.trim()))
      })
      expect(ru.join('\n')).not.toContain('<term')
    }
    const c1 = await readFile(join(RU_DIR, 'chapter1.md'), 'utf-8')
    expect(c1).toContain('\nArin Vale in code\n') // fenced code untouched
    expect(c1.split('\n')[0]).toBe('# слово 1: слово')
  })

  it('writes translated titles', async () => {
    const titles = JSON.parse(await readFile(join(CHAPTERS, 'titles.json'), 'utf-8')) as Record<
      string,
      { en: string; ru: string }
    >
    expect(titles['1']).toEqual({ en: 'Chapter 1: Start', ru: 'слово 1: слово' })
    expect(Object.keys(titles).sort()).toEqual(['1', '2'])
  })

  it('injects summary and only the glossary terms present in each line', async () => {
    const all = await prompts()
    const arin = all.find((p) => p.user.startsWith('Arin Vale walked'))
    if (!arin) throw new Error('prompt for the Arin line not captured')
    expect(arin.user).not.toContain('<term')
    expect(arin.system).toContain('Arin Vale = Арин Вейл')
    expect(arin.system).toContain('Iron Keep = Железная Крепость')
    expect(arin.system).toMatch(/transliterate[\s\S]*Zorg/)
    expect(arin.system).toContain('A hero enters a fortress.')
    expect(arin.system).not.toContain('Серебряная река')
    expect(arin.system).not.toContain('A river is crossed.')

    const plain = all.find((p) => p.user === 'The hall was empty and quiet.')
    expect(plain?.system).not.toContain('Glossary')

    const river = all.find((p) => p.user.startsWith('They crossed'))
    expect(river?.system).toContain('Silver River = Серебряная река')
    expect(river?.system).not.toContain('Арин')
  })

  it('lint-parity script passes on good output and fails on a broken copy', async () => {
    const enDir = join(CHAPTERS, 'en-check')
    await mkdir(enDir, { recursive: true })
    try {
      for (const [name, tagged] of Object.entries(FIXTURE)) {
        await writeFile(join(enDir, name), strip(tagged), 'utf-8')
      }
      const run = () =>
        spawnSync(TSX_BIN, ['lint-parity.ts', enDir, RU_DIR], {
          cwd: SAMPLE_DIR,
          encoding: 'utf-8',
        })
      const good = run()
      expect(good.status).toBe(0)
      expect(good.stdout).toContain('OK')

      const ru1 = join(RU_DIR, 'chapter1.md')
      const original = await readFile(ru1, 'utf-8')
      await writeFile(ru1, original.replace('\n\n[', '\n['), 'utf-8')
      const bad = run()
      expect(bad.status).toBe(1)
      expect(bad.stdout).toContain('line-count')
      await writeFile(ru1, original, 'utf-8')
    } finally {
      await rm(enDir, { recursive: true, force: true })
    }
  })

  it('MT_ONLY_CHAPTERS limits the run and a bad reply is retried by the engine', async () => {
    await cleanRu()
    await rm(PROMPT_LOG, { force: true })
    await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
    runTranslate({ MT_ONLY_CHAPTERS: '1', MT_MOCK_FLAKY: '1' })
    expect((await readdir(RU_DIR)).filter((f) => f.endsWith('.md'))).toEqual(['chapter1.md'])
    // 1 title + 3 body lines + 1 rejected empty reply that was retried
    expect(await prompts()).toHaveLength(5)
  })
})
