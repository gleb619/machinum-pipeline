import { execSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')

const CHAPTERS = [
  {
    title: 'Chapter 1: The Road from Thornhaven',
    body: '# Chapter 1: The Road from Thornhaven\n\nSir Aldric tightened the strap.',
  },
  {
    title: 'Chapter 2: Ambush in the Darkwood',
    body: '# Chapter 2: Ambush in the Darkwood\n\nThe trees closed in like witnesses.',
  },
  {
    title: "Chapter 3: The Duke's Tribunal",
    body: "# Chapter 3: The Duke's Tribunal\n\nUpon the third day, Sir Aldric arrived.",
  },
]

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await rm(join(SAMPLE_DIR, 'chapters', 'en'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'chapters', 'en'), { recursive: true })

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

describe('jsonl-to-md pipeline', () => {
  it('runs example (jsonl-to-md)', () => {
    execSync(`"${MT_BIN}" run ./pipelines/jsonl-to-md.ts`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
      timeout: 10_000,
    })
  })

  it('output.md contains stringified chapter data', async () => {
    for (let i = 0; i < CHAPTERS.length; i++) {
      const content = await readFile(
        join(SAMPLE_DIR, 'chapters', 'en', `chapter${i + 1}.md`),
        'utf-8',
      )
      expect(content.split(`# ${CHAPTERS[i].title}`).length).toBe(2)
      expect(content).toContain(CHAPTERS[i].body)
      expect(content).toContain('---')
    }
  })
})
