import { execSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const OUTPUT_DIR = join(SAMPLE_DIR, 'chapters', 'chapter-views')

const RECORDS = [
  '---\nnumber: 1\nseries: demo-serial\nreviewer: alice\n---\n\n# Chapter One\n\nThe first line has words.\nSecond line follows here.\n\nA short paragraph ends.',
  '---\nnumber: 2\nseries: demo-serial\nreviewer: bob\n---\n\n# Chapter Two\n\nThird chapter starts now.\n\nFinal line closes the book.',
]

/** Each branch stamps `meta.chapter = "<number>-<view>"` → `chapter<number>-<view>.md`. */
function viewFile(chapter: number, view: string): string {
  return join(OUTPUT_DIR, `chapter${chapter}-${view}.md`)
}

function readView(chapter: number, view: string): Promise<string> {
  return readFile(viewFile(chapter, view), 'utf-8')
}

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), { force: true })
  await rm(OUTPUT_DIR, { recursive: true, force: true })
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

describe('parallel forks pipeline', () => {
  it('routes each branch view to its own file named from the stamped meta.chapter', async () => {
    run()
    const files = (await readdir(OUTPUT_DIR)).sort()

    expect(files).toEqual([
      'chapter1-commas.md',
      'chapter1-counts.md',
      'chapter1-reordered.md',
      'chapter2-commas.md',
      'chapter2-counts.md',
      'chapter2-reordered.md',
    ])
  })

  it('writes counts, reordered lines and comma-replaced dots', async () => {
    run()

    const countsOne = await readView(1, 'counts')
    expect(countsOne).toContain('# Chapter One')
    expect(countsOne).toContain('2 paragraphs · 3 lines · 13 words')
    expect(await readView(2, 'counts')).toContain('2 paragraphs · 2 lines · 9 words')
  })

  it('reads frontmatter number/series and keeps the custom reviewer key', async () => {
    run()
    const countsOne = await readView(1, 'counts')
    const countsTwo = await readView(2, 'counts')

    expect(countsOne).toContain('number: 1 · series: demo-serial · reviewer: alice')
    expect(countsTwo).toContain('number: 2 · series: demo-serial · reviewer: bob')
  })

  it('reorders each paragraph alphabetically and records lineOrder metadata', async () => {
    run()
    const reorderedOne = await readView(1, 'reordered')
    const reorderedTwo = await readView(2, 'reordered')

    expect(reorderedOne).toContain('lineOrder: alphabetical')
    expect(reorderedOne).toContain('- Second line follows here.\n- The first line has words.')
    expect(reorderedOne).toContain('- A short paragraph ends.')
    expect(reorderedTwo).toContain('lineOrder: alphabetical')
    expect(reorderedTwo).toContain('- Third chapter starts now.')
    expect(reorderedTwo).toContain('- Final line closes the book.')
  })

  it('replaces every dot in the chapter body with a comma and records dotsReplaced', async () => {
    run()
    const commasOne = await readView(1, 'commas')
    const commasTwo = await readView(2, 'commas')

    expect(commasOne).toContain('dotsReplaced: 3')
    expect(commasOne).toContain('The first line has words,\nSecond line follows here,')
    expect(commasOne).toContain('A short paragraph ends,')
    expect(commasTwo).toContain('dotsReplaced: 2')
    expect(commasTwo).toContain('Third chapter starts now,')
    expect(commasTwo).toContain('Final line closes the book,')

    for (const content of [commasOne, commasTwo]) {
      const body = content.replace(/^[\s\S]*?dotsReplaced: \d+\s*/, '')
      expect(body).not.toContain('.')
    }
  })
})
