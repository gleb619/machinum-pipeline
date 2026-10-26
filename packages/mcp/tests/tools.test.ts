import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunStateData } from '@mt/core'
import { Store } from '@mt/core'
import { afterEach, describe, expect, it } from 'vitest'
import { handleToolsCall, handleToolsList } from '../src/handlers.js'

const PIPELINE_FILE = './pipelines/noop.ts'

const created: string[] = []

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

/** A throwaway project: `mt.json` declaring one trivial pipeline. */
async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-mcp-'))
  created.push(root)
  await mkdir(join(root, 'pipelines'), { recursive: true })
  await writeFile(
    join(root, 'mt.json'),
    `${JSON.stringify({ project: { name: 'fixture' }, pipelines: [PIPELINE_FILE] }, null, 2)}\n`,
  )
  await writeFile(
    join(root, 'pipelines', 'noop.ts'),
    "import { definePipeline } from '@mt/core'\n\nexport default definePipeline({ id: 'noop' })\n",
  )
  return root
}

/** Write a run's state file the way the Runner does (atomic write). */
async function writeRunState(root: string, runId: string, state: RunStateData): Promise<void> {
  const store = new Store(join(root, '.mt', 'runs', runId))
  await store.writeJson(state, 'state.json')
}

function runState(runId: string): RunStateData {
  return {
    runId,
    pipelineId: 'noop',
    pipelineFile: 'pipelines/noop.ts',
    state: 'done',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    checkpoint: { stepId: 'root', state: 'done' },
    contextRef: `runs/${runId}/context.json`,
  }
}

interface ToolCall {
  text: string
  isError: boolean
  data: unknown
}

/** Call a tool and decode its JSON payload (errors keep the raw message). */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolCall> {
  const result = await handleToolsCall({ name, arguments: args }, projectRoot)
  const text = result.content[0]?.text ?? ''
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  return { text, isError: result.isError === true, data }
}

/** Poll until the predicate holds — the background run writes its state asynchronously. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

describe('MCP tools/list', () => {
  it('lists exactly the four supported tools', () => {
    const { tools } = handleToolsList()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'pipelines.list',
      'pipelines.run',
      'runs.inspect',
      'runs.list',
    ])
  })

  it('gives every tool a description and a valid input schema', () => {
    for (const tool of handleToolsList().tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema.type).toBe('object')
      expect(typeof tool.inputSchema.properties).toBe('object')
    }
  })

  it('marks the required arguments of pipelines.run and runs.inspect', () => {
    const tools = handleToolsList().tools
    const run = tools.find((tool) => tool.name === 'pipelines.run')
    const inspect = tools.find((tool) => tool.name === 'runs.inspect')
    expect(run?.inputSchema.required).toEqual(['file'])
    expect(inspect?.inputSchema.required).toEqual(['runId'])
  })
})

describe('MCP tools/call dispatch', () => {
  it('reports an unknown tool as an error', async () => {
    const result = await handleToolsCall({ name: 'unknown' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Tool not found')
  })

  it('reports malformed arguments as an error', async () => {
    const result = await handleToolsCall({
      name: 'runs.inspect',
      arguments: 'not-an-object' as unknown as Record<string, unknown>,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Invalid arguments')
  })

  it('does not resolve a tool name against Object.prototype', async () => {
    const result = await handleToolsCall({ name: 'constructor' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Tool not found')
  })
})

describe('pipelines.list', () => {
  it('discovers the pipelines declared in mt.json', async () => {
    const root = await createProject()
    const call = await callTool('pipelines.list', {}, root)

    expect(call.isError).toBe(false)
    expect(call.data).toEqual([
      {
        file: 'pipelines/noop.ts',
        declared: PIPELINE_FILE,
        path: join(root, 'pipelines', 'noop.ts'),
      },
    ])
  })

  it('returns an empty list for a project without mt.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-mcp-empty-'))
    created.push(root)

    const call = await callTool('pipelines.list', {}, root)
    expect(call.isError).toBe(false)
    expect(call.data).toEqual([])
  })
})

describe('pipelines.run', () => {
  it('starts a run and returns its run id', async () => {
    const root = await createProject()
    const call = await callTool('pipelines.run', { file: PIPELINE_FILE }, root)

    expect(call.isError).toBe(false)
    const { runId } = call.data as { runId: string }
    expect(typeof runId).toBe('string')
    expect(runId.length).toBeGreaterThan(0)

    const runStore = new Store(join(root, '.mt', 'runs', runId))
    expect(await waitFor(async () => runStore.exists('state.json'))).toBe(true)
  })

  it('rejects a pipeline path that leaves the project root', async () => {
    const root = await createProject()
    const call = await callTool('pipelines.run', { file: '../outside.ts' }, root)

    expect(call.isError).toBe(true)
    expect(call.text).toContain('Path traversal')
  })

  it('rejects an absolute pipeline path', async () => {
    const root = await createProject()
    const call = await callTool('pipelines.run', { file: '/etc/passwd' }, root)

    expect(call.isError).toBe(true)
    expect(call.text).toContain('Absolute paths are not allowed')
  })

  it('rejects a missing file argument', async () => {
    const root = await createProject()
    const call = await callTool('pipelines.run', {}, root)

    expect(call.isError).toBe(true)
    expect(call.text).toContain("'file' must be a non-empty string")
  })
})

describe('runs.list', () => {
  it('lists the runs recorded under .mt/runs', async () => {
    const root = await createProject()
    await writeRunState(root, 'run-1', runState('run-1'))

    const call = await callTool('runs.list', {}, root)

    expect(call.isError).toBe(false)
    expect(call.data).toEqual([
      {
        runId: 'run-1',
        status: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        pipelineId: 'noop',
      },
    ])
  })

  it('returns an empty list when no run exists', async () => {
    const root = await createProject()
    const call = await callTool('runs.list', {}, root)

    expect(call.isError).toBe(false)
    expect(call.data).toEqual([])
  })
})

describe('runs.inspect', () => {
  it('returns the checkpoint tree and metadata of a run', async () => {
    const root = await createProject()
    await writeRunState(root, 'run-1', runState('run-1'))

    const call = await callTool('runs.inspect', { runId: 'run-1' }, root)

    expect(call.isError).toBe(false)
    expect(call.data).toEqual(runState('run-1'))
  })

  it('rejects a run id containing a path traversal', async () => {
    const root = await createProject()
    const call = await callTool('runs.inspect', { runId: '../../etc/passwd' }, root)

    expect(call.isError).toBe(true)
    expect(call.text).toContain('Invalid runId')
  })

  it('rejects a run id containing a path separator', async () => {
    const root = await createProject()
    const call = await callTool('runs.inspect', { runId: 'nested/run' }, root)

    expect(call.isError).toBe(true)
    expect(call.text).toContain('Invalid runId')
  })

  it('reports an unknown run as an error', async () => {
    const root = await createProject()
    const call = await callTool('runs.inspect', { runId: 'missing' }, root)

    expect(call.isError).toBe(true)
    expect(call.text).toContain('Run not found')
  })
})
