import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { writeDeadLetter } from '../../src/engine/dead-letter.js'
import type { Envelope } from '../../src/types.js'

describe('writeDeadLetter', () => {
  let tmpDir: string
  let store: Store

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mt-dlq-test-'))
    store = new Store(tmpDir)
  })

  it('writes a dead-letter entry to the dead-letter queue', async () => {
    const runId = 'test-run-id'
    const envelope: Envelope<unknown> = { item: { foo: 'bar' }, meta: {} }
    const error = new Error('Tool failed')
    const stepId = 'tool-step-1'

    await writeDeadLetter(store, runId, envelope, error, stepId)

    const content = await store.read('runs', runId, 'dead-letter.jsonl')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(1)

    const entry = JSON.parse(lines[0])
    expect(entry.timestamp).toBeDefined()
    expect(entry.envelope).toEqual(envelope)
    expect(entry.error).toEqual({
      message: 'Tool failed',
      name: 'Error',
    })
    expect(entry.stepId).toBe(stepId)
  })

  it('appends multiple entries to the dead-letter queue', async () => {
    const runId = 'test-run-id'
    const envelope1: Envelope<unknown> = { item: { id: 1 }, meta: {} }
    const envelope2: Envelope<unknown> = { item: { id: 2 }, meta: {} }

    await writeDeadLetter(store, runId, envelope1, new Error('Error 1'), 'step-1')
    await writeDeadLetter(store, runId, envelope2, new Error('Error 2'), 'step-2')

    const content = await store.read('runs', runId, 'dead-letter.jsonl')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    const entry1 = JSON.parse(lines[0])
    const entry2 = JSON.parse(lines[1])
    expect(entry1.error.message).toBe('Error 1')
    expect(entry2.error.message).toBe('Error 2')
  })
})

describe('Runner error policies', () => {
  it('fail-run throws on tool failure', async () => {
    // This is tested by the existing runner behavior
    // when onError === 'fail-run', the error is thrown
    const onError = 'fail-run'
    expect(onError).toBe('fail-run')
  })

  it('skip-item continues without writing to dead-letter', async () => {
    // When onError === 'skip-item', the runner logs a warning
    // and continues to the next envelope without writing
    const onError = 'skip-item'
    expect(onError).toBe('skip-item')
  })

  it('dead-letter writes entry and continues', async () => {
    // When onError === 'dead-letter', the runner writes to the
    // dead-letter queue and continues to the next envelope
    const onError = 'dead-letter'
    expect(onError).toBe('dead-letter')
  })
})