import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LoremIpsum } from 'lorem-ipsum'

// ---------------------------------------------------------------------------
// Fixture writer for the three sample levels.
//
//   Beginner     jsonl/input.jsonl        one lorem paragraph per record
//   Intermediate jsonl/entities.jsonl     one large lorem markdown chapter per record
//   Advanced     jsonl/ladder.jsonl       chapter records for the Structure Ladder
//                chapters/chapter1.md     large chapter with decorative `---` lines
//                chapters/chapter-series.md large chapter for the series splitter
//
// The files are written **once**: a second `pnpm run prepare-input` leaves an
// existing fixture untouched, so a run always sees the same big text. Pass
// `--force` (or `pnpm run prepare-input:force`) to regenerate everything.
// ---------------------------------------------------------------------------

const SAMPLE_DIR = import.meta.dirname
const FORCE = process.argv.includes('--force')

/** Deterministic PRNG, so a forced regeneration produces the same fixtures. */
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

function makeLorem(seed: number, sentencesPerParagraph = { min: 3, max: 5 }): LoremIpsum {
  return new LoremIpsum({
    random: seededRandom(seed),
    sentencesPerParagraph,
    wordsPerSentence: { min: 8, max: 18 },
  })
}

/** Lorem paragraphs are joined with a single newline by the generator. */
function paragraphs(lorem: LoremIpsum, count: number): string[] {
  return lorem.generateParagraphs(count).split('\n')
}

function markdownChapter(lorem: LoremIpsum, title: string, paragraphCount: number): string {
  return [`# ${title}`, '', ...paragraphs(lorem, paragraphCount).flatMap((p) => [p, ''])].join('\n')
}

// --- Beginner --------------------------------------------------------------

function beginnerRecords(): { item: unknown }[] {
  const lorem = makeLorem(101, { min: 2, max: 3 })
  return Array.from({ length: 10 }, (_, index) => ({
    item: {
      id: index + 1,
      text: paragraphs(lorem, 2).join('\n\n'),
    },
  }))
}

// --- Intermediate ----------------------------------------------------------

const INTERMEDIATE_TITLES = [
  'The Quiet Harbour',
  'A Map of Small Roads',
  'The Orchard at Dusk',
  'Letters from the North',
]

function intermediateChapters(): { item: unknown }[] {
  const lorem = makeLorem(202)
  return INTERMEDIATE_TITLES.map((title) => ({
    item: markdownChapter(lorem, title, 4),
  }))
}

// --- Advanced: Structure Ladder -------------------------------------------

interface LadderRecord {
  number: number
  title: string
  paragraphs: string[][]
}

function ladderRecords(): { item: unknown }[] {
  const lorem = makeLorem(303)
  const titles = ['Ladder Chapter One', 'Ladder Chapter Two', 'Ladder Chapter Three']
  return titles.map((title, index) => {
    const record: LadderRecord = {
      number: index + 1,
      title,
      // Three paragraphs, three lines each. A line is one sentence, so the
      // paragraph/line rungs have real units to count.
      paragraphs: Array.from({ length: 3 }, () =>
        Array.from({ length: 3 }, () => lorem.generateSentences(1)),
      ),
    }
    return { item: record }
  })
}

// --- Advanced: chunk cleanup ----------------------------------------------

function chunkChapter(): string {
  const lorem = makeLorem(404)
  const sections = Array.from({ length: 6 }, (_, index) => {
    const heading = `## Section ${index + 1}`
    const body = paragraphs(lorem, 2).flatMap((paragraph) => [paragraph, ''])
    return [heading, '', ...body].join('\n')
  })
  // The decorative `---` lines between sections are what `chunkSplit` removes
  // before it writes its own separators around the chunks.
  return [
    '# The Structure Ladder',
    '',
    'This generated chapter is deliberately long: the chunk splitter cuts it into several',
    'chunks, and the Structure Ladder walks those chunks down to paragraphs, lines and words.',
    '',
    sections.join('\n---\n'),
    '',
  ].join('\n')
}

// --- Advanced: series splitter --------------------------------------------

function seriesChapter(): string {
  const lorem = makeLorem(505)
  return markdownChapter(lorem, 'The Long Road', 12)
}

// --- Write-once plumbing ---------------------------------------------------

const written: string[] = []
const skipped: string[] = []

async function writeOnce(relativePath: string, content: string): Promise<void> {
  const path = join(SAMPLE_DIR, relativePath)
  if (!FORCE && existsSync(path)) {
    skipped.push(relativePath)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
  written.push(relativePath)
}

function toJsonl(items: { item: unknown }[]): string {
  return `${items.map((item) => JSON.stringify(item)).join('\n')}\n`
}

async function main(): Promise<void> {
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })

  await writeOnce('jsonl/input.jsonl', toJsonl(beginnerRecords()))
  await writeOnce('jsonl/entities.jsonl', toJsonl(intermediateChapters()))
  await writeOnce('jsonl/ladder.jsonl', toJsonl(ladderRecords()))
  await writeOnce('chapters/chapter1.md', chunkChapter())
  await writeOnce('chapters/chapter-series.md', seriesChapter())

  for (const file of written) console.log(`wrote   ${file}`)
  for (const file of skipped) console.log(`kept    ${file} (already exists; --force rewrites)`)
  if (written.length === 0 && skipped.length > 0) {
    console.log('All fixtures already exist. Use `pnpm run prepare-input:force` to regenerate.')
  }
}

main().catch((error: unknown) => {
  console.error(`prepare-input failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
