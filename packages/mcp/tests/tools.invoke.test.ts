import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleToolsCall } from '../src/handlers.js'

/**
 * The real `@mt/tools` package is an optional dependency of `@mt/mcp`; mock it
 * with a single hermetic tool so built-in resolution can be tested offline.
 */
vi.mock('@mt/tools', () => {
  const echoTool = {
    name: 'echo',
    version: '1.0.0',
    description: 'Echo the payload with a prefix.',
    invoke: async (ex: { item?: unknown }) => ({ ...ex, item: `echo:${String(ex.item)}` }),
  }
  return { echoTool }
})

const created: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

type FixtureBehavior = 'echo' | 'throw'

/** A throwaway project declaring one pipeline whose single step uses a fixture tool. */
async function createProject(
  toolName: string,
  behavior: FixtureBehavior = 'echo',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-mcp-invoke-'))
  created.push(root)
  await mkdir(join(root, 'pipelines'), { recursive: true })
  await writeFile(
    join(root, 'mt.json'),
    `${JSON.stringify({ project: { name: 'fixture' }, pipelines: ['./pipelines/tool.ts'] }, null, 2)}\n`,
  )
  const invoke =
    behavior === 'throw'
      ? "async () => {\n    throw new Error('boom')\n  }"
      : 'async (ex) => ({ ...ex, item: `pipeline:${ex.item}` })'
  await writeFile(
    join(root, 'pipelines', 'tool.ts'),
    [
      "import { definePipeline, defineTool } from '@mt/core'",
      '',
      'const tool = defineTool<string, string>({',
      `  name: '${toolName}',`,
      "  version: '1.0.0',",
      "  description: 'fixture tool',",
      `  invoke: ${invoke},`,
      '})',
      '',
      "export default definePipeline({ id: 'fixture' }).use(tool)",
      '',
    ].join('\n'),
  )
  return root
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

describe('tools.invoke — pipeline tools', () => {
  it('invokes a tool used by a declared pipeline and returns its output Exchange', async () => {
    const root = await createProject('pipeline-echo')

    const call = await callTool(
      'tools.invoke',
      {
        toolName: 'pipeline-echo',
        envelope: { id: 'ex-1', item: 'hello', meta: { chapterId: 'c1' } },
      },
      root,
    )

    expect(call.isError).toBe(false)
    expect(call.data).toMatchObject({
      id: 'ex-1',
      item: 'pipeline:hello',
      meta: { chapterId: 'c1' },
    })
  })

  it('normalizes a partial envelope with toExchange', async () => {
    const root = await createProject('pipeline-echo')

    const call = await callTool(
      'tools.invoke',
      { toolName: 'pipeline-echo', envelope: { item: 'x' } },
      root,
    )

    expect(call.isError).toBe(false)
    const output = call.data as { id?: string; variables?: Array<{ name: string }> }
    expect(typeof output.id).toBe('string')
    expect(output.variables?.some((variable) => variable.name === 'item')).toBe(true)
  })
})

describe('tools.invoke — built-in tools', () => {
  it('falls back to a matching export of @mt/tools', async () => {
    const root = await createProject('pipeline-echo')

    const call = await callTool(
      'tools.invoke',
      { toolName: 'echo', envelope: { item: 'hi' } },
      root,
    )

    expect(call.isError).toBe(false)
    expect(call.data).toMatchObject({ item: 'echo:hi' })
  })
})

describe('tools.invoke — errors', () => {
  it('reports an unknown tool with the available names', async () => {
    const root = await createProject('pipeline-echo')

    const call = await callTool(
      'tools.invoke',
      { toolName: 'missing', envelope: { item: 'x' } },
      root,
    )

    expect(call.isError).toBe(true)
    expect(call.text).toContain('Unknown tool: missing')
    expect(call.text).toContain('Available tools:')
    expect(call.text).toContain('pipeline-echo')
    expect(call.text).toContain('echo')
  })

  it('rejects an envelope without item', async () => {
    const root = await createProject('pipeline-echo')

    const call = await callTool('tools.invoke', { toolName: 'pipeline-echo', envelope: {} }, root)

    expect(call.isError).toBe(true)
    expect(call.text).toContain("'envelope.item' is required")
  })

  it('rejects an envelope that is not an object', async () => {
    const root = await createProject('pipeline-echo')

    const call = await callTool(
      'tools.invoke',
      { toolName: 'pipeline-echo', envelope: 'nope' },
      root,
    )

    expect(call.isError).toBe(true)
    expect(call.text).toContain("'envelope' must be an object")
  })

  it('rejects a missing tool name', async () => {
    const root = await createProject('pipeline-echo')

    const call = await callTool('tools.invoke', { envelope: { item: 'x' } }, root)

    expect(call.isError).toBe(true)
    expect(call.text).toContain("'toolName' must be a non-empty string")
  })

  it('reports a throwing tool as an error instead of a JSON-RPC failure', async () => {
    const root = await createProject('failing', 'throw')

    const call = await callTool(
      'tools.invoke',
      { toolName: 'failing', envelope: { item: 'x' } },
      root,
    )

    expect(call.isError).toBe(true)
    expect(call.text).toContain("Tool 'failing' failed")
    expect(call.text).toContain('boom')
  })
})

describe('tools.invoke — stdio hygiene', () => {
  it('writes nothing to stdout or console.log', async () => {
    const root = await createProject('pipeline-echo')
    const writes: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const call = await callTool(
      'tools.invoke',
      { toolName: 'echo', envelope: { item: 'hi' } },
      root,
    )

    expect(call.isError).toBe(false)
    expect(writes).toEqual([])
    expect(logSpy).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })
})
