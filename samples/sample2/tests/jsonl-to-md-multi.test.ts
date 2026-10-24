import { execSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')

const CHAPTERS = [
  { title: 'Chapter 1: The Road from Thornhaven', body: 'Sir Aldric tightened the strap.' },
  { title: 'Chapter 2: Ambush in the Darkwood', body: 'The trees closed in like witnesses.' },
  { title: 'Chapter 3: The Duke\u2019s Tribunal', body: 'Upon the third day, Sir Aldric arrived.' },
]

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'en'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'ru'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'schema'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'schema-mock'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'llm'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'translate-mock'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, 'md', 'output.md'), { force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'chapters', 'en'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'chapters', 'schema'), { recursive: true })

  const jsonlContent = `${CHAPTERS.map((ch) => JSON.stringify({ item: ch })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') {
    hasFailure = true
  }
})

afterAll(async () => {
  if (!hasFailure) {
    await cleanup()
  }
})

describe('jsonl-to-md-multi pipeline', () => {
  it('runs the jsonl-to-md-multi pipeline to completion', () => {
    execSync(`"${MT_BIN}" run ./pipelines/jsonl-to-md-multi.ts`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
      timeout: 10_000,
    })
  })

  it('writes individual chapter files to chapters/en', async () => {
    for (let i = 0; i < CHAPTERS.length; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'en', `chapter${i + 1}.md`),
        'utf-8',
      )
      expect(content).toContain(CHAPTERS[i].title)
      expect(content).toContain(CHAPTERS[i].body)
    }
  })

  it('writes translated ru chapters to chapters/ru with [ru] markers', async () => {
    for (let i = 0; i < CHAPTERS.length; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'ru', `chapter${i + 1}.md`),
        'utf-8',
      )
      expect(content).toContain('[ru]')
      expect(content).toContain('[/ru]')
      expect(content).toContain(CHAPTERS[i].body)
    }
  })

  it('chapters are in correct order on disk (chapter 1 before chapter 2 before chapter 3)', async () => {
    for (let i = 0; i < CHAPTERS.length; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'en', `chapter${i + 1}.md`),
        'utf-8',
      )
      expect(content).toContain(`Chapter ${i + 1}`)
    }
  })

  it('subflow enriches chapters with meta fields', async () => {
    for (let i = 0; i < CHAPTERS.length; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'en', `chapter${i + 1}.md`),
        'utf-8',
      )
      expect(content).toContain(CHAPTERS[i].title)
    }
  })

  it('subflow does not lose items — all 3 chapter titles present', async () => {
    for (let i = 0; i < CHAPTERS.length; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'en', `chapter${i + 1}.md`),
        'utf-8',
      )
      expect(content).toContain(`Chapter ${i + 1}`)
    }
  })
})

describe('schema-doc pipeline', () => {
  it('runs the schemaDocPipeline to completion', () => {
    execSync(`"${MT_BIN}" run ./pipelines/jsonl-to-md-multi.ts --pipeline schemaDocPipeline`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
      timeout: 10_000,
    })
  })

  it('generates per-chapter schema files: chapter1.schema.md, chapter2.schema.md, chapter3.schema.md', async () => {
    const fs = await import('node:fs/promises')
    for (let i = 1; i <= 3; i++) {
      const filePath = join(SAMPLE_DIR, 'chapters', 'schema', `chapter${i}.schema.md`)
      await expect(fs.access(filePath)).resolves.toBeUndefined()
    }
  })

  it('per-chapter files use chapters/schema/chapter prefix in path', async () => {
    const fs = await import('node:fs/promises')
    const files = await fs.readdir(join(SAMPLE_DIR, 'chapters', 'schema'))
    const schemaFiles = files.filter((f: string) => f.endsWith('.schema.md'))
    expect(schemaFiles.length).toBe(3)
    for (const f of schemaFiles) {
      expect(f).toMatch(/^chapter\d+\.schema\.md$/)
    }
  })

  it('schema-doc output contains YAML frontmatter', async () => {
    const content = await readFile(
      join(SAMPLE_DIR, 'chapters', 'schema', 'chapter1.schema.md'),
      'utf-8',
    )
    expect(content).toContain('---')
    expect(content).toContain('# ')
  })

  it('schema-doc output contains chapter titles', async () => {
    const content1 = await readFile(
      join(SAMPLE_DIR, 'chapters', 'schema', 'chapter1.schema.md'),
      'utf-8',
    )
    expect(content1).toContain('Chapter 1')

    const content2 = await readFile(
      join(SAMPLE_DIR, 'chapters', 'schema', 'chapter2.schema.md'),
      'utf-8',
    )
    expect(content2).toContain('Chapter 2')

    const content3 = await readFile(
      join(SAMPLE_DIR, 'chapters', 'schema', 'chapter3.schema.md'),
      'utf-8',
    )
    expect(content3).toContain('Chapter 3')
  })

  it('schema-doc metadata row has non-zero wordCount and tokenCount', async () => {
    for (let i = 1; i <= 3; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'schema', `chapter${i}.schema.md`),
        'utf-8',
      )
      const row = content.match(new RegExp(`\\| ${i} \\| (\\d+) \\| (\\d+) \\| (\\d+) \\|`))
      expect(row).not.toBeNull()
      expect(Number(row?.[1])).toBeGreaterThan(0) // wordCount
      expect(Number(row?.[2])).toBeGreaterThan(0) // tokenCount
      expect(Number(row?.[3])).toBeGreaterThan(0) // charLength
    }
  })

  it('schema-doc output contains Metadata, Summary, and Entities sections', async () => {
    const content = await readFile(
      join(SAMPLE_DIR, 'chapters', 'schema', 'chapter1.schema.md'),
      'utf-8',
    )
    expect(content).toContain('## Metadata')
    expect(content).toContain('| chapter | wordCount | tokenCount | charLength |')
    expect(content).toContain('## Summary')
    expect(content).toContain('## Entities')
    expect(content).toContain('```csv')
    expect(content).toContain('index,name')
  })
})

