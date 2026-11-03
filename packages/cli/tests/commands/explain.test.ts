import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { explainCommand } from '../../src/commands/explain.js'

vi.mock('@mt/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mt/core')>()
  return {
    ...actual,
    importPipelineModule: vi.fn(
      async (filePath: string) => (await import(filePath)) as Record<string, unknown>,
    ),
  }
})

const retry = { max: 3, backoffMs: 1000, strategy: 'exp' as const }

interface JsonRetry {
  max: number
  backoffMs: number
  strategy: string
  maxBackoffMs?: number
}

interface JsonStep {
  type: string
  name?: string
  stepIdName?: string
  stepIdPattern?: string
  eventStepId?: string
  checkpointNode?: string
  description?: string
  cardinality?: string
  retry?: JsonRetry
  onError?: string
  concurrency?: number
  cacheable?: boolean
  idempotent?: boolean
  sourceLifestyle?: string
  sourceResumable?: boolean
  targetDurableCheckpoint?: boolean
  splitterType?: string
  nested?: JsonPipeline[]
}

interface JsonPipeline {
  id: string
  retry: JsonRetry
  onError: string
  envDefaults?: Record<string, string>
  stepCount: number
  steps: JsonStep[]
}

interface JsonExplanation {
  project: { name: string; root: string }
  llm?: { tool?: string; model?: string; note: string }
  defaults: { retry: JsonRetry; onError: string; concurrency: number }
  runnable: {
    kind: 'pipeline' | 'suite'
    id: string
    pipelineCount: number
    mode?: 'sync' | 'parallel'
    pipelines: JsonPipeline[]
  }
  runtime: {
    files: Record<string, string>
    eventOrder: string[]
    hooks: Record<string, string | undefined>
  }
  warnings: string[]
}

function toolStep(
  name: string,
  description = `${name} description`,
  overrides: { retry?: Partial<JsonRetry>; onError?: string; concurrency?: string } = {},
) {
  return {
    type: 'tool',
    config: {
      name,
      version: '1.2.3',
      mdDescription: description,
      tool: {
        name,
        version: '1.2.3',
        mdDescription: description,
        cacheable: true,
        invoke: async (ex: unknown) => ex,
      },
      ...overrides,
    },
  }
}

