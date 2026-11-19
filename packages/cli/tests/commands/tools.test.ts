import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolsCommand } from '../../src/commands/tools.js'

const stdin = vi.hoisted(() => ({ data: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    // tools.ts reads the envelope from fd 0; the tests feed it via `stdin.data`
    readFileSync: vi.fn((fd: unknown, ...rest: unknown[]) => {
      if (fd === 0) return stdin.data
      return (actual.readFileSync as (...args: unknown[]) => unknown)(fd, ...rest)
    }),
  }
})

vi.mock('@mt/tools', async () => {
  const { category, defineTool, tool } = await import('@mt/core')
  const builtinTool = defineTool({
    name: 'builtin-echo',
    version: '1.0.0',
    description: 'Builtin echo fixture tool',
    annotations: [
      tool('TL999', { name: 'builtin-echo', description: 'Builtin echo (fixture).' }),
      category(['stub']),
    ],
    async invoke(env) {
      return { ...env, item: `builtin:${String(env.item)}` }
    },
  })
  const builtinOnlyTool = defineTool({
    name: 'builtin-only',
    version: '1.0.0',
    description: 'Built-in fixture tool no pipeline declares',
    annotations: [tool('TL998', { name: 'builtin-only', description: 'Built-in only (fixture).' })],
    async invoke(env) {
      return { ...env, item: `builtin:${String(env.item)}` }
    },
  })
  return { builtinTool, builtinOnlyTool }
})

const ECHO_PIPELINE = `
const echo = {
  name: 'echo',
  version: '1.0.0',
  description: 'Echo fixture tool',
  invoke: async (env) => ({
    id: env.id,
    item: 'echo:' + env.item,
    meta: env.meta,
    variables: env.variables,
  }),
}
export default {
  id: 'fixture-pipeline',
  retry: { max: 0, backoffMs: 0 },
  onError: 'fail-run',
  steps: [
    { type: 'source', config: { uri: 'fixture://in' } },
    { type: 'tool', config: { tool: echo } },
  ],
}
`

/** Uses the same tool name as the built-in fixture — the catalogue must not duplicate it. */
const REUSE_PIPELINE = `
const reuse = {
  name: 'builtin-echo',
  version: '1.0.0',
  description: 'Pipeline-local tool with a built-in name',
  invoke: async (env) => ({ ...env, item: 'pipeline:' + env.item }),
}
export default {
  id: 'reuse-pipeline',
  retry: { max: 0, backoffMs: 0 },
  onError: 'fail-run',
  steps: [{ type: 'tool', config: { tool: reuse } }],
}
`

interface CatalogueTool {
  name: string
  source: string
  category: string | null
  description: string | null
  usedBy: string[]
}

function stdout(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => call[0])
    .join('\n')
}

