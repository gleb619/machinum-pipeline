import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const MT_STATE_DIR = join(SAMPLE_DIR, '.mt')
const ENV = { ...process.env, NODE_OPTIONS: '--import tsx' }

interface ExplainedStep {
  type: string
}

interface ExplainedPipeline {
  id: string
  stepCount: number
  steps: ExplainedStep[]
}

interface Explanation {
  schemaVersion: number
  runnable: {
    kind: 'pipeline' | 'suite'
    pipelines: ExplainedPipeline[]
  }
  runtime: {
    files: Record<string, string>
  }
}

type StateSnapshot = { exists: false } | { exists: true; entries: string[] }

function explainJson(args: string[]): Explanation {
  const stdout = execFileSync(MT_BIN, ['explain', ...args, '--json'], {
    cwd: SAMPLE_DIR,
    encoding: 'utf8',
    env: ENV,
    stdio: 'pipe',
    timeout: 15_000,
  })
  return JSON.parse(stdout) as Explanation
}

async function snapshotStateDir(): Promise<StateSnapshot> {
  try {
    const entries = await readdir(MT_STATE_DIR, { recursive: true })
    return { exists: true, entries: entries.sort() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
}

describe('mt explain', () => {
  it('prints the declared normalize flow as JSON', () => {
    const parsed = explainJson(['./pipelines/normalize.ts'])

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.runnable.kind).toBe('pipeline')

    const pipeline = parsed.runnable.pipelines[0]
    const types = pipeline?.steps.map((step) => step.type) ?? []
    expect(types).toContain('source')
    expect(types).toContain('target')
  })

  it('selects a named export with --pipeline', () => {
    const parsed = explainJson(['./pipelines/normalize.ts', '--pipeline', 'normalizeFlow'])

    const pipeline = parsed.runnable.pipelines[0]
    expect(pipeline?.stepCount).toBe(11)
    expect(pipeline?.steps.map((step) => step.type)).toContain('source')
  })

  it('creates no run state', async () => {
    const before = await snapshotStateDir()

    explainJson(['./pipelines/normalize.ts'])

    expect(await snapshotStateDir()).toEqual(before)
  })

  it('reports the run artifact paths', () => {
    const { files } = explainJson(['./pipelines/normalize.ts']).runtime

    expect(files['events.jsonl']).toBeTruthy()
    expect(files['logs/<stepId>.log']).toBeTruthy()
    expect(files['dead-letter.jsonl']).toBeTruthy()
  })
})
