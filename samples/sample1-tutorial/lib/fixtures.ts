import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LoremIpsum } from 'lorem-ipsum'

/**
 * Fixture generator of the tutorial sample.
 *
 * Two kinds of input feed the pipes:
 *
 *  - lorem-ipsum fixtures — bulk text for the chunking / ladder / fork pipes. The
 *    `lorem-ipsum` dev dependency is driven by a seeded PRNG, so a forced regeneration
 *    produces the very same chapters.
 *  - copies of the real book (`books/book1`) — the chapters the HTTP simulation posts
 *    and the chapters the LLM gallery judges its tools on.
 *
 *   jsonl/beginner.jsonl        10 short records          → pipe01 (from → use → to)
 *   jsonl/entities.jsonl        4 markdown chapters        → pipe04 (forks)
 *   jsonl/ladder.jsonl          3 chapter records          → pipe05 (structure ladder)
 *   jsonl/raw.jsonl             3 messy raw chapters       → pipe07 (normalize)
 *   fixtures/chapter1.md        long chapter with `---`    → pipe05 (chunk split)
 *   fixtures/chapter-series.md  long chapter               → pipe05 (series split)
 *   fixtures/gallery/*.md       copies of books/book1      → pipe09 (LLM gallery)
 *   fixtures/typos/chapter1.md  book1 chapter with typos   → pipe09 (typo fix)
 */

/** Repo-root `books/` directory (two levels up from `samples/sample1-tutorial`). */
export const BOOKS_DIR = join(import.meta.dirname, '..', '..', '..', 'books')

/** Deterministic PRNG, so a forced regeneration produces the same fixtures. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function makeLorem(seed: number, sentencesPerParagraph = { min: 3, max: 5 }): LoremIpsum {
  return new LoremIpsum({
    random: seededRandom(seed),
    sentencesPerParagraph,
    wordsPerSentence: { min: 8, max: 18 },
  })
}

/** Lorem paragraphs are joined with a single newline by the generator. */
export function paragraphs(lorem: LoremIpsum, count: number): string[] {
  return lorem.generateParagraphs(count).split('\n')
}

function markdownChapter(lorem: LoremIpsum, title: string, paragraphCount: number): string {
  return [`# ${title}`, '', ...paragraphs(lorem, paragraphCount).flatMap((p) => [p, ''])].join('\n')
}

function toJsonl(items: unknown[]): string {
  return `${items.map((item) => JSON.stringify({ item })).join('\n')}\n`
}

// --- pipe01: one short record per line ------------------------------------

export function beginnerRecords(): { id: number; text: string }[] {
  const lorem = makeLorem(101, { min: 2, max: 3 })
  return Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    text: paragraphs(lorem, 2).join('\n\n'),
  }))
}

// --- pipe04: markdown chapters for the fork branches ------------------------

const FORK_TITLES = [
  'The Quiet Harbour',
  'A Map of Small Roads',
  'The Orchard at Dusk',
  'Letters from the North',
]

const FORK_REVIEWERS = ['alice', 'bob', 'carol', 'dave']

/**
 * Fork chapters carry YAML frontmatter: the fork branches read `number` and `series`
 * from it (`ChapterMetadata`), and the branch that renders the counts view prints them.
 */
export function forkChapters(): string[] {
  const lorem = makeLorem(202)
  return FORK_TITLES.map((title, index) => {
    const body = markdownChapter(lorem, title, 4)
    const frontmatter = [
      '---',
      `number: ${index + 1}`,
      'series: demo-serial',
      `reviewer: ${FORK_REVIEWERS[index] ?? 'unknown'}`,
      '---',
      '',
    ].join('\n')
    return `${frontmatter}${body}`
  })
}

// --- pipe05: records for the Structure Ladder -------------------------------

export interface LadderRecord {
  number: number
  title: string
  paragraphs: string[][]
}

export function ladderRecords(): LadderRecord[] {
  const lorem = makeLorem(303)
  const titles = ['Ladder Chapter One', 'Ladder Chapter Two', 'Ladder Chapter Three']
  return titles.map((title, index) => ({
    number: index + 1,
    title,
    // Three paragraphs, three lines each — a line is one sentence, so the
    // paragraph/line rungs have real units to count.
    paragraphs: Array.from({ length: 3 }, () =>
      Array.from({ length: 3 }, () => lorem.generateSentences(1)),
    ),
  }))
}

// --- pipe05: a long chapter that the chunk splitter really splits -----------

