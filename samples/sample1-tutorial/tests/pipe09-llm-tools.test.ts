import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run, runScript } from './helpers.js'

const CHAPTERS_SET = ['chapter1.md', 'chapter2.md']
const PIPELINES: Array<[string, string, string[]]> = [
  ['summaryPipeline', 'summary', CHAPTERS_SET],
  ['summaryNotesPipeline', 'summary-notes', CHAPTERS_SET],
  ['entitiesPipeline', 'entities', CHAPTERS_SET],
  ['nerPipeline', 'ner', CHAPTERS_SET],
  ['vocabularyPipeline', 'vocabulary', CHAPTERS_SET],
  ['metadataPipeline', 'metadata', CHAPTERS_SET],
  ['schemaPipeline', 'schema', CHAPTERS_SET],
  ['typoFixPipeline', 'typo-fix', ['chapter1.md']],
  ['glossaryPipeline', 'glossary', ['glossary.md']],
  ['statdataPipeline', 'statdata', ['statdata.md']],
  ['statDictTranslatePipeline', 'stat-dict-translate', ['stat-dict-translate.md']],
  ['proofreadPipeline', 'proofread', CHAPTERS_SET],
]

const OUTPUT_DIRS = PIPELINES.map(([, dir]) => join(CHAPTERS, dir))

let hasFailure = false

async function cleanup(): Promise<void> {
  await clean(...OUTPUT_DIRS, join(SAMPLE_DIR, '.mt'))
}

beforeAll(async () => {
  await cleanup()
  runScript('prepare-input.ts')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('pipe09 LLM tool gallery (offline mock)', () => {
  for (const [pipeline, dir, files] of PIPELINES) {
    it(`${pipeline} writes a side-by-side report`, async () => {
      run('pipe09-llm-tools.ts', { pipeline })
      expect((await readdir(join(CHAPTERS, dir))).sort()).toEqual([...files].sort())
      for (const file of files) {
        const markdown = await readFile(join(CHAPTERS, dir, file), 'utf-8')
        expect(markdown).toContain('## Input')
        expect(markdown).toContain('## Output')
      }
    }, 20_000)
  }

  it('reports the picked backend in the report header', async () => {
    await readFile(join(CHAPTERS, 'summary', 'chapter1.md'), 'utf-8')
    const markdown = await readFile(join(CHAPTERS, 'summary', 'chapter1.md'), 'utf-8')
    expect(markdown).toContain('backend: `mock`')
  })

  it('statdata lists dictionary candidates from the corpus', async () => {
    const markdown = await readFile(join(CHAPTERS, 'statdata', 'statdata.md'), 'utf-8')
    expect(markdown).toContain('dictionary candidates')
    expect(markdown.toLowerCase()).toContain('aldric')
  })

  it('typo-fix keeps the planted typos when the mock echoes the text', async () => {
    const markdown = await readFile(join(CHAPTERS, 'typo-fix', 'chapter1.md'), 'utf-8')
    expect(markdown).toContain('"stillInText": 9')
    expect(markdown).toContain('"llmFixed": true')
  })
})
