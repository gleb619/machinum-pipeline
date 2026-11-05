import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exchange, ParsedUri, TargetContext } from '@mt/core'
import { MD_OUTPUTS_VARIABLE, createExchange, fromPersisted, setVariable } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBookTarget } from '../../src/book.js'
import { createChapterOutputTarget } from '../../src/chapter-output.js'
import { createConsoleTarget } from '../../src/console.js'
import { createJsonlTarget } from '../../src/jsonl.js'
import { createMdTarget } from '../../src/md.js'
import { createReviewTarget } from '../../src/review.js'
import { createSchemaDocTarget } from '../../src/schema-doc.js'
import { createVoidTarget } from '../../src/void.js'

import '../../src/book.js'
import '../../src/chapter-output.js'
import '../../src/console.js'
import '../../src/jsonl.js'
import '../../src/md.js'
import '../../src/review.js'
import '../../src/schema-doc.js'
import '../../src/void.js'

const RUN_ID = 'run-1'

function makeUri(raw: string): ParsedUri {
  const separator = raw.indexOf('://')
  const scheme = separator === -1 ? '' : raw.slice(0, separator)
  const rest = separator === -1 ? '' : raw.slice(separator + 3)
  return { scheme, raw, host: rest, path: rest, query: {}, fragment: '' }
}

