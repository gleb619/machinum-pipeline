import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@mt/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createBookSource, forcedBranch } from './input.js'

const BOOK_URI = 'md://books/book2'
const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-bookkit-input-'))
  roots.push(root)
  return root
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function captureLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: () => undefined,
    debug: () => undefined,
  }
}

function identityMap(count: number): Record<string, { orig: number; part: number; of: number }> {
  const map: Record<string, { orig: number; part: number; of: number }> = {}
  for (let n = 1; n <= count; n++) map[String(n)] = { orig: n, part: 1, of: 1 }
  return map
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('forcedBranch', () => {
  it('recognises only translate and preprocess', () => {
    expect(forcedBranch({ root: '/x', env: { MT_FORCE_BRANCH: 'translate' } })).toBe('translate')
    expect(forcedBranch({ root: '/x', env: { MT_FORCE_BRANCH: 'preprocess' } })).toBe('preprocess')
    expect(forcedBranch({ root: '/x', env: { MT_FORCE_BRANCH: 'other' } })).toBeUndefined()
    expect(forcedBranch({ root: '/x', env: {} })).toBeUndefined()
  })

  it('honours a custom force-branch env var', () => {
    expect(
      forcedBranch({
        root: '/x',
        forceBranchEnv: 'TEST_BRANCH',
        env: { TEST_BRANCH: 'preprocess' },
      }),
    ).toBe('preprocess')
  })
})

describe('createBookSource', () => {
  it('lets the forced branch win over the recorded verdict', async () => {
    const root = await tempRoot()
    await writeJson(join(root, 'chapters', 'schema', 'quality.json'), {
      version: 1,
      verdict: 'preprocess',
    })

    const source = createBookSource({
      root,
      bookUri: BOOK_URI,
      env: { MT_FORCE_BRANCH: 'translate' },
    })

    expect(source(captureLogger())).toBe(BOOK_URI)
  })

  it('warns exactly once and uses the book URI when quality.json is missing', async () => {
    const root = await tempRoot()
    const logger = captureLogger()
    const source = createBookSource({ root, bookUri: BOOK_URI })

    expect(source(logger)).toBe(BOOK_URI)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('quality.json missing')
  })

  it('warns and uses the book URI when quality.json is invalid', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'chapters', 'schema'), { recursive: true })
    await writeFile(join(root, 'chapters', 'schema', 'quality.json'), '{not json', 'utf-8')
    const logger = captureLogger()

    expect(createBookSource({ root, bookUri: BOOK_URI })(logger)).toBe(BOOK_URI)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('not valid JSON')
  })

  it('routes a preprocess verdict to the cleaned chapter tree', async () => {
    const root = await tempRoot()
    await writeJson(join(root, 'chapters', 'schema', 'quality.json'), {
      version: 1,
      verdict: 'preprocess',
    })

    expect(createBookSource({ root, bookUri: BOOK_URI })()).toBe('md://./chapters/clean')
  })

  it('routes a translate verdict to the split tree when the split stage produced parts', async () => {
    const root = await tempRoot()
    await writeJson(join(root, 'chapters', 'schema', 'quality.json'), {
      version: 1,
      verdict: 'translate',
    })
    await writeJson(join(root, 'chapters', 'schema', 'chapter-map.json'), {
      '1': { orig: 1, part: 1, of: 2 },
      '2': { orig: 1, part: 2, of: 2 },
    })

    expect(createBookSource({ root, bookUri: BOOK_URI })()).toBe('md://./chapters/split')
  })

  it('keeps the book URI for an identity split', async () => {
    const root = await tempRoot()
    await writeJson(join(root, 'chapters', 'schema', 'quality.json'), {
      version: 1,
      verdict: 'translate',
    })
    await writeJson(join(root, 'chapters', 'schema', 'chapter-map.json'), identityMap(2))

    expect(createBookSource({ root, bookUri: BOOK_URI })()).toBe(BOOK_URI)
  })

  it('uses an explicit output root for the split and clean URIs', async () => {
    const root = await tempRoot()
    const out = join(root, 'out')
    const options = { root, bookUri: BOOK_URI, env: { MT_CHAPTERS_ROOT: `md://${out}` } }
    await writeJson(join(out, 'schema', 'quality.json'), { version: 1, verdict: 'preprocess' })
    const source = createBookSource(options)

    expect(source()).toBe(`md://${out}/clean`)

    await writeJson(join(out, 'schema', 'quality.json'), { version: 1, verdict: 'translate' })
    await writeJson(join(out, 'schema', 'chapter-map.json'), {
      '1': { orig: 1, part: 1, of: 2 },
      '2': { orig: 1, part: 2, of: 2 },
    })
    expect(source()).toBe(`md://${out}/split`)
  })
})
