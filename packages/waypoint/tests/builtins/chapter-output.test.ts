import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TargetContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChapterOutputTarget } from '../../src/chapter-output.js'
import type { ParsedUri } from '../../src/uri.js'

import '../../src/chapter-output.js'

describe('chapter-output target — path validation', () => {
  let tempDir: string
  let baseDir: string
  let ctx: TargetContext

  const uri = (): ParsedUri => ({
    raw: `chapter-output://${baseDir}`,
    host: baseDir,
    path: baseDir,
    query: {},
  })

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chapter-output-test-'))
    baseDir = join(tempDir, 'chapters')
    mkdirSync(baseDir, { recursive: true })
    ctx = {
      run: {
        runId: 'run-1',
        global: { project: { name: 'test', root: tempDir }, settings: {} },
      },
    } as unknown as TargetContext
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('writes <lang>/chapter<num>.md for valid meta', async () => {
    const target = createChapterOutputTarget<string>(uri())
    await target.open(ctx)
    await target.write({ item: '# Глава 3', meta: { lang: 'ru', chapterNum: 3 } }, ctx)
    await target.close(ctx)

    expect(readFileSync(join(baseDir, 'ru', 'chapter3.md'), 'utf-8')).toBe('# Глава 3')
  })

  it('writes chapter<num>.md at the root when lang is absent', async () => {
    const target = createChapterOutputTarget<string>(uri())
    await target.open(ctx)
    await target.write({ item: '# One', meta: {} }, ctx)
    await target.close(ctx)

    expect(readFileSync(join(baseDir, 'chapter1.md'), 'utf-8')).toBe('# One')
  })

  it('rejects lang that escapes the target root', async () => {
    const target = createChapterOutputTarget<string>(uri())
    await target.open(ctx)
    await expect(
      target.write({ item: 'x', meta: { lang: '../x', chapterNum: 1 } }, ctx),
    ).rejects.toThrow(/meta\.lang/)

    expect(readdirSync(baseDir)).toEqual([])
    expect(existsSync(join(tempDir, 'x'))).toBe(false)
  })

  it('rejects lang containing a path separator', async () => {
    const target = createChapterOutputTarget<string>(uri())
    await target.open(ctx)
    await expect(
      target.write({ item: 'x', meta: { lang: 'a/b', chapterNum: 1 } }, ctx),
    ).rejects.toThrow(/meta\.lang/)

    expect(readdirSync(baseDir)).toEqual([])
    expect(existsSync(join(baseDir, 'a'))).toBe(false)
  })

  it('rejects a string chapterNum that escapes via the filename', async () => {
    const target = createChapterOutputTarget<string>(uri())
    await target.open(ctx)
    await expect(
      target.write({ item: 'x', meta: { chapterNum: '1/../../x' } }, ctx),
    ).rejects.toThrow(/meta\.chapterNum/)

    expect(readdirSync(baseDir)).toEqual([])
    expect(existsSync(join(tempDir, 'x.md'))).toBe(false)
  })

  it('rejects a negative chapterNum', async () => {
    const target = createChapterOutputTarget<string>(uri())
    await target.open(ctx)
    await expect(target.write({ item: 'x', meta: { chapterNum: -1 } }, ctx)).rejects.toThrow(
      /meta\.chapterNum/,
    )

    expect(readdirSync(baseDir)).toEqual([])
  })

  it('rejects a non-integer chapterNum', async () => {
    const target = createChapterOutputTarget<string>(uri())
    await target.open(ctx)
    await expect(target.write({ item: 'x', meta: { chapterNum: 1.5 } }, ctx)).rejects.toThrow(
      /meta\.chapterNum/,
    )

    expect(readdirSync(baseDir)).toEqual([])
  })

  it('rejects a NaN chapterNum', async () => {
    const target = createChapterOutputTarget<string>(uri())
    await target.open(ctx)
    await expect(
      target.write({ item: 'x', meta: { chapterNum: Number.NaN } }, ctx),
    ).rejects.toThrow(/meta\.chapterNum/)

    expect(readdirSync(baseDir)).toEqual([])
  })
})