function simplePipeline(id = 'demo') {
  return {
    id,
    retry,
    onError: 'fail-run',
    steps: [
      { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
      toolStep('echo'),
      { type: 'target', config: { uri: 'md://./out' } },
    ],
  }
}

describe('explain command', () => {
  let testDir: string
  let originalCwd: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-explain-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT ${code}`)
    })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.doUnmock(join(testDir, 'pipeline.ts'))
  })

  it('fails without a pipeline file', async () => {
    await expect(explainCommand([])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage: mt explain'))
  })

  it('renders dataflow, events and log locations without creating .mt', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({ default: simplePipeline() }))

    await explainCommand(['pipeline.ts'])

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(output).toContain('# mt explain — pipeline.ts')
    expect(output).toContain('Explain only')
    expect(output).toContain('source jsonl://./in.jsonl')
    expect(output).toContain('tool echo')
    expect(output).toContain('target md://./out')
    expect(output).toContain('state.json')
    expect(output).toContain('events.jsonl')
    expect(output).toContain('run.log')
    expect(output).toContain('logs/<stepId>.log')
    expect(output).toContain('dead-letter.jsonl')
    expect(output).toContain('tool-echo-<seq>')
    expect(output).toContain('source-source-<seq>')
    expect(output).toContain('target-target-<seq>')
    expect(output).toContain('downstream throw')
    expect(output).toContain('created lazily')
    await expect(access(join(testDir, '.mt'))).rejects.toThrow()
  })

  it('emits machine-readable JSON with effective tool policy', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({ default: simplePipeline() }))

    await explainCommand(['pipeline.ts', '--json'])

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0])
    const parsed = JSON.parse(output) as {
      runnable: { pipelines: Array<{ steps: Array<Record<string, unknown>> }> }
      runtime: { files: Record<string, string> }
    }
    const steps = parsed.runnable.pipelines[0]?.steps ?? []
    expect(steps).toHaveLength(3)
    expect(steps[1]).toMatchObject({
      type: 'tool',
      name: 'echo',
      cacheable: true,
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
      concurrency: 4,
    })
    expect(parsed.runtime.files['events.jsonl']).toContain('append-only')
  })

  it('reports effective tool concurrency and ordered mapConcurrent in Markdown', async () => {
    await writeFile(join(testDir, 'mt.json'), JSON.stringify({ defaults: { concurrency: 6 } }))
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'concurrency',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          toolStep('default-limit'),
          toolStep('override-limit', 'override', { concurrency: '2' }),
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.runnable.pipelines[0]?.steps[1]?.concurrency).toBe(6)
    expect(parsed.runnable.pipelines[0]?.steps[2]?.concurrency).toBe(2)

    vi.mocked(console.log).mockClear()
    await explainCommand(['pipeline.ts'])
    const markdown = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(markdown).toContain('concurrency `6`')
    expect(markdown).toContain('concurrency `2`')
    expect(markdown).toContain('ordered `mapConcurrent`')
    expect(markdown).toContain('output order is preserved')
  })

  it('reports envDefaults and hides credential-looking values in Markdown and JSON', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        ...simplePipeline('env-defaults'),
        envDefaults: { MT_CHUNK_SIZE: '40', ACCESS_SECRET: 'super-secret-value' },
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.runnable.pipelines[0]?.envDefaults).toEqual({
      MT_CHUNK_SIZE: '40',
      ACCESS_SECRET: '***',
    })
    expect(JSON.stringify(parsed)).not.toContain('super-secret-value')

    vi.mocked(console.log).mockClear()
    await explainCommand(['pipeline.ts'])
    const markdown = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(markdown).toContain('MT_CHUNK_SIZE=40')
    expect(markdown).toContain('ACCESS_SECRET')
    expect(markdown).not.toContain('super-secret-value')
    expect(markdown).toContain('process.env or the mt.json env')
  })

  it('warns when bare pipelines in one module share the derived id', async () => {
    const { definePipeline } = await import('@mt/core')
    const first = definePipeline()
    const second = definePipeline()
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({ first, second }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    const ids = parsed.runnable.pipelines.map((pipeline) => pipeline.id)
    expect(ids[0]).toBe(ids[1])
    expect(parsed.warnings.join('\n')).toContain(`share id '${ids[0]}'`)
    expect(parsed.warnings.join('\n')).toContain('explicit unique ids')
  })

  it('does not warn when the same pipeline object is reused in several steps', async () => {
    const { definePipeline } = await import('@mt/core')
    const shared = definePipeline({ id: 'reused-child' })
    const parent = {
      id: 'reuse-parent',
      retry,
      onError: 'fail-run',
      steps: [
        { type: 'subflow', config: { pipeline: shared } },
        { type: 'subflow', config: { pipeline: shared } },
      ],
    }
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({ default: parent }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.warnings.join('\n')).not.toContain('share id')
  })

  it('reports the declared mt.json LLM pick with the env override note', async () => {
    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({ settings: { 'llm.tool': 'ollama', 'llm.model': 'qwen-test' } }),
    )
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({ default: simplePipeline() }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.llm).toMatchObject({ tool: 'ollama', model: 'qwen-test' })
    expect(parsed.llm?.note).toContain('MT_LLM_TOOL')

    vi.mocked(console.log).mockClear()
    await explainCommand(['pipeline.ts'])
    const markdown = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(markdown).toContain('LLM (mt.json)')
    expect(markdown).toContain('tool `ollama`')
    expect(markdown).toContain('MT_LLM_MODEL')
  })

  it('sends pipeline import-time stdout to stderr so --json stays parseable', async () => {
    const stderr: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk, encoding?, callback?) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      const done = typeof encoding === 'function' ? encoding : callback
      done?.(null)
      return true
    })

    const pipelinePath = join(testDir, 'noisy.mjs')
    await writeFile(
      pipelinePath,
      `console.log('noise from pipeline import')\nprocess.stdout.write('direct noise\\n')\nexport default ${JSON.stringify(
        simplePipeline('noisy'),
      )}\n`,
    )

    await explainCommand(['noisy.mjs', '--json'])

    const json = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(json).not.toContain('noise from pipeline import')
    expect(() => JSON.parse(json)).not.toThrow()
    expect(stderr.join('')).toContain('noise from pipeline import')
    expect(stderr.join('')).toContain('direct noise')
  })

  it('expands URI aliases from mt.json', async () => {
    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({ project: { name: 'demo-project' }, uris: { en: 'md://./chapters/en' } }),
    )
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'aliases',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          { type: 'target', config: { uri: '@en' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0])
    const parsed = JSON.parse(output) as {
      project: { name: string }
      runnable: { pipelines: Array<{ steps: Array<Record<string, unknown>> }> }
    }
    expect(parsed.project.name).toBe('demo-project')
    expect(parsed.runnable.pipelines[0]?.steps[1]).toMatchObject({
      uri: 'md://./chapters/en',
      alias: '@en',
    })
  })

  it('explains parallel fork branches recursively', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'forked',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          {
            type: 'fork',
            config: {
              name: 'views',
              parallel: true,
              pipelines: [
                { id: 'branch-a', retry, onError: 'fail-run', steps: [toolStep('count')] },
                { id: 'branch-b', retry, onError: 'fail-run', steps: [toolStep('reorder')] },
              ],
            },
          },
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0])
    const parsed = JSON.parse(output) as {
      runnable: {
        pipelines: Array<{
          steps: Array<{
            type: string
            cardinality?: string
            checkpointNode?: string
            nested?: Array<{ id: string }>
          }>
        }>
      }
    }
    const fork = parsed.runnable.pipelines[0]?.steps[1]
    expect(fork?.type).toBe('fork')
    expect(fork?.checkpointNode).toBe('fork-views-<seq>/fork-<parent>/branch-<branch>')
    expect(fork?.cardinality).toContain('sum of 2 branch outputs')
    expect(fork?.nested?.map((p) => p.id)).toEqual(['branch-a', 'branch-b'])
  })

  it('explains a suite in declaration order', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        kind: 'pipeline-suite',
        id: 'demo-suite',
        mode: 'sync',
        pipelines: [simplePipeline('first'), simplePipeline('second')],
        parallel: () => {
          throw new Error('not used')
        },
        run: async () => {},
      },
    }))

    await explainCommand(['pipeline.ts'])

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(output).toContain('suite `demo-suite` (2 pipelines, mode `sync`)')
    expect(output).toContain('1. `first`')
    expect(output).toContain('2. `second`')
  })

  it('selects a named export with --pipeline', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: simplePipeline('default-pipeline'),
      alt: simplePipeline('alt-pipeline'),
    }))

    await explainCommand(['pipeline.ts', '--pipeline', 'alt', '--json'])

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0])
    const parsed = JSON.parse(output) as { runnable: { id: string } }
    expect(parsed.runnable.id).toBe('alt-pipeline')
  })

  it('rejects unknown options', async () => {
    await expect(explainCommand(['pipeline.ts', '--nope'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown option: --nope'))
  })

  it('prints help for -h and --help without loading a pipeline', async () => {
    await explainCommand(['-h'])
    let output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(output).toContain('Usage: mt explain')
    expect(output).toContain('No run id')

    vi.mocked(console.log).mockClear()
    await explainCommand(['--help'])
    output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(output).toContain('Usage: mt explain')
  })

  it('rejects a missing --pipeline value and extra positional arguments', async () => {
    await expect(explainCommand(['pipeline.ts', '--pipeline'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('--pipeline requires a named export'),
    )

    vi.mocked(console.error).mockClear()
    await expect(explainCommand(['one.ts', 'two.ts'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected argument: two.ts'),
    )
  })

  it('explains the implicit sync suite when no default pipeline is exported', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      beta: simplePipeline('beta'),
      alpha: simplePipeline('alpha'),
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.runnable).toMatchObject({
      kind: 'suite',
      id: 'pipeline-suite',
      mode: 'sync',
      pipelineCount: 2,
    })
    expect(parsed.runnable.pipelines.map((pipeline) => pipeline.id)).toEqual(['alpha', 'beta'])
  })

  it('uses the Runner fallback id for a sequential fork and explains its child', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'sequential-fork',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          {
            type: 'fork',
            config: {
              pipeline: {
                id: 'fork-child',
                retry,
                onError: 'fail-run',
                steps: [toolStep('echo')],
              },
            },
          },
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    const fork = parsed.runnable.pipelines[0]?.steps[1]
    expect(fork).toMatchObject({
      type: 'fork',
      stepIdName: 'fork',
      stepIdPattern: 'fork-fork-<seq>',
      eventStepId: 'fork-fork-<seq>',
      checkpointNode: 'fork-fork-<seq>/fork-<n>',
      cardinality: '1 → child output',
    })
    expect(fork?.nested?.[0]?.id).toBe('fork-child')
    expect(fork?.nested?.[0]?.steps[0]).toMatchObject({
      type: 'tool',
      stepIdPattern: 'tool-echo-<seq>',
      stepIdName: 'echo',
    })
  })

  it('explains batch with a nested scope and zero-based group nodes', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'batch-scope',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          {
            type: 'batch',
            config: {
              size: 2,
              pipeline: {
                id: 'scope-child',
                retry,
                onError: 'fail-run',
                steps: [toolStep('scope-tool')],
              },
            },
          },
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    const batch = parsed.runnable.pipelines[0]?.steps[1]
    expect(batch).toMatchObject({
      type: 'batch',
      stepIdName: 'batch',
      stepIdPattern: 'batch-batch-<seq>',
      checkpointNode: 'batch-batch-<seq>/batch-<n>',
      cardinality: 'N → N (members patched)',
    })
    expect(batch?.description).toContain('every 2')
    expect(batch?.nested?.[0]?.id).toBe('scope-child')
    expect(batch?.nested?.[0]?.steps[0]?.stepIdPattern).toBe('tool-scope-tool-<seq>')
  })

  it('keeps split step ids based on the step name, not the splitter name', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'splitter',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          {
            type: 'split',
            config: {
              splitter: { name: 'paragraphSplitter', split: (item: unknown) => [item] },
              splitterType: '#paragraphs',
            },
          },
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    const split = parsed.runnable.pipelines[0]?.steps[1]
    expect(split).toMatchObject({
      type: 'split',
      name: 'paragraphSplitter',
      splitterType: '#paragraphs',
      stepIdName: 'split',
      stepIdPattern: 'split-split-<seq>',
      eventStepId: 'split-split-<seq>',
      cardinality: '1 → N',
    })
  })

  it('explains a subflow and its nested checkpoint node', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'subflow-parent',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          {
            type: 'subflow',
            config: {
              pipeline: {
                id: 'inline-child',
                retry,
                onError: 'fail-run',
                steps: [toolStep('inline-tool')],
              },
            },
          },
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    const subflow = parsed.runnable.pipelines[0]?.steps[1]
    expect(subflow).toMatchObject({
      type: 'subflow',
      stepIdName: 'subflow',
      stepIdPattern: 'subflow-subflow-<seq>',
      checkpointNode: 'subflow-subflow-<seq>/subflow',
    })
    expect(subflow?.nested?.[0]?.id).toBe('inline-child')
  })

  it('explains a self-contained subflow as drained while the parent stream continues', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'self-contained-subflow',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          {
            type: 'subflow',
            config: {
              pipeline: {
                id: 'side-effect-child',
                retry,
                onError: 'fail-run',
                steps: [
                  { type: 'source', config: { uri: 'jsonl://./side.jsonl' } },
                  toolStep('side-effect-tool'),
                ],
              },
            },
          },
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    const subflow = parsed.runnable.pipelines[0]?.steps[1]
    expect(subflow?.cardinality).toBe('N → N (nested side effects)')
    expect(subflow?.description).toContain('drained and discarded')
    expect(subflow?.description).toContain('parent stream continues unchanged')
  })

  it('warns for a hand-built nested sliding batch and reports overlapping emissions', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'nested-slide',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          {
            type: 'batch',
            config: {
              size: 2,
              slide: true,
              pipeline: {
                id: 'slide-child',
                retry,
                onError: 'fail-run',
                steps: [toolStep('slide-tool')],
              },
            },
          },
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    const batch = parsed.runnable.pipelines[0]?.steps[1]
    expect(parsed.warnings.join('\n')).toContain('slide=true')
    expect(parsed.warnings.join('\n')).toContain('pipeline-definition time')
    expect(batch?.cardinality).toContain('member emissions')
    expect(batch?.cardinality).toContain('windows repeat members')
  })

  it('fills partial project retry defaults and merges step/pipeline onError overrides', async () => {
    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({
        defaults: { retry: { max: 7 }, onError: 'skip-item', concurrency: 2 },
      }),
    )
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'policy-merge',
        retry: { max: 5, backoffMs: 200, strategy: 'linear' as const },
        onError: 'dead-letter',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          toolStep('inherits'),
          toolStep('overrides', 'override description', {
            retry: { backoffMs: 50 },
            onError: 'skip-item',
          }),
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.defaults).toEqual({
      retry: { max: 7, backoffMs: 1000, strategy: 'exp' },
      onError: 'skip-item',
      concurrency: 2,
    })
    expect(parsed.runnable.pipelines[0]?.retry).toEqual({
      max: 5,
      backoffMs: 200,
      strategy: 'linear',
    })
    expect(parsed.runnable.pipelines[0]?.onError).toBe('dead-letter')
    const steps = parsed.runnable.pipelines[0]?.steps ?? []
    expect(steps[1]).toMatchObject({
      retry: { max: 5, backoffMs: 200, strategy: 'linear' },
      onError: 'dead-letter',
    })
    expect(steps[2]).toMatchObject({
      retry: { max: 5, backoffMs: 50, strategy: 'linear' },
      onError: 'skip-item',
    })
  })

  it('reports source/target instance metadata and touches no runtime hook or .mt state', async () => {
    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({
        scripts: {
          start: 'hooks/start.ts',
          end: 'hooks/end.ts',
          error: 'hooks/error.ts',
          stop: 'hooks/stop.ts',
          exit: 'hooks/exit.ts',
        },
      }),
    )
    const sourceStart = vi.fn(() => (async function* () {})())
    const sourceResume = vi.fn(() => (async function* () {})())
    const toolInvoke = vi.fn(async (ex: unknown) => ex)
    const targetOpen = vi.fn(async () => {})
    const targetWrite = vi.fn(async () => {})
    const targetClose = vi.fn(async () => {})
    const targetCheckpoint = vi.fn(async () => 0)

    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'instances',
        retry,
        onError: 'fail-run',
        steps: [
          {
            type: 'source',
            config: {
              uri: 'jsonl://./in.jsonl',
              instance: {
                uri: 'jsonl://./in.jsonl',
                lifestyle: 'resumable' as const,
                start: sourceStart,
                resume: sourceResume,
              },
            },
          },
          {
            type: 'tool',
            config: {
              name: 'echo',
              version: '1.2.3',
              mdDescription: 'Echo.',
              tool: {
                name: 'echo',
                version: '1.2.3',
                mdDescription: 'Echo.',
                invoke: toolInvoke,
              },
            },
          },
          {
            type: 'target',
            config: {
              uri: 'md://./out',
              instance: {
                uri: 'md://./out',
                open: targetOpen,
                write: targetWrite,
                close: targetClose,
                checkpoint: targetCheckpoint,
              },
            },
          },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.runnable.pipelines[0]?.steps[0]).toMatchObject({
      sourceLifestyle: 'resumable',
      sourceResumable: true,
    })
    expect(parsed.runnable.pipelines[0]?.steps[2]?.targetDurableCheckpoint).toBe(true)
    expect(parsed.runtime.hooks.start).toBe('hooks/start.ts')
    expect(sourceStart).not.toHaveBeenCalled()
    expect(sourceResume).not.toHaveBeenCalled()
    expect(toolInvoke).not.toHaveBeenCalled()
    expect(targetOpen).not.toHaveBeenCalled()
    expect(targetWrite).not.toHaveBeenCalled()
    expect(targetClose).not.toHaveBeenCalled()
    expect(targetCheckpoint).not.toHaveBeenCalled()
    await expect(access(join(testDir, '.mt'))).rejects.toThrow()
  })

  it('describes sliding batch windows and the dropped remainder', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({
      default: {
        id: 'sliding-batch',
        retry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'jsonl://./in.jsonl' } },
          { type: 'batch', config: { size: 3, slide: true } },
          { type: 'target', config: { uri: 'md://./out' } },
        ],
      },
    }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.runnable.pipelines[0]?.steps[1]).toMatchObject({
      type: 'batch',
      cardinality: 'N → N - size + 1 sliding windows (N >= size; remainder dropped)',
    })
    expect(parsed.runnable.pipelines[0]?.steps[1]?.description).toContain('sliding windows')
  })

  it('reports fallback/default scope and the actually observed state machine', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({ default: simplePipeline() }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    ) as JsonExplanation & {
      defaultsNote: string
      runtime: { states: string[]; stateMachineNote: string; cacheDir: string }
    }
    expect(parsed.defaultsNote).toContain('Lowest-priority fallbacks')
    expect(parsed.runtime.states).not.toContain('checkpoint')
    expect(parsed.runtime.stateMachineNote).toContain('never enters it')
    expect(parsed.runtime.cacheDir).toBe('.mt/cache/<hash>.json')
  })

  it('warns instead of crashing for a legacy id-only pipeline', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({ default: { id: 'legacy-only' } }))

    await explainCommand(['pipeline.ts', '--json'])

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as JsonExplanation
    expect(parsed.runnable.pipelines[0]).toMatchObject({ id: 'legacy-only', stepCount: 0 })
    expect(parsed.warnings.join('\n')).toContain('no steps array')

    vi.mocked(console.log).mockClear()
    await explainCommand(['pipeline.ts'])
    const markdown = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(markdown).toContain('(no steps declared)')
  })

  it('reports a missing named export', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default {}')
    vi.doMock(pipelinePath, () => ({ default: simplePipeline('default-pipeline') }))

    await expect(explainCommand(['pipeline.ts', '--pipeline', 'missing'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("named export 'missing' not found"),
    )
  })
})
