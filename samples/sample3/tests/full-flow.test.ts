import { execSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const TSX_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'tsx')
const CHAPTERS = join(SAMPLE_DIR, 'chapters')
const EN_DIR = join(CHAPTERS, 'en')
const RU_DIR = join(CHAPTERS, 'ru')
const TAGGED_DIR = join(CHAPTERS, 'en-tagged')
const GLOSSARY_PATH = join(CHAPTERS, 'glossary.json')
const PROMPT_LOG = join(SAMPLE_DIR, '.mt-translate-prompts.jsonl')

// One raw record per chapter: `value` = "Chapter N: Title\n<body lines>". Messy enough for the
// normalizer (curly quotes, ellipsis, zero-width, stray spacing, a decorative `* * *`), with names
// recurring across chapters so the glossary extractor has something to find.
const RAW = [
  {
    key: 'fixture/chapter-1',
    value:
      'Chapter 1: First Light\n“Arin Vale” stepped into the Iron Keep… the hall was empty .\n[System: level up!]\n\nArin Vale smiled at Marta​.',
  },
  {
    key: 'fixture/chapter-2',
    value:
      'Chapter 2: Second Wind\nThe Iron Keep fell. Marta nodded at Arin Vale.\n* * *\nSilver River froze over ,cold.',
  },
]

interface GlossaryFile {
  terms: Array<{ id: string; term: string; type: string; ru: string | null }>
}

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await mkdir(EN_DIR, { recursive: true })
  await mkdir(RU_DIR, { recursive: true })
  for (const dir of [EN_DIR, RU_DIR]) {
    for (const f of await readdir(dir)) {
      if (f.endsWith('.md')) await rm(join(dir, f), { force: true })
    }
  }
  for (const generated of ['schema', 'en-tagged']) {
    await rm(join(CHAPTERS, generated), { recursive: true, force: true })
  }
  await rm(GLOSSARY_PATH, { force: true })
  await rm(join(CHAPTERS, 'titles.json'), { force: true })
  await rm(PROMPT_LOG, { force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

/** Every stage runs offline: mock LLM backend, both optional LLM steps off. */
function runStage(pipeline: string, env: Record<string, string> = {}): void {
  execSync(`"${MT_BIN}" run ./pipelines/${pipeline}`, {
    cwd: SAMPLE_DIR,
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_OPTIONS: '--import tsx',
      MT_LLM_TOOL: 'mock',
      MT_LLM_TYPO_FIX: '',
      MT_LLM_SUMMARY: '',
      ...env,
    },
    timeout: 40_000,
  })
}

async function readGlossary(): Promise<GlossaryFile> {
  return JSON.parse(await readFile(GLOSSARY_PATH, 'utf-8')) as GlossaryFile
}

async function mdFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
}

beforeAll(async () => {
  await cleanup()
  const jsonl = `${RAW.map((item) => JSON.stringify({ item })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonl, 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('full flow: normalize -> analyze -> translate (mock LLM, offline)', () => {
  // Stages are run in order and share the real files on disk: each one reads what the previous
  // wrote, so this is the chain the README describes, not three isolated pipelines.
  const en: Record<string, string> = {}

  it('stage 1: normalize turns raw JSONL into clean chapters/en', async () => {
    runStage('normalize.ts')
    expect(await mdFiles(EN_DIR)).toEqual(['chapter1.md', 'chapter2.md'])
    const c1 = await readFile(join(EN_DIR, 'chapter1.md'), 'utf-8')
    en.chapter1 = c1
    expect(c1.startsWith('# Chapter 1: First Light\n')).toBe(true)
    expect(c1).toContain('"Arin Vale" stepped into the Iron Keep... the hall was empty.')
    expect(c1).not.toMatch(/[“”…​]/)
  })

  it('stage 2: analyze reads chapters/en and writes summaries + glossary + tagged text', async () => {
    runStage('analyze.ts')
    expect(await mdFiles(join(CHAPTERS, 'schema'))).toEqual([
      'chapter1.summary.md',
      'chapter2.summary.md',
    ])
    const g = await readGlossary()
    expect(g.terms.find((t) => t.term === 'Arin Vale')).toMatchObject({ id: 'arin-vale' })
    expect(g.terms.find((t) => t.term === 'Iron Keep')).toMatchObject({ id: 'iron-keep' })

    expect(await mdFiles(TAGGED_DIR)).toEqual(['chapter1.md', 'chapter2.md'])
    const tagged = await readFile(join(TAGGED_DIR, 'chapter1.md'), 'utf-8')
    expect(tagged).toContain('<term id="arin-vale">Arin Vale</term>')
    // The tags are the handoff to stage 3, so the tagged copy must carry the stage-1 text intact.
    expect(tagged.replace(/<term id="[^"]*">([^<]*)<\/term>/g, '$1')).toBe(en.chapter1)
  })

  it('hand edit: a human fills ru in glossary.json between analyze and translate', async () => {
    const g = await readGlossary()
    const arin = g.terms.find((t) => t.term === 'Arin Vale')
    if (!arin) throw new Error('Arin Vale missing from the glossary')
    arin.ru = 'Арин Вейл'
    await writeFile(GLOSSARY_PATH, JSON.stringify(g, null, 2), 'utf-8')
    expect((await readGlossary()).terms.find((t) => t.id === 'arin-vale')?.ru).toBe('Арин Вейл')
  })

  it('stage 3: translate reads the tagged text and writes chapters/ru + titles.json', async () => {
    runStage('translate.ts', { MT_TRANSLATE_PROMPT_LOG: PROMPT_LOG })
    expect(await mdFiles(RU_DIR)).toEqual(['chapter1.md', 'chapter2.md'])

    const titles = JSON.parse(await readFile(join(CHAPTERS, 'titles.json'), 'utf-8')) as Record<
      string,
      { en: string; ru: string }
    >
    expect(Object.keys(titles).sort()).toEqual(['1', '2'])
    expect(titles['1']?.en).toBe('Chapter 1: First Light')

    // The mock answers one 'слово' per Latin word; the heading must be the translated title.
    const c1 = await readFile(join(RU_DIR, 'chapter1.md'), 'utf-8')
    expect(titles['1']?.ru).toBe('слово 1: слово слово')
    expect(c1.split('\n')[0]).toBe(`# ${titles['1']?.ru}`)
    expect(c1).not.toContain('<term')

    // The summary of stage 2 and the hand-edited glossary of the step before both reached the prompt.
    const prompts = (await readFile(PROMPT_LOG, 'utf-8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { system: string; user: string })
    const stepped = prompts.find((p) => p.user.includes('stepped into'))
    if (!stepped) throw new Error('prompt for the opening line not captured')
    expect(stepped.system).toContain('Arin Vale = Арин Вейл')
    expect(stepped.system).toMatch(/transliterate[\s\S]*Iron Keep/)
    expect(stepped.system).toContain('Chapter summary (context only')
  })

  it('the standalone parity linter passes on the generated EN/RU pair', () => {
    const run = spawnSync(TSX_BIN, ['lint-parity.ts', 'chapters/en', 'chapters/ru'], {
      cwd: SAMPLE_DIR,
      encoding: 'utf-8',
    })
    expect(run.stdout).toContain('OK: 2 chapter(s)')
    expect(run.status).toBe(0)
  })
})
