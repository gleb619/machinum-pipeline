import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BATCH_MEMBERS_VARIABLE,
  MD_OUTPUTS_VARIABLE,
  createExchange,
  getVariable,
  setVariable,
} from '@mt/core'
import type { MdOutputEntry, ToolContext } from '@mt/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type SplitUnit,
  VAR_SPLIT_UNIT,
  baseTitleOf,
  createSplitChapterTool,
  partTitleOf,
  planSplit,
  readChapterMap,
  readStats,
  rewriteHeading,
  serializeChapterMap,
  splitProduced,
  writeSplitOutputs,
} from './chapter-split.js'

const CTX = { run: { global: { env: {}, settings: {} } } } as unknown as ToolContext

const LARGE = [
  '# Chapter One',
  '',
  ...Array.from({ length: 8 }, (_, index) => [
    `Paragraph ${index + 1} opens with a long descriptive line that carries real weight.`,
    `Paragraph ${index + 1} closes with another long reflective line to add more bulk.`,
  ]).flatMap((lines) => [...lines, '']),
].join('\n')

const CHAPTER_ONE = '# Chapter 1: Salt Row\n\nA.\n'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mt-chapter-split-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function unit(orig: number, title: string, parts: string[]): SplitUnit {
  return { orig, title, parts }
}

describe('titles', () => {
  it('strips the chapter prefix and falls back to the verbatim heading', () => {
    expect(baseTitleOf('Chapter 3: Salt Row')).toBe('Salt Row')
    expect(baseTitleOf('Chapter 4 - Ash')).toBe('Ash')
    expect(baseTitleOf('Prologue')).toBe('Prologue')
  })

  it('only adds the part suffix when the chapter was split', () => {
    expect(partTitleOf('Salt Row', 7, 1, 1)).toBe('Chapter 7: Salt Row')
    expect(partTitleOf('Salt Row', 7, 2, 3)).toBe('Chapter 7: Salt Row (part 2/3)')
  })

  it('rewrites the single H1 and rejects a document without one', () => {
    expect(rewriteHeading(CHAPTER_ONE, 'Chapter 9: Salt Row')).toBe('# Chapter 9: Salt Row\n\nA.\n')
    expect(() => rewriteHeading('no heading\n', 'x')).toThrow(/without an H1 heading/)
  })
})

describe('planSplit', () => {
  it('renumbers the book sequentially and keeps every part range contiguous', () => {
    const plan = planSplit([
      unit(2, 'Chapter 4: Ash', ['# Chapter 4: Ash\n\nC.\n']),
      unit(1, 'Chapter 3: Salt Row', [
        '# Chapter 3: Salt Row\n\nA.\n',
        '# Chapter 3: Salt Row\n\nB.\n',
      ]),
    ])
    expect(plan.split).toBe(true)
    expect(plan.map).toEqual({
      '1': { orig: 1, part: 1, of: 2 },
      '2': { orig: 1, part: 2, of: 2 },
      '3': { orig: 2, part: 1, of: 1 },
    })
    expect(plan.files.map((file) => file.id)).toEqual([1, 2, 3])
    expect(plan.files[0]?.markdown.startsWith('# Chapter 1: Salt Row (part 1/2)')).toBe(true)
    expect(plan.files[2]?.markdown.startsWith('# Chapter 3: Ash')).toBe(true)
  })

  it('is the identity case when no chapter was split', () => {
    const plan = planSplit([unit(1, 'Chapter 1: A', ['# Chapter 1: A\n\nX.\n'])])
    expect(plan.split).toBe(false)
    expect(plan.files).toEqual([])
    expect(plan.map).toEqual({ '1': { orig: 1, part: 1, of: 1 } })
  })

  it('serializes the map deterministically with a trailing newline', () => {
    const map = planSplit([unit(1, 'Chapter 1: A', ['# Chapter 1: A\n\nX.\n'])]).map
    expect(serializeChapterMap(map)).toBe(
      '{\n  "1": {\n    "orig": 1,\n    "part": 1,\n    "of": 1\n  }\n}\n',
    )
  })
})

describe('readStats', () => {
  it('reads a stats artefact with a numeric threshold', () => {
    const dir = tempDir()
    const file = join(dir, 'stats.json')
    writeFileSync(file, JSON.stringify({ book: { threshold: 120.7 } }))
    expect(readStats(file).book.threshold).toBe(120.7)
  })

  it('fails loudly when the threshold is missing', () => {
    const dir = tempDir()
    const file = join(dir, 'stats.json')
    writeFileSync(file, JSON.stringify({ book: {} }))
    expect(() => readStats(file)).toThrow(/has no numeric book.threshold/)
  })
})

