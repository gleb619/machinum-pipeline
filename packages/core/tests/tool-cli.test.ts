import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineTool } from '../src/dsl.js'
import { getVariable, setVariable, withItem } from '../src/exchange.js'
import { runToolCli } from '../src/tool-cli.js'
import type { Exchange } from '../src/types/exchange.js'

const upperTool = defineTool<string, string>({
  name: 'upper',
  version: '1.0.0',
  mdDescription: 'Uppercases the payload.',
  async invoke(ex: Exchange<string>): Promise<Exchange<string>> {
    const output = withItem(ex, ex.item.toUpperCase())
    return setVariable(output, 'length', ex.item.length)
  },
})

const failingTool = defineTool<string, string>({
  name: 'boom',
  version: '1.0.0',
  mdDescription: 'Always fails.',
  async invoke(): Promise<Exchange<string>> {
    throw new Error('kaboom')
  },
})

describe('runToolCli (UC011)', () => {
  let projectRoot: string

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-tool-cli-'))
  })

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  function run(input: string): {
    code: Promise<number>
    out: string[]
    err: string[]
  } {
    const out: string[] = []
    const err: string[] = []
    const code = runToolCli(upperTool, {
      input,
      projectRoot,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })
    return { code, out, err }
  }

  it('writes the persisted result envelope as one JSON line and exits 0', async () => {
    const { code, out, err } = run('{"item":"hi","meta":{"chapterId":"c1"}}')

    expect(await code).toBe(0)
    expect(err).toEqual([])
    expect(out).toHaveLength(1)

    const parsed = JSON.parse(out[0] ?? '') as Exchange<string> & { item?: string }
    expect(parsed.variables.find((v) => v.name === 'item' && v.qualifier === 'new')?.value).toBe(
      'HI',
    )
    expect(getVariable(parsed, 'length')).toBe(2)
    // persistence contract: `meta` is in-flight only, the payload has no `item` field
    expect(parsed.meta).toBeUndefined()
    expect(parsed.item).toBeUndefined()
    expect(parsed.id).toMatch(/^ex-/)
  })

  it('writes a failing invoke to stderr and exits 1', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runToolCli(failingTool, {
      input: '{"item":"x"}',
      projectRoot,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })

    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err).toEqual(["Error: tool 'boom' failed: kaboom"])
  })

  it('rejects invalid JSON on stdin', async () => {
    const { code, out, err } = run('not json')
    expect(await code).toBe(1)
    expect(out).toEqual([])
    expect(err[0]).toMatch(/^Error: invalid JSON on stdin: /)
  })

  it('rejects empty stdin', async () => {
    const { code, out, err } = run('   \n')
    expect(await code).toBe(1)
    expect(out).toEqual([])
    expect(err).toEqual([
      'Error: empty stdin — expected a JSON exchange like {"item":"x","meta":{}}',
    ])
  })
})