describe('toolsCommand', () => {
  let testDir: string
  let originalCwd: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-tools-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)

    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({
        project: { name: 'tools-fixture' },
        pipelines: ['pipeline.ts', 'reuse.ts'],
      }),
    )
    await writeFile(join(testDir, 'pipeline.ts'), ECHO_PIPELINE)
    await writeFile(join(testDir, 'reuse.ts'), REUSE_PIPELINE)

    stdin.data = ''

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
  })

  describe('list', () => {
    it('prints usage and exits 1 for an unknown subcommand', async () => {
      await expect(toolsCommand(['nope'])).rejects.toThrow('EXIT 1')
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage: mt tools'))
    })

    it('prints usage and exits 1 without a subcommand', async () => {
      await expect(toolsCommand([])).rejects.toThrow('EXIT 1')
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage: mt tools'))
    })

    it('lists built-in and pipeline tools in the JSON document, sorted by name', async () => {
      await toolsCommand(['list', '--json'])

      const doc = JSON.parse(stdout()) as { schemaVersion: number; tools: CatalogueTool[] }
      expect(doc.schemaVersion).toBe(1)
      expect(doc.tools.map((entry) => entry.name)).toEqual(['builtin-echo', 'builtin-only', 'echo'])

      const builtin = doc.tools.find((entry) => entry.name === 'builtin-echo') as CatalogueTool
      expect(builtin.source).toBe('builtin')
      expect(builtin.category).toBe('stub')
      expect(builtin.description).toBe('Builtin echo (fixture).')

      const pipelineTool = doc.tools.find((entry) => entry.name === 'echo') as CatalogueTool
      expect(pipelineTool.source).toBe('fixture-pipeline')
      expect(pipelineTool.usedBy).toEqual(['fixture-pipeline'])
    })

    it('does not duplicate a built-in used by a pipeline and records the pipeline in usedBy', async () => {
      await toolsCommand(['list', '--json'])

      const doc = JSON.parse(stdout()) as { tools: CatalogueTool[] }
      const rows = doc.tools.filter((entry) => entry.name === 'builtin-echo')
      expect(rows).toHaveLength(1)
      expect((rows[0] as CatalogueTool).source).toBe('builtin')
      expect((rows[0] as CatalogueTool).usedBy).toEqual(['reuse-pipeline'])
    })

    it('prints a markdown table by default', async () => {
      await toolsCommand(['list'])

      const printed = stdout()
      expect(printed).toContain('| Name | Source | Category | Description |')
      expect(printed).toContain('builtin-echo')
      expect(printed).toContain('echo')
    })

    it('restricts the pipeline scan to --pipeline', async () => {
      await toolsCommand(['list', '--json', '--pipeline', 'pipeline.ts'])

      const doc = JSON.parse(stdout()) as { tools: CatalogueTool[] }
      const pipelineTool = doc.tools.find((entry) => entry.name === 'echo')
      expect(pipelineTool).toBeDefined()
      expect(doc.tools.find((entry) => entry.name === 'builtin-echo')?.usedBy).toEqual([])
    })
  })

  describe('call', () => {
    it('invokes a pipeline tool with --item and prints the output item', async () => {
      await toolsCommand(['call', 'echo', '--item', 'hello'])

      expect(stdout()).toBe('echo:hello')
    })

    it('parses --item as JSON when it parses', async () => {
      await toolsCommand(['call', 'echo', '--item', '{"a":1}'])

      // an object payload, not the raw '{"a":1}' string
      expect(stdout()).toBe('echo:[object Object]')
    })

    it('prefers a piped exchange over --item', async () => {
      stdin.data = '{"item":"from-stdin"}'

      await toolsCommand(['call', 'echo', '--item', 'from-flag'])

      expect(stdout()).toBe('echo:from-stdin')
    })

    it('passes --meta to the tool', async () => {
      await toolsCommand(['call', 'echo', '--item', 'x', '--meta', '{"chapterId":"c1"}', '--json'])

      const doc = JSON.parse(stdout()) as { item: string; meta: Record<string, unknown> }
      expect(doc.item).toBe('echo:x')
      expect(doc.meta.chapterId).toBe('c1')
    })

    it('merges --var into the exchange variables', async () => {
      await toolsCommand(['call', 'echo', '--item', 'x', '--var', 'greeting=hi', '--json'])

      const doc = JSON.parse(stdout()) as { variables: { name: string; value: unknown }[] }
      const greeting = doc.variables.find((entry) => entry.name === 'greeting')
      expect(greeting?.value).toBe('hi')
    })

    it('falls back to the built-in tool when no pipeline declares it', async () => {
      await toolsCommand(['call', 'builtin-only', '--item', 'x'])

      expect(stdout()).toBe('builtin:x')
    })

    it('prefers the pipeline tool over the built-in one with the same name', async () => {
      await toolsCommand(['call', 'builtin-echo', '--item', 'x'])

      expect(stdout()).toBe('pipeline:x')
    })

    it('prints the full exchange with --json', async () => {
      await toolsCommand(['call', 'echo', '--item', 'hello', '--json'])

      const doc = JSON.parse(stdout()) as { item: string; variables: { name: string }[] }
      expect(doc.item).toBe('echo:hello')
      expect(doc.variables.some((entry) => entry.name === 'item')).toBe(true)
    })

    it('exits 1 and lists the available tools for an unknown tool', async () => {
      await expect(toolsCommand(['call', 'nope', '--item', 'x'])).rejects.toThrow('EXIT 1')
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown tool: nope'))
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('echo'))
    })

    it('prints a usage hint instead of hanging when there is no input', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      try {
        await expect(toolsCommand(['call', 'echo'])).rejects.toThrow('EXIT 1')
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Pipe a JSON exchange'))
        expect(vi.mocked(console.log).mock.calls.length).toBe(0)
      } finally {
        Reflect.deleteProperty(process.stdin, 'isTTY')
      }
    })

    it('exits 1 with a clear message for an invalid --meta', async () => {
      await expect(toolsCommand(['call', 'echo', '--item', 'x', '--meta', 'nope'])).rejects.toThrow(
        'EXIT 1',
      )
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--meta'))
    })

    it('exits 1 with a clear message for an invalid --var', async () => {
      await expect(toolsCommand(['call', 'echo', '--item', 'x', '--var', 'oops'])).rejects.toThrow(
        'EXIT 1',
      )
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--var expects name=value'),
      )
    })
  })
})