export function chunkChapter(): string {
  const lorem = makeLorem(404)
  const sections = Array.from({ length: 6 }, (_, index) => {
    const heading = `## Section ${index + 1}`
    const body = paragraphs(lorem, 2).flatMap((paragraph) => [paragraph, ''])
    return [heading, '', ...body].join('\n')
  })
  // The decorative `---` lines between the sections are what `chunkSplit` removes
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

// --- pipe05: a chapter above the series-split target ------------------------

export function seriesChapter(): string {
  const lorem = makeLorem(505)
  return markdownChapter(lorem, 'The Long Road', 12)
}

// --- pipe07: raw, messy chapters for the normalizer -------------------------

/** Curly quotes and stray spacing — the things the normalizer removes. */
function messUp(text: string): string {
  return text.replace(/,/g, ' ,').replace(/\./g, ' .')
}

export interface RawRecord {
  key: string
  value: string
}

export function rawRecords(): RawRecord[] {
  const lorem = makeLorem(606, { min: 2, max: 3 })
  const titles = ['First Light', 'Second Wind', 'The Long Night']
  return titles.map((title, index) => {
    const body = paragraphs(lorem, 3)
      .map(messUp)
      .join('\n')
      .replace(/\s+—\s+/g, '—')
    return {
      key: `fixture/chapter-${index + 1}`,
      // Curly quotes, a decorative line and a stray space before the comma: exactly
      // the noise the normalizer of pipe07 has to clean up.
      value: `Chapter ${index + 1}: ${title}\n“${body}”\n* * *\n[System: level up!]`,
    }
  })
}

// --- pipe09: planted typos in a real book chapter ----------------------------

/** The typos the typo-fix pipe has to remove (and the report counts). */
export const PLANTED_TYPOS = [
  'tightnd',
  'wieght',
  'accross',
  'befor',
  'diferent',
  'unfamilar',
  'pased',
  'feilds',
  'mutterd',
]

const TYPO_REPLACEMENTS: Array<[string, string]> = [
  ['tightened', 'tightnd'],
  ['weight', 'wieght'],
  ['across', 'accross'],
  ['before', 'befor'],
  ['different', 'diferent'],
  ['unfamiliar', 'unfamilar'],
  ['passed', 'pased'],
  ['fields', 'feilds'],
  ['muttered', 'mutterd'],
]

/** Copy of `books/book1/chapter-1.en.md` with the typos planted. */
export function plantTypos(markdown: string): string {
  let text = markdown
  for (const [original, typo] of TYPO_REPLACEMENTS) {
    text = text.replace(original, typo)
  }
  return text
}

// --- writer ----------------------------------------------------------------

/** Write-once helper: an existing fixture is kept unless `force` is set. */
export async function writeOnce(
  root: string,
  relativePath: string,
  content: string,
  force: boolean,
): Promise<'written' | 'kept'> {
  const path = join(root, relativePath)
  if (!force && existsSync(path)) return 'kept'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
  return 'written'
}

/**
 * Write every fixture of the sample. Returns the relative path of each file and
 * whether it was written (`written`) or kept as it was (`kept`).
 */
export async function writeFixtures(
  root: string,
  force = false,
): Promise<Array<{ path: string; status: 'written' | 'kept' }>> {
  const results: Array<{ path: string; status: 'written' | 'kept' }> = []

  const record = async (relativePath: string, content: string): Promise<void> => {
    const status = await writeOnce(root, relativePath, content, force)
    results.push({ path: relativePath, status })
  }

  await record('jsonl/beginner.jsonl', toJsonl(beginnerRecords()))
  await record('jsonl/entities.jsonl', toJsonl(forkChapters()))
  await record('jsonl/ladder.jsonl', toJsonl(ladderRecords()))
  await record(
    'jsonl/raw.jsonl',
    `${rawRecords()
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  )
  await record('fixtures/chapter1.md', chunkChapter())
  await record('fixtures/chapter-series.md', seriesChapter())

  // Real book data: the gallery pipes judge the LLM tools on the actual book text.
  const book1 = join(BOOKS_DIR, 'book1')
  const chapter1 = await readFile(join(book1, 'chapter-1.en.md'), 'utf-8')
  const chapter2 = await readFile(join(book1, 'chapter-2.en.md'), 'utf-8')
  await record('fixtures/gallery/chapter1.md', chapter1)
  await record('fixtures/gallery/chapter2.md', chapter2)
  await record('fixtures/typos/chapter1.md', plantTypos(chapter1))

  return results
}
