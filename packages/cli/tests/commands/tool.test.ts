import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolCommand } from '../../src/commands/tool.js'

const stdin = vi.hoisted(() => ({ data: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    // tool.ts reads the envelope from fd 0; the tests feed it via `stdin.data`
    readFileSync: vi.fn((fd: unknown) => {
      if (fd !== 0) throw new Error(`readFileSync mock: unexpected fd ${String(fd)}`)
      return stdin.data
    }),
  }
})

const ECHO_PIPELINE = `
const echo = {
  name: 'echo',
  version: '1.0.0',
  mdDescription: 'Echo fixture tool',
  invoke: async (env) => ({ item: 'echo:' + env.item, meta: env.meta }),
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

const OTHER_PIPELINE = `
const other = {
  name: 'other',
  version: '1.0.0',
  mdDescription: 'Other fixture tool',
  invoke: async (env) => ({ item: 'other:' + env.item, meta: env.meta }),
}
export default {
  id: 'other-pipeline',
  retry: { max: 0, backoffMs: 0 },
  onError: 'fail-run',
  steps: [{ type: 'tool', config: { tool: other } }],
}
`

describe('toolCommand', () => {
  let testDir: string
  let originalCwd: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-tool-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)

    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({ project: { name: 'tool-fixture' }, pipelines: ['pipeline.ts'] }),
    )
    await writeFile(join(testDir, 'pipeline.ts'), ECHO_PIPELINE)

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

  it('prints usage and exits if no tool name provided', async () => {
    await expect(toolCommand([])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage: mt tool <name>'))
  })

  it('invokes the tool and prints the output envelope JSON to stdout', async () => {
    stdin.data = '{"item":"hello","meta":{}}'

    await toolCommand(['echo'])

    const printed = vi
      .mocked(console.log)
      .mock.calls.map((call) => call[0])
      .join('\n')
    expect(JSON.parse(printed as string)).toEqual({ item: 'echo:hello', meta: {} })
  })

  it('exits 1 and lists available tools for an unknown tool name', async () => {
    stdin.data = '{"item":"x","meta":{}}'

    await expect(toolCommand(['nope'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown tool: nope'))
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('echo'))
  })

  it('exits 1 with a clear message for invalid JSON on stdin', async () => {
    stdin.data = 'not json'

    await expect(toolCommand(['echo'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'))
  })

  it('prints a usage hint instead of hanging when stdin is a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    try {
      await expect(toolCommand(['echo'])).rejects.toThrow('EXIT 1')
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Pipe a JSON exchange'))
      expect(vi.mocked(console.log).mock.calls.length).toBe(0)
    } finally {
      Reflect.deleteProperty(process.stdin, 'isTTY')
    }
  })

  it('finds tools from a file passed via --pipeline even when not declared in mt.json', async () => {
    await writeFile(join(testDir, 'other.ts'), OTHER_PIPELINE)
    stdin.data = '{"item":"hi","meta":{}}'

    await toolCommand(['other', '--pipeline', 'other.ts'])

    const printed = vi
      .mocked(console.log)
      .mock.calls.map((call) => call[0])
      .join('\n')
    expect(JSON.parse(printed as string)).toEqual({ item: 'other:hi', meta: {} })
  })

  it('reports an ambiguous tool name instead of picking one silently', async () => {
    await writeFile(
      join(testDir, 'dup.ts'),
      ECHO_PIPELINE.replace('fixture-pipeline', 'dup-pipeline'),
    )
    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({ project: { name: 'tool-fixture' }, pipelines: ['pipeline.ts', 'dup.ts'] }),
    )
    stdin.data = '{"item":"x","meta":{}}'

    await expect(toolCommand(['echo'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ambiguous'))
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('fixture-pipeline'))
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('dup-pipeline'))
  })
})
