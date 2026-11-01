import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SAMPLE_DIR = import.meta.dirname
const RECORDS = [
  { id: 1, text: 'First line of the document.\n\nSecond paragraph here.' },
  { id: 2, text: 'Second line of the document.\n\nAnother paragraph.' },
  { id: 3, text: 'Third line of the document.\n\nFinal paragraph.' },
]

// Chapter/Paragraph/Line fixture for the entity pipeline.
const ENTITY_RECORDS = [
  {
    number: 1,
    title: 'Chapter One',
    paragraphs: [
      ['The first line has words.', 'Second line follows here.'],
      ['A short paragraph ends.'],
    ],
  },
  {
    number: 2,
    title: 'Chapter Two',
    paragraphs: [['Third chapter starts now.'], ['Final line closes the book.']],
  },
]

// Chapter fixture for the Structure Ladder demo. The long paragraph of the
// first chapter is longer than the chunk budget, so it splits into several
// chunks on the way down the ladder.
const LADDER_RECORDS = [
  {
    number: 1,
    title: 'Ladder Chapter One',
    paragraphs: [
      ['The ladder starts with one markdown document.'],
      [
        'Every rung below the document is one envelope per unit of the level above it. Chunks become paragraphs, paragraphs become lines, and lines become words.',
        'A chunk never crosses a paragraph boundary, so the text of a paragraph always stays readable on its own.',
      ],
    ],
  },
  {
    number: 2,
    title: 'Ladder Chapter Two',
    paragraphs: [
      [
        'A second document shows that the ladder handles more than one chapter.',
        'Each chapter brings its own chunks, paragraphs, lines and words.',
      ],
    ],
  },
]

// Bigger chapter fixture for the series-split demo: several long paragraphs so
// the splitter has enough body text to partition into numbered series parts.
const SERIES_CHAPTER = `# The Long Road

The first part of the chapter introduces the road. It winds through hills and
valleys, and every mile brings a new view of the country ahead.

The second part follows the traveler. She walks at dawn, rests at noon, and
writes down what she saw before the light is gone.

The third part reaches the mountains. The air is thin, the path is steep, and
every paragraph here is longer so the series split has real work to do.

The last part comes home again. The road behind is longer than the road ahead,
and the chapter closes where it began, at the same quiet door.
`

async function main(): Promise<void> {
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'entities'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'chapters'), { recursive: true })
  const jsonlContent = `${RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
  const entityContent = `${ENTITY_RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), entityContent, 'utf-8')
  const ladderContent = `${LADDER_RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'ladder.jsonl'), ladderContent, 'utf-8')
  await writeFile(join(SAMPLE_DIR, 'chapters', 'chapter-series.md'), SERIES_CHAPTER, 'utf-8')
  console.log(
    'Wrote jsonl/input.jsonl, jsonl/entities.jsonl, jsonl/ladder.jsonl and chapters/chapter-series.md',
  )
}

main()