describe('waypoint targets — incremental checkpoints', () => {
  let tempDir: string
  let ctx: TargetContext

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mt-checkpoint-wp-'))
    ctx = {
      run: {
        runId: RUN_ID,
        global: { project: { name: 'test', root: tempDir }, settings: {} },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      },
    } as unknown as TargetContext
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function resumeCtx(cursor: number): TargetContext {
    return { ...ctx, resumeCursor: cursor }
  }

  function env<T>(item: T, id = `ex-${String(item)}`): Exchange<T> {
    return createExchange(item, { id, meta: {} })
  }

  it('jsonl: checkpoint counts writes and resume keeps only the committed prefix', async () => {
    const file = join(tempDir, 'out.jsonl')
    const first = createJsonlTarget<number>(makeUri(`jsonl://${file}`))
    await first.open(ctx)
    await first.write(env(1), ctx)
    await first.write(env(2), ctx)
    await first.write(env(3), ctx)
    expect(await first.checkpoint?.(ctx)).toBe(3)
    // Abandon without close(): staging survives, the final path does not.
    expect(existsSync(file)).toBe(false)

    const resumed = createJsonlTarget<number>(makeUri(`jsonl://${file}`))
    await resumed.open(resumeCtx(1))
    await resumed.write(env(2), ctx)
    await resumed.write(env(3), ctx)
    expect(await resumed.checkpoint?.(ctx)).toBe(2)
    await resumed.close(ctx)

    const lines = readFileSync(file, 'utf-8').trimEnd().split('\n')
    expect(lines.map((line) => fromPersisted<number>(JSON.parse(line)).item)).toEqual([1, 2, 3])
  })

  it('md (file mode): the offsets sidecar aligns staged lines on resume', async () => {
    const file = join(tempDir, 'out.md')
    const first = createMdTarget<string>(makeUri(`md://${file}`))
    await first.open(ctx)
    await first.write(env('one'), ctx)
    await first.write(env('two'), ctx)
    await first.write(env('three'), ctx)
    expect(await first.checkpoint?.(ctx)).toBe(3)
    expect(existsSync(file)).toBe(false)

    const resumed = createMdTarget<string>(makeUri(`md://${file}`))
    await resumed.open(resumeCtx(1))
    await resumed.write(env('two'), ctx)
    await resumed.write(env('three'), ctx)
    expect(await resumed.checkpoint?.(ctx)).toBe(2)
    await resumed.close(ctx)

    expect(readFileSync(file, 'utf-8')).toBe('one\ntwo\nthree\n')
    expect(readdirSync(tempDir).filter((entry) => entry.includes('.tmp.'))).toEqual([])
  })

  it('md (dir mode): checkpoint counts envelopes, not files', async () => {
    const target = createMdTarget<string>(makeUri(`md://${join(tempDir, 'chapters')}`))
    await target.open(ctx)

    const withTwoIntents = setVariable(env('unused'), MD_OUTPUTS_VARIABLE, [
      { name: 'a', subdir: '', filename: 'a.md', content: 'a' },
      { name: 'b', subdir: '', filename: 'b.md', content: 'b' },
    ])
    await target.write(withTwoIntents, ctx)
    expect(await target.checkpoint?.(ctx)).toBe(1)
    await target.write(env('chapter body'), ctx)
    expect(await target.checkpoint?.(ctx)).toBe(2)

    await target.close(ctx)
  })

  it('chapter-output: seeds auto-numbering from existing chapters on resume', async () => {
    const root = join(tempDir, 'chapters')
    const uri = makeUri(`chapter-output://${root}`)

    const first = createChapterOutputTarget<string>(uri)
    await first.open(ctx)
    await first.write(env('one'), ctx)
    await first.write(env('two'), ctx)
    expect(await first.checkpoint?.(ctx)).toBe(2)
    // Close publishes both chapters; now resume auto-numbering must not restart at 1.
    await first.close(ctx)
    expect(readFileSync(join(root, 'chapter1.md'), 'utf-8')).toBe('one')
    expect(readFileSync(join(root, 'chapter2.md'), 'utf-8')).toBe('two')

    const resumed = createChapterOutputTarget<string>(uri)
    await resumed.open(resumeCtx(2))
    await resumed.write(env('three'), ctx)
    await resumed.close(ctx)

    expect(readFileSync(join(root, 'chapter3.md'), 'utf-8')).toBe('three')
    expect(readFileSync(join(root, 'chapter1.md'), 'utf-8')).toBe('one')
  })

  it('schema-doc: checkpoint counts written documents', async () => {
    const target = createSchemaDocTarget(makeUri(`schema-doc://${join(tempDir, 'schema')}`))
    await target.open(ctx)
    await target.write(env('# One', 'ex-1'), ctx)
    await target.write(env('# Two', 'ex-2'), ctx)
    expect(await target.checkpoint?.(ctx)).toBe(2)
    await target.close(ctx)
  })

  it('book: checkpoint counts written books', async () => {
    const target = createBookTarget<string>(makeUri(`book://${join(tempDir, 'book')}`))
    await target.open(ctx)
    const withDoc = setVariable(env('# Book'), 'book', { title: 'T', toc: [], warnings: [] })
    await target.write(withDoc, ctx)
    expect(await target.checkpoint?.(ctx)).toBe(1)
    await target.close(ctx)
  })

  it('review: checkpoint counts rendered worksheets', async () => {
    const target = createReviewTarget<string>(makeUri(`review://${join(tempDir, 'review.md')}`))
    await target.open(ctx)
    const withGlossary = setVariable(env('ignored'), 'glossary', { terms: [] })
    await target.write(withGlossary, ctx)
    await target.write(withGlossary, ctx)
    expect(await target.checkpoint?.(ctx)).toBe(2)
    await target.close(ctx)
  })

  it('void: checkpoint counts discarded envelopes', async () => {
    const target = createVoidTarget<unknown>(makeUri('void://'))
    await target.open(ctx)
    await target.write(env('a'), ctx)
    await target.write(env('b'), ctx)
    expect(await target.checkpoint?.(ctx)).toBe(2)
    await target.close(ctx)
  })

  it('console: checkpoint counts accepted envelopes', async () => {
    const chunks: string[] = []
    const target = createConsoleTarget<string>(makeUri('console://'), {
      sink: (chunk) => chunks.push(chunk),
    })
    await target.open(ctx)
    await target.write(env('a'), ctx)
    await target.write(env('b'), ctx)
    expect(await target.checkpoint?.(ctx)).toBe(2)
    expect(chunks).toEqual(['a\n', 'b\n'])
    await target.close(ctx)
  })
})
