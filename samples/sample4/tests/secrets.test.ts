import { execFileSync } from 'node:child_process'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const DEMO_DIR = join(SAMPLE_DIR, '.demo')
const SECRET_REF = /^(embed|keepass|vlt):.+/

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(DEMO_DIR, { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

/** Run `demo/<name>.sh`; the scripts unset every MT_* secret var, so the host env cannot leak in. */
function runDemo(name: string): string {
  return execFileSync('bash', [join(SAMPLE_DIR, 'demo', `${name}.sh`)], {
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
  const item = line.variables.find((v) => v.name === 'item' && v.qualifier === 'new')
  return item?.value as { entry: string; provider: string; keyLength: number }
}

beforeAll(cleanup)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('vault files hold refs only', () => {
  it('every apiKey in vault.*.json is an embed:/keepass:/vlt: ref', async () => {
    const files = (await readdir(SAMPLE_DIR)).filter((f) => /^vault\..+\.json$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(4)
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
})

describe('secret backends demo (no LLM call)', () => {
  it('embed (default password): resolves the ref, never prints the key', async () => {
    const out = runDemo('embed')
    expect(out).toContain('[secrets-demo] entry=demo-embed provider=openrouter keyLength=23')
    expect(out).not.toContain('sk-demo-FAKE')
    const item = await resultItem()
    expect(item).toEqual({ entry: 'demo-embed', provider: 'openrouter', keyLength: 23 })
    expect(await readFile(join(DEMO_DIR, 'result.jsonl'), 'utf-8')).not.toContain('sk-demo-FAKE')
  })

  it('embed (custom password file): resolves without the default-password warning', async () => {
    const out = runDemo('embed-custom')
    expect(out).toContain('entry=demo-embed-custom provider=openrouter keyLength=24')
    expect(out).not.toContain('sk-demo-FAKE')
    expect((await resultItem()).entry).toBe('demo-embed-custom')
  })

  it('keepass: hermetic kdbx created by the script, ref resolved', async () => {
    const out = runDemo('keepass')
    expect(out).toContain('entry=demo-keepass provider=openrouter keyLength=25')
    expect(out).not.toContain('sk-demo-FAKE')
  })

  // vlt's create/login are interactive-only, so the run cannot be seeded hermetically.
  // The script must exit 0 either way: run it, or skip with a clear message.
  it('vlt: runs when vlt is ready, otherwise degrades with a SKIPPED message', () => {
    const out = runDemo('vlt')
    expect(out).toMatch(/keyLength=\d+|\[demo\] SKIPPED: .+/)
  })
})
