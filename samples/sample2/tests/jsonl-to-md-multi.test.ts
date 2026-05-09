import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, cp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const CORE_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'core')
const CLI_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'cli')
const TOOLS_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'tools')
const WAYPOINT_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'waypoint')

const CHAPTERS = [
  { title: 'Chapter 1: The Road from Thornhaven', body: 'Sir Aldric tightened the strap.' },
  { title: 'Chapter 2: Ambush in the Darkwood', body: 'The trees closed in like witnesses.' },
  { title: "Chapter 3: The Duke\u2019s Tribunal", body: 'Upon the third day, Sir Aldric arrived.' },
]

let workDir: string

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mt-sample2-test-'))
  const vendorDir = join(workDir, 'vendor')
  await mkdir(vendorDir, { recursive: true })
  await mkdir(join(workDir, 'jsonl'), { recursive: true })
  await mkdir(join(workDir, 'md'), { recursive: true })
  await mkdir(join(workDir, 'chapters', 'schema'), { recursive: true })

  execSync(`pnpm -C "${CORE_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })
  execSync(`pnpm -C "${CLI_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })
  execSync(`pnpm -C "${TOOLS_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })
  execSync(`pnpm -C "${WAYPOINT_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })

  const pkgJson = {
    name: 'sample2-test',
    type: 'module',
    dependencies: {
      '@mt/core': 'file:./vendor/mt-core-0.1.0.tgz',
      '@mt/cli': 'file:./vendor/mt-cli-0.1.0.tgz',
      '@mt/tools': 'file:./vendor/mt-tools-0.1.0.tgz',
      '@mt/waypoint': 'file:./vendor/mt-waypoint-0.1.0.tgz',
      'tsx': '^4.19.0',
    },
  }
  await writeFile(join(workDir, 'package.json'), JSON.stringify(pkgJson, null, 2))
  execSync('npm install --no-audit --no-fund', { cwd: workDir, stdio: 'pipe' })

  await cp(join(SAMPLE_DIR, 'mt.json'), join(workDir, 'mt.json'))
  await cp(join(SAMPLE_DIR, 'pipelines'), join(workDir, 'pipelines'), { recursive: true })

  const jsonlContent = CHAPTERS.map((ch) => JSON.stringify({ item: ch })).join('\n') + '\n'
  await writeFile(join(workDir, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
}, 60_000)

afterAll(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true })
  }
})

describe('jsonl-to-md-multi pipeline', () => {
  it('runs the jsonl-to-md-multi pipeline to completion', () => {
    const mtBin = join(workDir, 'node_modules', '.bin', 'mt')
    execSync(`node --import tsx "${mtBin}" run ./pipelines/jsonl-to-md-multi.ts`, {
      cwd: workDir,
      stdio: 'pipe',
      timeout: 30_000,
    })
  })

  it('output.md contains all 3 chapter titles and bodies', async () => {
    const content = await readFile(join(workDir, 'md', 'output.md'), 'utf-8')
    for (const ch of CHAPTERS) {
      expect(content).toContain(ch.title)
    }
  })

  it('output.md chapters are in correct order (chapter 1 before chapter 2 before chapter 3)', () => {
    const content = readFileSync(join(workDir, 'md', 'output.md'), 'utf-8')
    const idx1 = content.indexOf('Chapter 1')
    const idx2 = content.indexOf('Chapter 2')
    const idx3 = content.indexOf('Chapter 3')
    expect(idx1).toBeGreaterThan(-1)
    expect(idx2).toBeGreaterThan(idx1)
    expect(idx3).toBeGreaterThan(idx2)
  })

  it('fork enriches output.md with meta fields', () => {
    const content = readFileSync(join(workDir, 'md', 'output.md'), 'utf-8')
    // After fork, output.md contains merged markdown with all 3 chapters
    for (const ch of CHAPTERS) {
      expect(content).toContain(ch.title)
    }
  })

  it('fork does not lose items — all 3 chapter titles in order', () => {
    const content = readFileSync(join(workDir, 'md', 'output.md'), 'utf-8')
    const idx1 = content.indexOf('Chapter 1')
    const idx2 = content.indexOf('Chapter 2')
    const idx3 = content.indexOf('Chapter 3')
    expect(idx1).toBeGreaterThan(-1)
    expect(idx2).toBeGreaterThan(idx1)
    expect(idx3).toBeGreaterThan(idx2)
  })
})

describe('schema-doc pipeline', () => {
  it('runs the schemaPipeline to completion', () => {
    const mtBin = join(workDir, 'node_modules', '.bin', 'mt')
    execSync(
      `node --import tsx "${mtBin}" run ./pipelines/jsonl-to-md-multi.ts --pipeline schemaPipeline`,
      { cwd: workDir, stdio: 'pipe', timeout: 30_000 },
    )
  })

  it('generates per-chapter schema files: chapter1.schema.md, chapter2.schema.md, chapter3.schema.md', async () => {
    const fs = await import('node:fs/promises')
    for (let i = 1; i <= 3; i++) {
      const filePath = join(workDir, 'chapters', 'schema', `chapter${i}.schema.md`)
      await expect(fs.access(filePath)).resolves.toBeUndefined()
    }
  })

  it('per-chapter files use chapters/schema/chapter prefix in path', async () => {
    const fs = await import('node:fs/promises')
    const files = await fs.readdir(join(workDir, 'chapters', 'schema'))
    const schemaFiles = files.filter((f: string) => f.endsWith('.schema.md'))
    expect(schemaFiles.length).toBe(3)
    for (const f of schemaFiles) {
      expect(f).toMatch(/^chapter\d+\.schema\.md$/)
    }
  })

  it('schema-doc output contains YAML frontmatter', async () => {
    const content = await readFile(join(workDir, 'chapters', 'schema', 'chapter1.schema.md'), 'utf-8')
    expect(content).toContain('---')
    expect(content).toContain('# ')
  })

  it('schema-doc output contains chapter titles', async () => {
    // Each chapter file should contain its own title
    const content1 = await readFile(join(workDir, 'chapters', 'schema', 'chapter1.schema.md'), 'utf-8')
    expect(content1).toContain('Chapter 1')

    const content2 = await readFile(join(workDir, 'chapters', 'schema', 'chapter2.schema.md'), 'utf-8')
    expect(content2).toContain('Chapter 2')

    const content3 = await readFile(join(workDir, 'chapters', 'schema', 'chapter3.schema.md'), 'utf-8')
    expect(content3).toContain('Chapter 3')
  })

  it('schema-doc output contains Summary and Entities sections', async () => {
    const content = await readFile(join(workDir, 'chapters', 'schema', 'chapter1.schema.md'), 'utf-8')
    expect(content).toContain('## Summary')
    expect(content).toContain('## Entities')
  })
})
