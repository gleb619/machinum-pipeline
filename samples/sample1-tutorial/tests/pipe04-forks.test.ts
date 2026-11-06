import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run, writeJsonl } from './helpers.js'

const OUTPUT_DIR = join(CHAPTERS, 'chapter-views')
const INPUT = join(SAMPLE_DIR, 'jsonl', 'entities.jsonl')

const RECORDS = [
  '---\nnumber: 1\nseries: demo-serial\nreviewer: alice\n---\n\n# Chapter One\n\nThe first line has words.\nSecond line follows here.\n\nA short paragraph ends.',
  '---\nnumber: 2\nseries: demo-serial\nreviewer: bob\n---\n\n# Chapter Two\n\nThird chapter starts now.\n\nFinal line closes the book.',
]

let hasFailure = false

const viewFile = (chapter: number, view: string) => join(OUTPUT_DIR, `chapter${chapter}-${view}.md`)
const readView = (chapter: number, view: string) => readFile(viewFile(chapter, view), 'utf-8')

beforeAll(async () => {
  await clean(OUTPUT_DIR, INPUT, join(SAMPLE_DIR, '.mt'))
  await writeJsonl(INPUT, RECORDS)
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(OUTPUT_DIR, INPUT)
})

describe('pipe04 parallel forks', () => {
  it('routes every branch view to its own file named from meta.chapter', async () => {
    run('pipe04-forks.ts')
    expect((await readdir(OUTPUT_DIR)).sort()).toEqual([
      'chapter1-commas.md',
      'chapter1-counts.md',
      'chapter1-reordered.md',
      'chapter2-commas.md',
      'chapter2-counts.md',
      'chapter2-reordered.md',
    ])
  })

  it('writes counts, reordered lines and comma-replaced dots', async () => {
    run('pipe04-forks.ts')
    const countsOne = await readView(1, 'counts')
    expect(countsOne).toContain('# Chapter One')
    expect(countsOne).toContain('2 paragraphs · 3 lines · 13 words')
    expect(await readView(2, 'counts')).toContain('2 paragraphs · 2 lines · 9 words')
  })

  it('reads frontmatter number/series and keeps the custom reviewer key', async () => {
    run('pipe04-forks.ts')
    expect(await readView(1, 'counts')).toContain(
      'number: 1 · series: demo-serial · reviewer: alice',
    )
    expect(await readView(2, 'counts')).toContain('number: 2 · series: demo-serial · reviewer: bob')
  })

  it('reorders each paragraph alphabetically and records lineOrder metadata', async () => {
    run('pipe04-forks.ts')
    const reorderedOne = await readView(1, 'reordered')
    expect(reorderedOne).toContain('lineOrder: alphabetical')
    expect(reorderedOne).toContain('- Second line follows here.\n- The first line has words.')
    expect(reorderedOne).toContain('- A short paragraph ends.')
  })

  it('replaces every dot in the chapter body with a comma and records dotsReplaced', async () => {
    run('pipe04-forks.ts')
    const commasOne = await readView(1, 'commas')
    expect(commasOne).toContain('dotsReplaced: 3')
    expect(commasOne).toContain('The first line has words,\nSecond line follows here,')
    expect(commasOne).toContain('A short paragraph ends,')
    const body = commasOne.replace(/^[\s\S]*?dotsReplaced: \d+\s*/, '')
    expect(body).not.toContain('.')
  })
})
