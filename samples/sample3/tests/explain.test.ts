import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const ENV = { ...process.env, NODE_OPTIONS: '--import tsx' }

const PIPELINE = `import { definePipeline } from '@mt/core'
import '@mt/waypoint'

console.log('explain fixture: module imported')
process.stdout.write('explain fixture: raw stdout write on import\\n')

const innerFlow = definePipeline()
  .from('ephemeral://explain-input')
  .tap(async () => {})
  .to('ephemeral://explain-output')

export const namedFlow = definePipeline()
  .from('ephemeral://named-input')
  .to('ephemeral://named-output')

export default definePipeline().subflow(innerFlow)
`

interface ExplainedStep {
  type: string
  nested?: ExplainedPipeline[]
}

interface ExplainedPipeline {
  stepCount: number
  steps: ExplainedStep[]
}

interface Explanation {
  schemaVersion: number
  command: 'mt explain'
  runnable: {
    kind: 'pipeline' | 'suite'
    pipelines: ExplainedPipeline[]
  }
  runtime: {
    files: Record<string, string>
  }
}

let projectDir: string

function explainJson(args: string[]): Explanation {
  return explainJsonFrom(projectDir, args)
}

function explainJsonFrom(cwd: string, args: string[]): Explanation {
  const stdout = execFileSync(MT_BIN, ['explain', ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    env: ENV,
    stdio: 'pipe',
    timeout: 15_000,
  })
  return JSON.parse(stdout) as Explanation
}

beforeAll(async () => {
  projectDir = await mkdtemp(join(SAMPLE_DIR, '.tmp-explain-'))
  await mkdir(join(projectDir, 'pipelines'), { recursive: true })
  await writeFile(
    join(projectDir, 'mt.json'),
    JSON.stringify({
      project: { name: 'explain-temp' },
      defaults: { onError: 'fail-run', concurrency: 2 },
    }),
    'utf-8',
  )
  await writeFile(join(projectDir, 'pipelines', 'explain.ts'), PIPELINE, 'utf-8')
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('mt explain', () => {
  it('reports nested dataflow and runtime files without creating run state', async () => {
    const parsed = explainJson(['pipelines/explain.ts'])

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.runnable.kind).toBe('pipeline')

    const root = parsed.runnable.pipelines[0]
    expect(root?.steps.map((step) => step.type)).toEqual(['subflow'])

    const subflow = root?.steps[0]
    expect(subflow?.nested).toHaveLength(1)
    expect(subflow?.nested?.[0]?.steps.map((step) => step.type)).toEqual([
      'source',
      'tap',
      'target',
    ])
    expect(subflow?.nested?.[0]?.stepCount).toBe(3)

    expect(parsed.runtime.files['events.jsonl']).toBeTruthy()
    expect(parsed.runtime.files['logs/<stepId>.log']).toBeTruthy()

    await expect(access(join(projectDir, '.mt'))).rejects.toThrow()
    await expect(access(join(projectDir, '.mt', 'runs'))).rejects.toThrow()
  })

  it('selects a named export with --pipeline', () => {
    const parsed = explainJson(['pipelines/explain.ts', '--pipeline', 'namedFlow'])

    const selected = parsed.runnable.pipelines[0]
    expect(selected?.stepCount).toBe(2)
    expect(selected?.steps.map((step) => step.type)).toEqual(['source', 'target'])
  })

  it('explains a sample named export as a pipeline with tool steps', () => {
    const parsed = explainJsonFrom(SAMPLE_DIR, [
      './pipelines/jsonl-to-md-multi.ts',
      '--pipeline',
      'schemaDocPipeline',
    ])

    expect(parsed.runnable.kind).toBe('pipeline')
    expect(parsed.runnable.pipelineCount).toBe(1)
    const selected = parsed.runnable.pipelines[0]
    expect(selected?.steps.some((step) => step.type === 'tool')).toBe(true)
  })

  it('creates no .mt directory in the explained project', async () => {
    explainJson(['pipelines/explain.ts'])

    await expect(access(join(projectDir, '.mt'))).rejects.toThrow()
    await expect(access(join(projectDir, '.mt', 'runs'))).rejects.toThrow()
  })

  it('keeps stdout parseable when the pipeline module logs on import', () => {
    const parsed = explainJson(['pipelines/explain.ts'])

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.command).toBe('mt explain')
  })
})
