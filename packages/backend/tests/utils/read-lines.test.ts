import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readNewLines } from '../../server/utils/read-lines.js'

describe('readNewLines', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-read-lines-'))
    file = join(dir, 'events.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns complete lines with a byte-accurate nextOffset', async () => {
    await writeFile(file, '{"type":"a"}\n{"type":"b"}\n')
    const { lines, nextOffset } = await readNewLines(file, 0)
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}'])
    expect(nextOffset).toBe(Buffer.byteLength('{"type":"a"}\n{"type":"b"}\n'))
  })

  it('tracks byte offsets across multi-byte (Cyrillic) content', async () => {
    const first = '{"type":"Глава 1 — начало"}\n'
    const second = '{"type":"ошибка"}\n'
    await writeFile(file, first)
    const firstRead = await readNewLines(file, 0)
    expect(firstRead.lines).toHaveLength(1)
    expect(firstRead.nextOffset).toBe(Buffer.byteLength(first))
    await appendFile(file, second)
    const secondRead = await readNewLines(file, firstRead.nextOffset)
    expect(secondRead.lines).toEqual([second.trim()])
    expect(secondRead.nextOffset).toBe(Buffer.byteLength(first + second))
  })

  it('holds back a partial trailing line and keeps the offset before it', async () => {
    await writeFile(file, '{"type":"a"}\n{"type":"par')
    const { lines, nextOffset } = await readNewLines(file, 0)
    expect(lines).toEqual(['{"type":"a"}'])
    expect(nextOffset).toBe(Buffer.byteLength('{"type":"a"}\n'))

    await writeFile(file, '{"type":"a"}\n{"type":"partial"}\n')
    const resumed = await readNewLines(file, nextOffset)
    expect(resumed.lines).toEqual(['{"type":"partial"}'])
  })

  it('delivers a single line larger than the 64 KB stream chunk intact', async () => {
    const big = JSON.stringify({ type: 'big', text: 'x'.repeat(200_000) })
    await writeFile(file, `${big}\n`)
    const { lines, nextOffset } = await readNewLines(file, 0)
    expect(lines).toEqual([big])
    expect(nextOffset).toBe(Buffer.byteLength(big) + 1)
    expect(JSON.parse(lines[0] ?? '').text).toHaveLength(200_000)
  })

  it('returns nothing from an offset at end of file', async () => {
    await writeFile(file, '{"type":"a"}\n')
    const offset = Buffer.byteLength('{"type":"a"}\n')
    const { lines, nextOffset } = await readNewLines(file, offset)
    expect(lines).toEqual([])
    expect(nextOffset).toBe(offset)
  })
})
