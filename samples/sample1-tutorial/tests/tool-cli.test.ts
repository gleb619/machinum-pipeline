import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_ENV, SAMPLE_DIR, TSX_BIN } from './helpers.js'

const CLI = join(SAMPLE_DIR, 'tools', 'markdown-stats-cli.ts')

function runCli(input: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(TSX_BIN, [CLI], {
    cwd: SAMPLE_DIR,
    encoding: 'utf-8',
    input,
    env: BASE_ENV,
    timeout: 30_000,
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('tool CLI adapter (UC011)', () => {
  it('runs a tool from an npm bin script: JSON exchange in, JSON line out', () => {
    const { stdout, stderr, status } = runCli('{"item":"# Title\\n\\nHello world.","meta":{}}')

    expect(stderr).toBe('')
    expect(status).toBe(0)
    const lines = stdout.trim().split('\n')
    expect(lines).toHaveLength(1)

    const persisted = JSON.parse(lines[0] ?? '') as {
      variables: { name: string; qualifier: string; value: unknown }[]
    }
    const item = persisted.variables.find((v) => v.name === 'item' && v.qualifier === 'new')
    expect(item?.value).toMatchObject({
      text: '# Title\n\nHello world.',
      stats: { words: 3 },
    })
  })

  it('exits 1 with a stderr message when the tool fails', () => {
    // markdown-stats reads `item` as text; a JSON number is not a markdown string
    const { stdout, stderr, status } = runCli('{"item":42}')

    expect(status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain("Error: tool 'markdown-stats' failed:")
  })
})
