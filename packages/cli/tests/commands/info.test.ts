import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { infoCommand } from '../../src/commands/info.js'

describe('mt info command', () => {
  let testDir: string
  let originalCwd: string
  let logs: string[]
  let errors: string[]

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-info-test-'))
    originalCwd = process.cwd()
    logs = []
    errors = []
    process.chdir(testDir)
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
      )
    })
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`EXIT ${code}`)
    })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function write(relativePath: string, content: string): Promise<void> {
    const path = join(testDir, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }

  function output(): string {
    return logs.join('\n')
  }

  function jsonOutput(): Record<string, unknown> {
    const line = logs[0]
    if (!line) throw new Error('no console.log output')
    return JSON.parse(line) as Record<string, unknown>
  }

  it('merges imports over defaults and masks credentials', async () => {
    await write(
      'base.json',
      JSON.stringify({
        project: { name: 'imported-project' },
        book: { name: 'Imported Book' },
        settings: {
          'llm.apiKey': 'sk-or-v1-abcdefghijklmnop',
          'llm.model': 'imported-model',
          'custom.value': 'sk-live-1234567890abcdef',
        },
        defaults: { concurrency: 7 },
      }),
    )
    await write(
      'mt.json',
      JSON.stringify({
        imports: ['./base.json'],
        project: { name: 'root-project' },
        book: { year: 2020 },
      }),
    )

    await infoCommand([])
    const out = output()

    expect(out).toContain('Effective mt.json (secrets masked)')
    expect(out).toContain('"name": "imported-project"')
    expect(out).toContain('"year": 2020')
    expect(out).toContain('"concurrency": 7')
    expect(out).toContain('***')
    expect(out).toContain('Imports: ./base.json')
    expect(out).not.toContain('sk-or-v1-abcdefghijklmnop')
    expect(out).not.toContain('sk-live-1234567890abcdef')
  })

  it('summarizes runs, step counts, durations, sizes and slow steps', async () => {
    await write('mt.json', JSON.stringify({ project: { name: 'runs-project' } }))
    await write(
      '.mt/runs/r1/state.json',
      JSON.stringify({
        runId: 'r1',
        pipelineId: 'pipeline-one',
        state: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:05.000Z',
        checkpoint: {
          stepId: 'root',
          state: 'done',
          children: [
            { stepId: 'source-a-1', state: 'done' },
            { stepId: 'tool-b-2', state: 'failed' },
            { stepId: 'target-c-3', state: 'in-progress' },
            { stepId: 'tap-d-4', state: 'pending' },
          ],
        },
      }),
    )
    await write(
      '.mt/runs/r1/events.jsonl',
      [
        JSON.stringify({ type: 'started', ts: '2026-01-01T00:00:00.000Z', runId: 'r1' }),
        JSON.stringify({
          type: 'step-done',
          ts: '2026-01-01T00:00:01.000Z',
          runId: 'r1',
          stepId: 'source-a-1',
        }),
        JSON.stringify({
          type: 'step-done',
          ts: '2026-01-01T00:00:04.000Z',
          runId: 'r1',
          stepId: 'tool-b-2',
        }),
      ].join('\n'),
    )
    await write('.mt/runs/r1/dead-letter.jsonl', '{"item":1}\n{"item":2}\n\n')
    await write('.mt/runs/r1/artifacts/output.txt', 'some artifact content')

    await infoCommand(['--json'])
    const doc = jsonOutput()
    const state = doc.state as Record<string, unknown>
    const run = (state.runList as Array<Record<string, unknown>>)[0] as Record<string, unknown>

    expect(run.durationMs).toBe(5000)
    expect(run.steps).toEqual({
      done: 2,
      events: 2,
      checkpoint: { total: 4, done: 1, failed: 1, inProgress: 1, pending: 1 },
    })
    expect(run.deadLetters).toBe(2)
    expect(run.sizeBytes as number).toBeGreaterThan(0)
    expect(run.slowestSteps).toEqual([
      { stepId: 'tool-b-2', durationMs: 3000 },
      { stepId: 'source-a-1', durationMs: 1000 },
    ])

    logs.length = 0
    await infoCommand([])
    const human = output()
    expect(human).toContain('Slowest steps (latest run; event deltas')
    expect(human).toContain('Steps done')
    expect(human).toContain('Dead letters')
    expect(human).toContain('tool-b-2')
    expect(human).toContain('runs/')
  })

  it('counts top-level steps from events when the checkpoint has only root', async () => {
    await write(
      '.mt/runs/linear/state.json',
      JSON.stringify({
        runId: 'linear',
        pipelineId: 'linear-pipeline',
        state: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:03.000Z',
        checkpoint: { stepId: 'root', state: 'pending', children: [] },
      }),
    )
    await write(
      '.mt/runs/linear/events.jsonl',
      [
        JSON.stringify({ type: 'started', ts: '2026-01-01T00:00:00.000Z', runId: 'linear' }),
        ...['source-1', 'tool-2', 'target-3'].map((stepId, index) =>
          JSON.stringify({
            type: 'step-done',
            ts: `2026-01-01T00:00:0${index + 1}.000Z`,
            runId: 'linear',
            stepId,
          }),
        ),
      ].join('\n'),
    )

    await infoCommand(['--json'])
    const state = jsonOutput().state as Record<string, unknown>
    const run = (state.runList as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(run.steps).toEqual({
      done: 3,
      events: 3,
      checkpoint: { total: 0, done: 0, failed: 0, inProgress: 0, pending: 0 },
    })

    logs.length = 0
    await infoCommand([])
    expect(output()).toContain('Steps done')
    expect(output()).toMatch(/linear\s+linear-pipeline\s+done\s+[^\n]+\s+3\s/)
  })

  it('emits one schemaVersion 1 JSON document with masked config', async () => {
    await write(
      'mt.json',
      JSON.stringify({
        project: { name: 'json-project' },
        settings: { apiKey: 'super-secret-token-value', 'llm.model': 'test-model' },
      }),
    )

    await infoCommand(['--json'])
    expect(logs).toHaveLength(1)
    const doc = jsonOutput()
    expect(doc.schemaVersion).toBe(1)
    const config = doc.config as Record<string, unknown>
    const settings = config.settings as Record<string, unknown>
    expect(settings.apiKey).toBe('***')
    expect(JSON.stringify(doc)).not.toContain('super-secret-token-value')
  })

  it('limits the run list with --runs and handles empty/missing .mt', async () => {
    await write(
      '.mt/runs/older/state.json',
      JSON.stringify({
        runId: 'older',
        pipelineId: 'pipeline-old',
        state: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
      }),
    )
    await write(
      '.mt/runs/newer/state.json',
      JSON.stringify({
        runId: 'newer',
        pipelineId: 'pipeline-new',
        state: 'done',
        startedAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:02.000Z',
      }),
    )

    await infoCommand(['--json', '--runs', '1'])
    let doc = jsonOutput()
    let state = doc.state as Record<string, unknown>
    let runList = state.runList as Array<Record<string, unknown>>
    expect(runList).toHaveLength(1)
    expect(runList[0]?.runId).toBe('newer')

    logs.length = 0
    await infoCommand(['--json', '--runs=0'])
    doc = jsonOutput()
    state = doc.state as Record<string, unknown>
    runList = state.runList as Array<Record<string, unknown>>
    expect(runList).toHaveLength(2)

    await rm(join(testDir, '.mt'), { recursive: true, force: true })
    await mkdir(join(testDir, '.mt'), { recursive: true })
    logs.length = 0
    await infoCommand(['--json'])
    doc = jsonOutput()
    state = doc.state as Record<string, unknown>
    expect(state.exists).toBe(true)
    expect(state.totalBytes).toBe(0)
    expect((state.runs as Record<string, unknown>).total).toBe(0)
    expect(state.runList).toEqual([])

    logs.length = 0
    await infoCommand([])
    expect(output()).toContain('No runs recorded.')

    await rm(join(testDir, '.mt'), { recursive: true, force: true })
    logs.length = 0
    await infoCommand(['--json'])
    state = jsonOutput().state as Record<string, unknown>
    expect(state.exists).toBe(false)
    expect(state.totalBytes).toBe(0)
  })

  it('keeps non-credential keys and masks every secrets-container child', async () => {
    await write(
      'mt.json',
      JSON.stringify({
        project: { name: 'mask-project' },
        book: { author: 'Jane Doe' },
        settings: {
          tokenizer: 'gpt-tokenizer',
          tokens: ['abc123'],
          authorization: 'Basic dXNlcjpwYXNz',
          openrouterKey: 'abc',
          'llm.apiKey': 'sk-live-1234567890abcdef',
          'custom.value': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        },
        secrets: { envFile: '.env', customValue: 'plain-looking-secret', nested: { foo: 'bar' } },
      }),
    )

    await infoCommand(['--json'])
    const config = jsonOutput().config as Record<string, unknown>
    const book = config.book as Record<string, unknown>
    const settings = config.settings as Record<string, unknown>
    const secrets = config.secrets as Record<string, unknown>

    expect(book.author).toBe('Jane Doe')
    expect(settings.tokenizer).toBe('gpt-tokenizer')
    expect(settings.tokens).toBe('***')
    expect(settings.authorization).toBe('***')
    expect(settings.openrouterKey).toBe('***')
    expect(settings['llm.apiKey']).toBe('***')
    expect(settings['custom.value']).toBe('***')
    expect(secrets.envFile).toBe('.env')
    expect(secrets.customValue).toBe('***')
    expect(secrets.nested).toBe('***')
    expect(output()).not.toContain('plain-looking-secret')
  })

  it('does not leak a secret-bearing malformed config to stderr', async () => {
    await write('mt.json', '{"settings":{"apiKey":"sk-super-secret-value"')

    await expect(infoCommand([])).rejects.toThrow('EXIT 1')
    const stderr = errors.join('\n')
    expect(stderr).toContain('Cannot read project config')
    expect(stderr).not.toContain('sk-super-secret-value')
    expect(stderr).not.toContain('apiKey')
  })

  it('shows help even when an unknown flag follows it', async () => {
    await infoCommand(['--help', '--bogus'])
    expect(output()).toContain('Usage: mt info')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('exits 1 and prints usage for unknown flags', async () => {
    await expect(infoCommand(['--bogus'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown option: --bogus'))
    expect(console.error).toHaveBeenCalledWith('Usage: mt info [--json] [--runs <n>]')
  })
})
