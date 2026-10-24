import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isDirectory, readDirectory, readTextFile, readTextFileSync } from '../src/core/fs-read.js'
import { atomicWriteFile } from '../src/core/fs-write.js'

// ---------------------------------------------------------------------------
// fs-write
// ---------------------------------------------------------------------------

describe('atomicWriteFile (fs-write)', () => {
  it('writes content readable via fs-read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fs-tools-'))
    const file = join(dir, 'out.txt')

    await atomicWriteFile(file, 'hello world')

    expect(await readTextFile(file)).toBe('hello world')
  })

  it('leaves no temp sibling behind after the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fs-tools-'))
    const file = join(dir, 'clean.txt')

    await atomicWriteFile(file, 'x')

    expect(await readdir(dir)).toEqual(['clean.txt'])
  })

  it('overwrites an existing file atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fs-tools-'))
    const file = join(dir, 'overwrite.txt')
    await writeFile(file, 'before', 'utf-8')

    await atomicWriteFile(file, 'after')

    expect(await readFile(file, 'utf-8')).toBe('after')
  })
})

// ---------------------------------------------------------------------------
// fs-read
// ---------------------------------------------------------------------------

describe('fs-read', () => {
  it('readTextFile reads utf-8 content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fs-tools-'))
    const file = join(dir, 'in.txt')
    await writeFile(file, 'some content', 'utf-8')

    await expect(readTextFile(file)).resolves.toBe('some content')
  })

  it('readTextFileSync matches readTextFile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fs-tools-'))
    const file = join(dir, 'sync.txt')
    await writeFile(file, 'sync content', 'utf-8')

    expect(readTextFileSync(file)).toBe('sync content')
  })

  it('readDirectory returns entries with file types', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fs-tools-'))
    await writeFile(join(dir, 'a.txt'), 'a', 'utf-8')
    await mkdtemp(join(dir, 'sub-'))

    const entries = await readDirectory(dir)
    const names = entries.map((e) => e.name).sort()

    expect(names).toHaveLength(2)
    expect(entries.find((e) => e.name === 'a.txt')?.isFile()).toBe(true)
    expect(entries.find((e) => e.name.startsWith('sub-'))?.isDirectory()).toBe(true)
  })

  it('isDirectory distinguishes files from directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-fs-tools-'))
    const file = join(dir, 'f.txt')
    await writeFile(file, 'f', 'utf-8')

    await expect(isDirectory(dir)).resolves.toBe(true)
    await expect(isDirectory(file)).resolves.toBe(false)
  })
})
