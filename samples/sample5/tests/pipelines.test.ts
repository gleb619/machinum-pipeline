import { execSync } from 'node:child_process'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const OUT_DIR = join(SAMPLE_DIR, 'out')

// pipeline file -> [output dir under out/, files it must write]
const CHAPTERS = ['chapter1.md', 'chapter2.md']
const PIPELINES: Array<[string, string, string[]]> = [
  ['summary', 'summary', CHAPTERS],
  ['summary-notes', 'summary-notes', CHAPTERS],
  ['entities', 'entities', CHAPTERS],
  ['ner', 'ner', CHAPTERS],
  ['vocabulary', 'vocabulary', CHAPTERS],
  ['metadata', 'metadata', CHAPTERS],
  ['schema', 'schema', CHAPTERS],
  ['typo-fix', 'typo-fix', ['chapter1.md']],
  ['translate-plain', 'translate-plain', CHAPTERS],
  ['translate-xml', 'translate-xml', CHAPTERS],
  ['translate-properties', 'translate-properties', CHAPTERS],
  ['translate-paragraphs', 'translate-paragraphs', CHAPTERS],
  ['translate-title', 'translate-title', CHAPTERS],
  ['proofread', 'proofread', CHAPTERS],
  ['glossary', 'glossary', ['glossary.md']],
  ['statdata', 'statdata', ['statdata.md']],
  ['stat-dict-translate', 'stat-dict-translate', ['stat-dict-translate.md']],
]

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

function run(pipeline: string): string {
  return execSync(`"${MT_BIN}" run ./pipelines/${pipeline}.ts`, {
    cwd: SAMPLE_DIR,
    encoding: 'utf-8',
    stdio: 'pipe',
    // MT_LLM_TOOL=mock: a developer's mt.local.json (remote ollama) must not leak into the test
    env: { ...process.env, NODE_OPTIONS: '--import tsx', MT_LLM_TOOL: 'mock' },
    timeout: 30_000,
  })
}

beforeAll(cleanup)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('sample5: one pipeline per LLM tool (offline, mock backend)', () => {
  for (const [pipeline, dir, files] of PIPELINES) {
    it(`${pipeline} writes a side-by-side report`, async () => {
      expect(run(pipeline)).toContain('Pipeline complete')
      const written = (await readdir(join(OUT_DIR, dir))).sort()
      expect(written).toEqual([...files].sort())
      for (const file of files) {
        const md = await readFile(join(OUT_DIR, dir, file), 'utf-8')
        expect(md).toContain('## Input')
        expect(md).toContain('## Output')
      }
    })
  }

  it('reports the picked backend in the report header', async () => {
    const md = await readFile(join(OUT_DIR, 'summary', 'chapter1.md'), 'utf-8')
    expect(md).toContain('backend: `mock`')
  })

  it('translate (mock) keeps the glossary heading line and writes Cyrillic', async () => {
    for (const mode of ['plain', 'xml', 'properties']) {
      const md = await readFile(join(OUT_DIR, `translate-${mode}`, 'chapter1.md'), 'utf-8')
      expect(md).toMatch(/[Ѐ-ӿ]/)
    }
  })

  it('statdata lists dictionary candidates from the corpus', async () => {
    const md = await readFile(join(OUT_DIR, 'statdata', 'statdata.md'), 'utf-8')
    expect(md).toContain('dictionary candidates')
    expect(md.toLowerCase()).toContain('aldric')
  })

  it('check-llm prints the mock backend without touching the network', () => {
    const out = execSync('pnpm exec tsx check-llm.ts', {
      cwd: SAMPLE_DIR,
      encoding: 'utf-8',
      env: { ...process.env, MT_LLM_TOOL: 'mock' },
      timeout: 30_000,
    })
    expect(out).toContain('backend: mock')
  })
})