describe('readChapterMap / splitProduced', () => {
  it('returns undefined for a missing or invalid map', () => {
    const dir = tempDir()
    expect(readChapterMap(join(dir, 'absent.json'))).toBeUndefined()
    const invalid = join(dir, 'bad.json')
    writeFileSync(invalid, 'not json')
    expect(readChapterMap(invalid)).toBeUndefined()
  })

  it('detects whether the split stage produced renumbered parts', () => {
    const dir = tempDir()
    const file = join(dir, 'chapter-map.json')
    writeFileSync(file, JSON.stringify({ '1': { orig: 1, part: 1, of: 2 } }))
    const map = readChapterMap(file)
    expect(splitProduced(map)).toBe(true)
    expect(splitProduced({ '1': { orig: 1, part: 1, of: 1 } })).toBe(false)
    expect(splitProduced(undefined)).toBe(false)
  })
})

describe('createSplitChapterTool', () => {
  it('splits a chapter above the stats threshold and records the split unit', async () => {
    const dir = tempDir()
    const stats = join(dir, 'stats.json')
    writeFileSync(stats, JSON.stringify({ book: { threshold: 120 } }))
    const tool = createSplitChapterTool({ statsPath: stats })
    const out = await tool.invoke(createExchange(LARGE, { meta: { chapterNum: 3 } }), CTX)
    const recorded = getVariable<SplitUnit>(out, VAR_SPLIT_UNIT)
    expect(recorded?.orig).toBe(3)
    expect(recorded?.title).toBe('Chapter One')
    expect(recorded?.parts.length ?? 0).toBeGreaterThan(1)
    expect(out.item).toEqual(recorded?.parts)
  })

  it('resolves a thunk lazily at the first invoke', async () => {
    const dir = tempDir()
    const stats = join(dir, 'stats.json')
    writeFileSync(stats, JSON.stringify({ book: { threshold: 10_000 } }))
    let calls = 0
    const tool = createSplitChapterTool({
      statsPath: () => {
        calls += 1
        return stats
      },
    })
    expect(calls).toBe(0)
    const out = await tool.invoke(createExchange(LARGE, { meta: { chapterNum: 1 } }), CTX)
    expect(calls).toBe(1)
    expect(out.item).toEqual([LARGE])
  })
})

describe('writeSplitOutputs', () => {
  it('emits the renumbered parts plus chapter-map.json', async () => {
    const members = [
      setVariable(
        createExchange(LARGE),
        VAR_SPLIT_UNIT,
        unit(1, 'Chapter 3: Salt Row', [
          '# Chapter 3: Salt Row\n\nA.\n',
          '# Chapter 3: Salt Row\n\nB.\n',
        ]),
      ),
      setVariable(
        createExchange(LARGE),
        VAR_SPLIT_UNIT,
        unit(2, 'Chapter 4: Ash', ['# Chapter 4: Ash\n\nC.\n']),
      ),
    ]
    const batch = setVariable(createExchange<unknown[]>([LARGE, LARGE]), BATCH_MEMBERS_VARIABLE, {
      members,
      base: [],
    })
    const out = await writeSplitOutputs.invoke(batch, CTX)
    const outputs = getVariable<MdOutputEntry[]>(out, MD_OUTPUTS_VARIABLE) ?? []
    expect(outputs.map((entry) => `${entry.subdir}/${entry.filename}`)).toEqual([
      'split/chapter1.md',
      'split/chapter2.md',
      'split/chapter3.md',
      'schema/chapter-map.json',
    ])
    expect(outputs[0]?.content.startsWith('# Chapter 1: Salt Row (part 1/2)')).toBe(true)
    expect(JSON.parse(outputs[3]?.content ?? '{}')).toEqual({
      '1': { orig: 1, part: 1, of: 2 },
      '2': { orig: 1, part: 2, of: 2 },
      '3': { orig: 2, part: 1, of: 1 },
    })
  })

  it('emits only chapter-map.json when nothing was split', async () => {
    const members = [
      setVariable(
        createExchange(LARGE),
        VAR_SPLIT_UNIT,
        unit(1, 'Chapter 1: A', ['# Chapter 1: A\n\nX.\n']),
      ),
    ]
    const batch = setVariable(createExchange<unknown[]>([LARGE]), BATCH_MEMBERS_VARIABLE, {
      members,
      base: [],
    })
    const out = await writeSplitOutputs.invoke(batch, CTX)
    const outputs = getVariable<MdOutputEntry[]>(out, MD_OUTPUTS_VARIABLE) ?? []
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ subdir: 'schema', filename: 'chapter-map.json' })
  })

  it('throws when the split stage did not run', async () => {
    const batch = setVariable(createExchange<unknown[]>([]), BATCH_MEMBERS_VARIABLE, {
      members: [],
      base: [],
    })
    await expect(writeSplitOutputs.invoke(batch, CTX)).rejects.toThrow(/no chapter units/)
  })
})
