import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run, writeFileAt } from './helpers.js'

const RU_DIR = join(CHAPTERS, 'ru')
const BOOK_DIR = join(CHAPTERS, 'book')
let hasFailure = false

beforeAll(async () => {
  await clean(RU_DIR, BOOK_DIR, join(SAMPLE_DIR, '.mt'))
  const chapters: Array<[number, string, string]> = [
    [10, 'Глава 10: Последняя частота', 'Последняя глава заканчивает историю.'],
    [2, 'Глава 2: Шипение', 'Вторая глава начинается с плёнки.'],
    [1, 'Глава 1: Пожертвование', 'Первая глава приносит коробки.'],
  ]
  for (const [number, title, body] of chapters) {
    await writeFileAt(join(RU_DIR, `chapter${number}.md`), `# ${title}\n\n${body}\n`)
  }
  run('assemble.ts')
}, 60_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(RU_DIR, BOOK_DIR)
})

describe('assemble', () => {
  it('sorts chapters numerically, not lexicographically', async () => {
    const markdown = await readFile(join(BOOK_DIR, 'book.md'), 'utf-8')
    const first = markdown.indexOf('# Глава 1: Пожертвование')
    const second = markdown.indexOf('# Глава 2: Шипение')
    const tenth = markdown.indexOf('# Глава 10: Последняя частота')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(tenth).toBeGreaterThan(second)
  })

  it('writes a table of contents and a warning-free book.json', async () => {
    const markdown = await readFile(join(BOOK_DIR, 'book.md'), 'utf-8')
    expect(markdown).toContain('- [Глава 1: Пожертвование](#глава-1-пожертвование)')
    expect(markdown).toContain('title: "The Quiet Frequency — Russian draft"')
    const book = JSON.parse(await readFile(join(BOOK_DIR, 'book.json'), 'utf-8')) as {
      title: string
      toc: Array<{ title: string }>
      warnings: unknown[]
    }
    expect(book.title).toBe('The Quiet Frequency — Russian draft')
    expect(book.toc.map((entry) => entry.title)).toEqual([
      'Глава 1: Пожертвование',
      'Глава 2: Шипение',
      'Глава 10: Последняя частота',
    ])
    expect(book.warnings).toEqual([])
  })
})
