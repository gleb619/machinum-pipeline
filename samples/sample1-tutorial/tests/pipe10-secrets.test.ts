import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SAMPLE_DIR, clean } from './helpers.js'

const DEMO_DIR = join(SAMPLE_DIR, '.demo')
const SECRET_REF = /^(embed|keepass|vlt):.+/

let hasFailure = false

async function cleanup(): Promise<void> {
  await clean(
    join(DEMO_DIR, 'result.jsonl'),
    join(DEMO_DIR, 'input.jsonl'),
    join(DEMO_DIR, 'secrets.embed.json'),
    join(SAMPLE_DIR, '.mt'),
  )
}

function runDemo(): string {
  return execFileSync('bash', [join(SAMPLE_DIR, 'demo', 'embed.sh')], {
    cwd: SAMPLE_DIR,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 60_000,
  })
}

async function resultItem(): Promise<{ entry: string; provider: string; keyLength: number }> {
  const raw = await readFile(join(DEMO_DIR, 'result.jsonl'), 'utf-8')
  const line = JSON.parse(raw.trim().split('\n')[0] ?? '{}') as {
    variables: Array<{ name: string; qualifier: string; value: unknown }>
  }
  const item = line.variables.find(
    (variable) => variable.name === 'item' && variable.qualifier === 'new',
  )
  return item?.value as { entry: string; provider: string; keyLength: number }
}

beforeAll(cleanup)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('pipe10 secrets demo (embed backend, offline)', () => {
  it('keeps only refs in the vault file', async () => {
    const files = (await readdir(SAMPLE_DIR)).filter((file) => /^vault\..+\.json$/.test(file))
    expect(files.length).toBeGreaterThanOrEqual(1)
    for (const file of files) {
      const vault = JSON.parse(await readFile(join(SAMPLE_DIR, file), 'utf-8')) as {
        entries: Record<string, { apiKey?: string; apiKeys?: string[] }>
      }
      for (const entry of Object.values(vault.entries)) {
        for (const key of [entry.apiKey, ...(entry.apiKeys ?? [])]) {
          if (key !== undefined) expect(key, file).toMatch(SECRET_REF)
        }
      }
    }
  })

  it('resolves the embed ref and reports only the key length', async () => {
    const output = runDemo()
    expect(output).toContain('secrets-demo')
    expect(output).toContain('"entry":"demo-embed"')
    expect(output).toContain('"provider":"openrouter"')
    expect(output).toContain('"keyLength":23')
    expect(output).not.toContain('sk-demo-FAKE')
    expect(await resultItem()).toEqual({
      entry: 'demo-embed',
      provider: 'openrouter',
      keyLength: 23,
    })
    expect(await readFile(join(DEMO_DIR, 'result.jsonl'), 'utf-8')).not.toContain('sk-demo-FAKE')
  })
})
