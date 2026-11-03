import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LoremIpsum } from 'lorem-ipsum'

// ---------------------------------------------------------------------------
// Fixture writer for sample3.
//
//   jsonl/input.jsonl   3 chapter records: { title, body, sourceFile }
//
// The chapters are generated lorem ipsum, so the sample needs no external
// `books/` directory. The titles match the ones the title dictionary in
// `pipelines/jsonl-to-md-multi.ts` translates, so the packaged-titles demo
// still works.
//
// The file is written **once**: a second `pnpm run prepare-input` leaves an
// existing fixture untouched, so a run always sees the same text. Pass
// `--force` (or `pnpm run prepare-input:force`) to regenerate it.
// ---------------------------------------------------------------------------

const SAMPLE_DIR = import.meta.dirname
const FORCE = process.argv.includes('--force')

/** Deterministic PRNG, so a forced regeneration produces the same fixture. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function makeLorem(seed: number): LoremIpsum {
  return new LoremIpsum({
    random: seededRandom(seed),
    sentencesPerParagraph: { min: 3, max: 5 },
    wordsPerSentence: { min: 8, max: 18 },
  })
}

/** Lorem paragraphs are joined with a single newline by the generator. */
function paragraphs(lorem: LoremIpsum, count: number): string[] {
  return lorem.generateParagraphs(count).split('\n')
}

/** One JSONL record: title + plain markdown body (no H1, `chapterDoc` adds it). */
interface ChapterRecord {
  title: string
  body: string
  sourceFile: string
}

const CHAPTER_TITLES = [
  'Chapter 1: The Road from Thornhaven',
  'Chapter 2: Ambush in the Darkwood',
  'Chapter 3: The Duke’s Tribunal',
]

function chapterRecords(): ChapterRecord[] {
  const lorem = makeLorem(303)
  return CHAPTER_TITLES.map((title, index) => ({
    title,
    body: paragraphs(lorem, 5).join('\n\n'),
    sourceFile: `chapter-${index + 1}.en.md`,
  }))
}

function toJsonl(records: ChapterRecord[]): string {
  return `${records.map((record) => JSON.stringify({ item: record, meta: {} })).join('\n')}\n`
}

async function main(): Promise<void> {
  const relativePath = 'jsonl/input.jsonl'
  const path = join(SAMPLE_DIR, relativePath)
  if (!FORCE && existsSync(path)) {
    console.log(`kept    ${relativePath} (already exists; --force rewrites)`)
    console.log('Use `pnpm run prepare-input:force` to regenerate.')
    return
  }
  await mkdir(dirname(path), { recursive: true })
  const records = chapterRecords()
  await writeFile(path, toJsonl(records), 'utf-8')
  console.log(`wrote   ${relativePath} (${records.length} lorem ipsum chapters)`)
}

main().catch((error: unknown) => {
  console.error(`prepare-input failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
