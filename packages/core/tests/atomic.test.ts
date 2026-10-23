import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AtomicStreamWriter,
  atomicWriteFile,
  removeStaleTmpFiles,
  tmpPathFor,
} from '../src/atomic.js'

describe('tmpPathFor', () => {
  it('places the temp file next to the target', () => {
    const tmp = tmpPathFor('/tmp/out/data.json', 'run-1')
    expect(tmp.startsWith('/tmp/out/data.json.tmp.')).toBe(true)
  })

  it('generates a unique path when no tag is given', () => {
    const a = tmpPathFor('/tmp/out/data.json')
    const b = tmpPathFor('/tmp/out/data.json')
    expect(a).not.toBe(b)
  })
})

describe('atomicWriteFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-atomic-'))
  })

  it('writes the content and leaves no temp files behind', async () => {
    const file = join(dir, 'data.txt')
    await atomicWriteFile(file, 'hello')
    expect(await readFile(file, 'utf-8')).toBe('hello')
    expect(readdirSync(dir)).toEqual(['data.txt'])
  })

  it('replaces an existing file wholesale (no partial merge)', async () => {
    const file = join(dir, 'data.txt')
    writeFileSync(file, 'a very long previous content', 'utf-8')
    await atomicWriteFile(file, 'short')
    expect(await readFile(file, 'utf-8')).toBe('short')
  })

  it('cleans up the temp file when the rename fails', async () => {
    // A directory in place of the target makes rename() fail on Linux.
    const file = join(dir, 'blocked')
    mkdirSync(file)
    await expect(atomicWriteFile(file, 'x')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['blocked'])
  })
})

describe('removeStaleTmpFiles', () => {
  it('removes only temp siblings of the given path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-atomic-stale-'))
    const file = join(dir, 'out.jsonl')
    writeFileSync(file, 'kept', 'utf-8')
    writeFileSync(`${file}.tmp.run-1`, 'junk', 'utf-8')
    writeFileSync(`${file}.tmp.run-2`, 'junk', 'utf-8')
    writeFileSync(join(dir, 'other.tmp.run-1'), 'junk', 'utf-8')

    await removeStaleTmpFiles(file)

    expect((await readdir(dir)).sort()).toEqual(['other.tmp.run-1', 'out.jsonl'])
  })

  it('does not throw when the directory is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-atomic-stale-'))
    await expect(removeStaleTmpFiles(join(dir, 'nope', 'out.md'))).resolves.toBeUndefined()
  })
})

describe('AtomicStreamWriter', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-atomic-stream-'))
  })

  it('commits buffered content on commit()', async () => {
    const file = join(dir, 'out.jsonl')
    const writer = await AtomicStreamWriter.open(file, 'run-1')
    writer.write('{"item":1}\n')
    writer.write('{"item":2}\n')
    await writer.commit()

    expect(await readFile(file, 'utf-8')).toBe('{"item":1}\n{"item":2}\n')
    expect(readdirSync(dir)).toEqual(['out.jsonl'])
  })

  it('leaves no final file when the run is abandoned (crash mid-run)', async () => {
    const file = join(dir, 'out.jsonl')
    const writer = await AtomicStreamWriter.open(file, 'run-1')
    writer.write('{"item":1}\n')
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir)).toEqual(['out.jsonl.tmp.run-1'])
  })

  it('rerun does not duplicate lines', async () => {
    const file = join(dir, 'out.jsonl')
    const first = await AtomicStreamWriter.open(file, 'run-1')
    first.write('{"item":1}\n')
    await first.commit()

    const second = await AtomicStreamWriter.open(file, 'run-2')
    second.write('{"item":1}\n')
    await second.commit()

    expect(await readFile(file, 'utf-8')).toBe('{"item":1}\n')
    expect(readdirSync(dir)).toEqual(['out.jsonl'])
  })

  it('cleaning stale temp files on open discards a crashed run', async () => {
    const file = join(dir, 'out.jsonl')
    const crashed = await AtomicStreamWriter.open(file, 'run-1')
    crashed.write('{"item":"stale"}\n')

    const rerun = await AtomicStreamWriter.open(file, 'run-2')
    rerun.write('{"item":"fresh"}\n')
    await rerun.commit()

    expect(await readFile(file, 'utf-8')).toBe('{"item":"fresh"}\n')
    expect(readdirSync(dir)).toEqual(['out.jsonl'])
  })

  it('abort() removes the temp file without touching the target', async () => {
    const file = join(dir, 'out.jsonl')
    writeFileSync(file, 'previous', 'utf-8')
    const writer = await AtomicStreamWriter.open(file, 'run-1')
    writer.write('{"item":1}\n')
    await writer.abort()

    expect(await readFile(file, 'utf-8')).toBe('previous')
    expect(readdirSync(dir)).toEqual(['out.jsonl'])
  })
})
