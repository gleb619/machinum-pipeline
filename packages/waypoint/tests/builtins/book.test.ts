import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExchange, setVariable } from '@mt/core'
import type { Exchange, ParsedUri, TargetContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBookTarget } from '../../src/book.js'

interface BookDoc {
  title: string
  toc: { number: number | undefined; title: string; anchor: string }[]
  warnings: { code: string; chapterNumber?: number; message: string }[]
}

const DOC: BookDoc = {
  title: 'Test Book',
  toc: [
    { number: 1, title: 'Chapter One', anchor: 'chapter-one' },
    { number: 2, title: 'Chapter Two', anchor: 'chapter-two' },
  ],
  warnings: [{ code: 'GAP', chapterNumber: 3, message: 'Chapter 3 is missing' }],
}

function tmpFilesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).filter((f) => String(f).includes('.tmp.'))
}

describe('book:// target', () => {
  let tempDir: string
  let ctx: TargetContext
  let uri: ParsedUri

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mt-book-wp-'))
    ctx = {
      run: {
        runId: 'run-1',
        global: { project: { name: 'test', root: tempDir }, settings: {} },
      },
    } as unknown as TargetContext
    uri = {
      scheme: 'book',
      raw: 'book://./out/book',
      host: '',
      path: './out/book',
      fragment: '',
      query: {},
    }
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function exchangeWithDoc(markdown: string): Exchange<string> {
    return setVariable(createExchange(markdown), 'book', DOC)
  }

  it('writes book.md and book.json under the project root', async () => {
    const target = createBookTarget<string>(uri)
    const markdown = '# Chapter One\n\nBody.\n'

    await target.open(ctx)
    await target.write(exchangeWithDoc(markdown), ctx)

    const dir = join(tempDir, 'out', 'book')
    expect(readFileSync(join(dir, 'book.md'), 'utf8')).toBe(markdown)

    const json = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'))
    expect(json.title).toBe('Test Book')
    expect(json.toc).toEqual(DOC.toc)
    expect(json.warnings).toEqual(DOC.warnings)
    expect(tmpFilesIn(dir)).toEqual([])
  })

  it('writes nothing when the envelope carries no book document', async () => {
    const target = createBookTarget<string>(uri)

    await target.open(ctx)
    await expect(target.write(createExchange('# Chapter One\n'), ctx)).rejects.toThrow(
      /book-compiler/,
    )

    const dir = join(tempDir, 'out', 'book')
    expect(existsSync(join(dir, 'book.md'))).toBe(false)
    expect(existsSync(join(dir, 'book.json'))).toBe(false)
    expect(tmpFilesIn(dir)).toEqual([])
  })

  it('writes nothing when the item is not the book markdown', async () => {
    const target = createBookTarget<string>(uri)

    await target.open(ctx)
    await expect(
      target.write(setVariable(createExchange({ nope: true } as never), 'book', DOC), ctx),
    ).rejects.toThrow(/expects the book markdown/)

    const dir = join(tempDir, 'out', 'book')
    expect(existsSync(join(dir, 'book.md'))).toBe(false)
    expect(existsSync(join(dir, 'book.json'))).toBe(false)
    expect(tmpFilesIn(dir)).toEqual([])
  })
})
