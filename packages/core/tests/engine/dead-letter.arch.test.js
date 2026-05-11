import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeDeadLetter } from '../../src/engine/dead-letter.js'
import { Store } from '../../src/store.js'
describe('UC-18 — Dead-letter queue (architectural)', () => {
  it('writeDeadLetter is exported as a function', () => {
    expect(typeof writeDeadLetter).toBe('function')
    expect(writeDeadLetter.length).toBe(5)
  })
  it('DeadLetterEntry shape — timestamp, envelope, error, stepId', () => {
    const entry = {
      timestamp: new Date().toISOString(),
      envelope: { item: { test: true }, meta: {} },
      error: { message: 'test error', name: 'Error' },
      stepId: 'tool-test-123',
    }
    expect(typeof entry.timestamp).toBe('string')
    expect(entry.envelope.item).toEqual({ test: true })
    expect(entry.error.message).toBe('test error')
    expect(entry.error.name).toBe('Error')
    expect(entry.stepId).toBe('tool-test-123')
  })
  it('writeDeadLetter writes entry under runs/<runId>/dead-letter.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-test-dl-'))
    const store = new Store(dir)
    const runId = 'run-abc'
    await writeDeadLetter(
      store,
      runId,
      { item: { bad: true }, meta: {} },
      new Error('simulated failure'),
      'tool-foo-1',
    )
    // Verify file was created
    const expectedPath = join(dir, 'runs', runId, 'dead-letter.jsonl')
    expect(existsSync(expectedPath)).toBe(true)
    // Verify content is NDJSON
    const content = await store.read('runs', runId, 'dead-letter.jsonl')
    const parsed = JSON.parse(content.trim())
    expect(parsed.envelope.item).toEqual({ bad: true })
    expect(parsed.error.message).toBe('simulated failure')
    expect(parsed.stepId).toBe('tool-foo-1')
    rmSync(dir, { recursive: true, force: true })
  })
})
//# sourceMappingURL=dead-letter.arch.test.js.map
