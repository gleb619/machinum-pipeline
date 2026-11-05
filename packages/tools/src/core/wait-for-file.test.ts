import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exchange, ToolContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWaitForFile, waitForFile } from './wait-for-file.js'

function makeContext(root: string): ToolContext {
  return {
    run: {
      global: { project: { name: 'test', root }, settings: {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    },
  } as unknown as ToolContext
}

function exchange(item: unknown, id = 'env-1'): Exchange<unknown> {
  return { id, item, meta: {}, variables: [] }
}

describe('wait-for-file', () => {
  let tempDir: string
  let ctx: ToolContext

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mt-wait-for-file-'))
    ctx = makeContext(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('resolves immediately when the latch already exists', async () => {
    const latch = join(tempDir, 'ready.latch')
    writeFileSync(latch, '')
    const tool = createWaitForFile({ path: latch })
    const result = await tool.invoke(exchange('a'), ctx)
    expect(result.id).toBe('env-1')
    expect(existsSync(latch)).toBe(true)
  })

  it('waits until another process creates the latch', async () => {
    const latch = join(tempDir, 'later.latch')
    const tool = createWaitForFile({ path: latch, pollMs: 10 })
    const timer = setTimeout(() => writeFileSync(latch, ''), 50)
    try {
      await tool.invoke(exchange('a'), ctx)
    } finally {
      clearTimeout(timer)
    }
    expect(existsSync(latch)).toBe(true)
  })

  it('substitutes {item} and {id} in the path template', async () => {
    const expected = join(tempDir, 'item-7', '7.latch')
    mkdirSync(join(tempDir, 'item-7'), { recursive: true })
    writeFileSync(expected, '')
    const tool = createWaitForFile({ path: './{id}/{item}.latch', pollMs: 10 })
    const result = await tool.invoke(exchange(7, 'item-7'), ctx)
    const latchFile = result.variables.find((v) => v.name === 'latchFile')
    expect(latchFile?.value).toBe(expected)
  })

  it('throws a non-retryable error on timeout', async () => {
    const tool = createWaitForFile({ path: join(tempDir, 'never.latch'), pollMs: 5, timeoutMs: 20 })
    await expect(tool.invoke(exchange('a'), ctx)).rejects.toMatchObject({
      retryable: false,
      name: 'LatchTimeoutError',
    })
  })

  it('removes the latch when consume is set', async () => {
    const latch = join(tempDir, 'once.latch')
    writeFileSync(latch, '')
    const tool = createWaitForFile({ path: latch, consume: true })
    await tool.invoke(exchange('a'), ctx)
    expect(existsSync(latch)).toBe(false)
  })

  it('exposes the latch path as a variable and is idempotent', async () => {
    const latch = join(tempDir, 'idem.latch')
    writeFileSync(latch, '')
    const tool = createWaitForFile({ path: latch })
    expect(tool.idempotent).toBe(true)
    const first = await tool.invoke(exchange('a'), ctx)
    const second = await tool.invoke(first, ctx)
    expect(second.variables.find((v) => v.name === 'latchFile')?.value).toBe(latch)
    expect(readFileSync(latch, 'utf-8')).toBe('')
  })

  it('ships a default waitForFile instance', () => {
    expect(waitForFile.name).toBe('wait-for-file')
    expect(waitForFile.idempotent).toBe(true)
  })
})
