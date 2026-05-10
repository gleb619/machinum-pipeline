import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdir, readFile, rm, cp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const CORE_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'core')
const CLI_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'cli')
const WAYPOINT_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'waypoint')

const CHAPTERS = [
  { title: 'Chapter 1: The Road from Thornhaven', body: 'Sir Aldric tightened the strap.' },
  { title: 'Chapter 2: Ambush in the Darkwood', body: 'The trees closed in like witnesses.' },
  { title: "Chapter 3: The Duke's Tribunal", body: 'Upon the third day, Sir Aldric arrived.' },
]

let workDir: string

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mt-jsonl-to-md-test-'))
  const vendorDir = join(workDir, 'vendor')
  await mkdir(vendorDir, { recursive: true })
  await mkdir(join(workDir, 'jsonl'), { recursive: true })
  await mkdir(join(workDir, 'md'), { recursive: true })

  execSync(`pnpm -C "${CORE_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })
  execSync(`pnpm -C "${CLI_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })
  execSync(`pnpm -C "${WAYPOINT_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })

  const pkgJson = {
    name: 'sample1-jsonl-to-md-test',
    type: 'module',
    dependencies: {
      '@mt/core': 'file:./vendor/mt-core-0.1.0.tgz',
      '@mt/cli': 'file:./vendor/mt-cli-0.1.0.tgz',
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
}, 180_000)

afterAll(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true })
  }
})

describe('jsonl-to-md pipeline', () => {
  it('runs the jsonl-to-md pipeline to completion', () => {
    const mtBin = join(workDir, 'node_modules', '.bin', 'mt')
    execSync(`node --import tsx "${mtBin}" run ./pipelines/jsonl-to-md.ts`, {
      cwd: workDir,
      stdio: 'pipe',
      timeout: 30_000,
    })
  })

  it('output.md contains stringified chapter data', async () => {
    const content = await readFile(join(workDir, 'md', 'output.md'), 'utf-8')
    for (const ch of CHAPTERS) {
      expect(content).toContain(ch.title)
      expect(content).toContain(ch.body)
    }
  })
})