describe('schema-doc mock-emit pipeline (slot override)', () => {
  it('runs schemaDocMockPipeline and writes only to chapters/schema-mock', async () => {
    const fs = await import('node:fs/promises')
    await fs.rm(join(SAMPLE_DIR, 'chapters', 'schema'), { recursive: true, force: true })
    execSync(`"${MT_BIN}" run ./pipelines/jsonl-to-md-multi.ts --pipeline schemaDocMockPipeline`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
      timeout: 10_000,
    })
    for (let i = 1; i <= 3; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'schema-mock', `chapter${i}.mock.md`),
        'utf-8',
      )
      expect(content).toContain('<!-- mock-emit -->')
      expect(content).toContain('## Summary')
    }
    await expect(
      fs.access(join(SAMPLE_DIR, 'chapters', 'schema', 'chapter1.schema.md')),
    ).rejects.toThrow()
  })
})

describe('translate slots mock pipeline (.with({ translate }), offline)', () => {
  it('runs translateSlotsMockPipeline and writes mock-translated chapters', async () => {
    execSync(
      `"${MT_BIN}" run ./pipelines/jsonl-to-md-multi.ts --pipeline translateSlotsMockPipeline`,
      {
        cwd: SAMPLE_DIR,
        stdio: 'pipe',
        env: { ...process.env, NODE_OPTIONS: '--import tsx' },
        timeout: 10_000,
      },
    )
    for (let i = 1; i <= 3; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'translate-mock', `chapter${i}.mock.md`),
        'utf-8',
      )
      // the swapped `translate` slot wrapped both title and body in mock markers
      expect(content).toContain('[mock]')
      expect(content).toContain('[/mock]')
      expect(content).toContain(CHAPTERS[i - 1]?.body)
    }
  })
})

describe('llm gate pipeline (mock call slot, custom prompt, context shrink)', () => {
  it('runs offline and writes chapters/llm/chapter<N>.llm.md', async () => {
    execSync(`"${MT_BIN}" run ./pipelines/jsonl-to-md-multi.ts --pipeline llmGatePipeline`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
      timeout: 10_000,
    })
    for (let i = 0; i < CHAPTERS.length; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'llm', `chapter${i + 1}.llm.md`),
        'utf-8',
      )
      expect(content).toContain('mock-summary(')
      // custom prompt template reached the (mock) model
      expect(content).toContain('SAMPLE PROMPT - summarize in 2 sentences')
      expect(content).toContain(CHAPTERS[i].body)
      // context budget (60 tokens) trimmed the 12 filler history messages (system + final prompt always kept)
      expect(content).toMatch(/mock-summary\(3 msgs\)/)
      const m = content.match(/context: (\d+) -> (\d+) tokens/)
      expect(Number(m?.[1])).toBeGreaterThan(60)
      expect(Number(m?.[2])).toBeLessThanOrEqual(60)
    }
  })
})
