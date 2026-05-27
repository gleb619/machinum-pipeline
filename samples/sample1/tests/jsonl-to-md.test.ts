import { execSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const CORE_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'core')
const CLI_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'cli')
const WAYPOINT_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'waypoint')
const TOOLS_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'tools')

const CHAPTERS = [
  { title: 'Chapter 1: The Road from Thornhaven', body: 'Sir Aldric tightened the strap.' },
  { title: 'Chapter 2: Ambush in the Darkwood', body: 'The trees closed in like witnesses.' },
  { title: "Chapter 3: The Duke's Tribunal", body: 'Upon the third day, Sir Aldric arrived.' },
]

let workDir: string
let hasFailure = false

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mt-jsonl-to-md-test-'))
  const vendorDir = join(workDir, 'vendor')
  await mkdir(vendorDir, { recursive: true })
  await mkdir(join(workDir, 'jsonl'), { recursive: true })
  await mkdir(join(workDir, 'chapters', 'en'), { recursive: true })

  execSync(`pnpm -C "${CORE_SRC}" pack --pack-destination "${vendorDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  })
  execSync(`pnpm -C "${CLI_SRC}" pack --pack-destination "${vendorDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  })
  execSync(`pnpm -C "${WAYPOINT_SRC}" pack --pack-destination "${vendorDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  })
  execSync(`pnpm -C "${TOOLS_SRC}" pack --pack-destination "${vendorDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  })

  const pkgJson = {
    name: 'sample1-jsonl-to-md-test',
    type: 'module',
    dependencies: {
      '@mt/core': 'file:./vendor/mt-core-0.1.0.tgz',
      '@mt/cli': 'file:./vendor/mt-cli-0.1.0.tgz',
      '@mt/waypoint': 'file:./vendor/mt-waypoint-0.1.0.tgz',
      '@mt/tools': 'file:./vendor/mt-tools-0.1.0.tgz',
      tsx: '^4.19.0',
    },
  }
  await writeFile(join(workDir, 'package.json'), JSON.stringify(pkgJson, null, 2))
  execSync('npm install --no-audit --no-fund', { cwd: workDir, stdio: 'pipe', timeout: 120_000 })

  await cp(join(SAMPLE_DIR, 'mt.json'), join(workDir, 'mt.json'))
  await cp(join(SAMPLE_DIR, 'pipelines'), join(workDir, 'pipelines'), { recursive: true })

  const jsonlContent = `${CHAPTERS.map((ch) => JSON.stringify({ item: ch })).join('\n')}\n`
  await writeFile(join(workDir, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
}, 240_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') {
    hasFailure = true
  }
})

afterAll(async () => {
  if (hasFailure) {
    console.log(`Skipping cleanup because a test failed. Work directory: ${workDir}`)
    return
  }

  if (workDir) {
    await rm(workDir, { recursive: true, force: true })
  }
})

describe('jsonl-to-md pipeline', () => {
  it('runs example (jsonl-to-md)', () => {
    const mtBin = join(workDir, 'node_modules', '.bin', 'mt')
    execSync(`node --import tsx "${mtBin}" run ./pipelines/jsonl-to-md.ts`, {
      cwd: workDir,
      stdio: 'pipe',
      timeout: 30_000,
    })
  })

  it('output.md contains stringified chapter data', async () => {
    for (let i = 0; i < CHAPTERS.length; i++) {
      const content = await readFile(join(workDir, 'chapters', 'en', `chapter${i + 1}.md`), 'utf-8')
      expect(content.split(`# ${CHAPTERS[i].title}`).length).toBe(2)
      expect(content).toContain(CHAPTERS[i].body)
      expect(content).toContain('---')
    }
  })
})
