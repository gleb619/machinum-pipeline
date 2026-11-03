import { execSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const OUTPUT = join(SAMPLE_DIR, 'chapters', 'parallel-forks.md')

const RECORDS = [
  '# Chapter One\n\nThe first line has words.\nSecond line follows here.\n\nA short paragraph ends.',
  '# Chapter Two\n\nThird chapter starts now.\n\nFinal line closes the book.',
]

const SECTION_HEADINGS = ['counts', 'lines reordered', 'dots replaced with commas']

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), { force: true })
  await rm(OUTPUT, { force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  const content = `${RECORDS.map((markdown) => JSON.stringify({ item: markdown })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), content, 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') {
    hasFailure = true
  }
})

afterAll(async () => {
  if (!hasFailure) {
    await cleanup()
  }
})

function run(): string {
  return execSync(`"${MT_BIN}" run ./pipelines/intermediate.ts`, {
    cwd: SAMPLE_DIR,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    timeout: 10_000,
  }).toString('utf-8')
}

function headingsIn(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1] ?? '')
}

/** Body text after every `## <heading>`, up to the next heading or chapter. */
function sectionsUnder(markdown: string, heading: string): string[] {
  const marker = `## ${heading}`
  const sections: string[] = []
  let cursor = 0

  while (cursor < markdown.length) {
    const start = markdown.indexOf(marker, cursor)
    if (start === -1) break

    const contentStart = start + marker.length
    const nextSection = markdown.indexOf('\n## ', contentStart)
    const nextChapter = markdown.indexOf('\n# ', contentStart)
    const ends = [nextSection, nextChapter].filter((index) => index !== -1)
    const end = ends.length > 0 ? Math.min(...ends) : markdown.length

    sections.push(markdown.slice(contentStart, end))
    cursor = end
  }

  return sections
}

describe('parallel forks pipeline', () => {
  it('writes counts, reordered lines and comma-replaced dots to markdown', async () => {
    run()
    const content = await readFile(OUTPUT, 'utf-8')

    expect(content).toContain('# Chapter One')
    expect(content).toContain('2 paragraphs · 3 lines · 13 words')
    expect(content).toContain('# Chapter Two')
    expect(content).toContain('2 paragraphs · 2 lines · 9 words')
  })

  it('reorders each paragraph alphabetically', async () => {
    run()
    const content = await readFile(OUTPUT, 'utf-8')
    const sections = sectionsUnder(content, 'lines reordered')

    expect(sections).toHaveLength(2)
    expect(sections[0] ?? '').toContain('- Second line follows here.\n- The first line has words.')
    expect(sections[0] ?? '').toContain('- A short paragraph ends.')
    expect(sections[1] ?? '').toContain('- Third chapter starts now.')
    expect(sections[1] ?? '').toContain('- Final line closes the book.')
  })

  it('replaces every dot in the chapter body with a comma', async () => {
    run()
    const content = await readFile(OUTPUT, 'utf-8')
    const sections = sectionsUnder(content, 'dots replaced with commas')

    expect(sections).toHaveLength(2)
    expect(sections[0] ?? '').toContain('The first line has words,\nSecond line follows here,')
    expect(sections[0] ?? '').toContain('A short paragraph ends,')
    expect(sections[1] ?? '').toContain('Third chapter starts now,')
    expect(sections[1] ?? '').toContain('Final line closes the book,')

    for (const section of sections) expect(section).not.toContain('.')
  })

  it('merges the three branch sections in declaration order for each chapter', async () => {
    run()
    const content = await readFile(OUTPUT, 'utf-8')
    const chapterTwoStart = content.indexOf('# Chapter Two')

    expect(content.indexOf('# Chapter One')).toBeGreaterThanOrEqual(0)
    expect(chapterTwoStart).toBeGreaterThan(0)

    const chapterOne = content.slice(0, chapterTwoStart)
    const chapterTwo = content.slice(chapterTwoStart)

    expect(headingsIn(chapterOne)).toEqual(SECTION_HEADINGS)
    expect(headingsIn(chapterTwo)).toEqual(SECTION_HEADINGS)
  })
})
