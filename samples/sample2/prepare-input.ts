import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SAMPLE_DIR = import.meta.dirname
const RECORDS = [
  { id: 1, text: 'First line of the document.' },
  { id: 2, text: 'Second line of the document.' },
  { id: 3, text: 'Third line of the document.' },
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

async function main(): Promise<void> {
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'entities'), { recursive: true })
  const jsonlContent = `${RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
  const entityContent = `${ENTITY_RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), entityContent, 'utf-8')
  const ladderContent = `${LADDER_RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'ladder.jsonl'), ladderContent, 'utf-8')
  console.log('Wrote jsonl/input.jsonl, jsonl/entities.jsonl and jsonl/ladder.jsonl')
}

main()
