import { execSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const EN_DIR = join(SAMPLE_DIR, 'chapters', 'en')

// Tiny synthetic fixture: curly quotes, zero-width chars, stray symbols, bad spacing.
const RAW = [
  {
    key: 'fixture/chapter-1',
    value:
      'Chapter 1: First Light\n“Hello,” she said… it’s fine .\n[System: level up!]\n\n\n*Done*​  now go,fast',
  },
  {
    key: 'fixture/chapter-2',
    value: 'Chapter 2: Second Wind\nOne – two—three.\n* * *\nLast line﻿ here ,ok',
  },
]

// Body lines per chapter that must survive (decorative-only and blank lines excluded).
const EXPECTED_BODY_LINES = [3, 2]

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), { force: true })
  await mkdir(EN_DIR, { recursive: true })
  for (const f of await readdir(EN_DIR)) {
    if (f.endsWith('.md')) await rm(join(EN_DIR, f), { force: true })
  }
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

beforeAll(async () => {
  await cleanup()
  const jsonl = `${RAW.map((item) => JSON.stringify({ item })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonl, 'utf-8')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('normalize pipeline (offline, heuristics only)', () => {
  it('runs to completion', () => {
    execSync(`"${MT_BIN}" run ./pipelines/normalize.ts`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--import tsx', MT_LLM_TYPO_FIX: '' },
      timeout: 20_000,
    })
  })

  it('writes one md per chapter with stable names', async () => {
    const files = (await readdir(EN_DIR)).filter((f) => f.endsWith('.md')).sort()
    expect(files).toEqual(['chapter1.md', 'chapter2.md'])
  })

  it('keeps every paragraph line (one per line, none merged or split)', async () => {
    for (const [i, expected] of EXPECTED_BODY_LINES.entries()) {
      const md = await readFile(join(EN_DIR, `chapter${i + 1}.md`), 'utf-8')
      const lines = md.split('\n').filter((l) => l.trim() !== '')
      // 1 heading + body paragraphs
      expect(lines).toHaveLength(1 + expected)
      expect(lines[0]).toMatch(/^# Chapter \d+: /)
    }
  })

  it('has no curly quotes, ellipsis char or zero-width chars', async () => {
    for (const name of ['chapter1.md', 'chapter2.md']) {
      const md = await readFile(join(EN_DIR, name), 'utf-8')
      expect(md).not.toMatch(/[‘’“”…​-‏﻿ ]/)
      expect(md).not.toContain('*')
    }
  })

  it('keeps bracketed system messages literal and fixes punctuation', async () => {
    const md = await readFile(join(EN_DIR, 'chapter1.md'), 'utf-8')
    expect(md).toContain('[System: level up!]')
    expect(md).not.toContain('\\[')
    expect(md).toContain('"Hello," she said... it\'s fine.')
    expect(md).toContain('Done now go, fast')
  })
})
