import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, GlobalContext, Pipeline, RunEvent } from '../../src/types.js'
import { registry } from '../../src/uri.js'

const sourceItems: Array<Envelope<unknown>> = []
const written: Array<Envelope<unknown>> = []

registry.registerSource('default-target-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('default-target-target', (uri) => ({
  uri: uri.raw,
  async open() {},
  async write(env: Envelope<unknown>) {
    written.push(env)
  },
  async close() {},
}))

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

let projectRoot: string

function context(): GlobalContext {
  return {
    project: { name: 'default-target-test', root: projectRoot },
    defaults: { retry: defaultRetry, onError: 'fail-run' as const, concurrency: 1 },
    settings: {},
    env: {},
  }
}

async function events(runId: string): Promise<RunEvent[]> {
  const raw = await readFile(join(projectRoot, '.mt', 'runs', runId, 'events.jsonl'), 'utf-8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunEvent)
}

describe('runner default target', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-default-target-'))
    sourceItems.length = 0
    written.length = 0
  })

  it('runs a pipeline with a source and no target (the envelopes drain to void)', async () => {
    sourceItems.push({ id: 'ex-void', variables: [], item: 'a', meta: {} })

    const pipeline: Pipeline = {
      id: 'default-target',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [{ type: 'source', config: { uri: 'default-target-source://in' } }],
    }

    const runner = new Runner(pipeline, context())
    await runner.start()

    const runId = runner.getRunId()
    if (!runId) throw new Error('run did not mint a runId')
    const lines = await events(runId)
    expect(lines.at(-1)?.type).toBe('done')
    // The void target is a real step — it reports its own step-done.
    expect(lines.map((line) => line.stepId)).toContain('target-target-2')
  })

  it('leaves a pipeline with an explicit target alone', async () => {
    sourceItems.push({ id: 'ex-explicit', variables: [], item: 'a', meta: {} })

    const pipeline: Pipeline = {
      id: 'explicit-target',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'default-target-source://in' } },
        { type: 'target', config: { uri: 'default-target-target://out' } },
      ],
    }

    const runner = new Runner(pipeline, context())
    await runner.start()

    expect(written).toHaveLength(1)
    const runId = runner.getRunId()
    if (!runId) throw new Error('run did not mint a runId')
    const steps = (await events(runId))
      .filter((line) => line.type === 'step-done')
      .map((line) => line.stepId)
    expect(steps).toEqual(['source-source-1', 'target-target-2'])
  })
})
