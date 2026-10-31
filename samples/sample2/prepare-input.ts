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

async function main(): Promise<void> {
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  await mkdir(join(SAMPLE_DIR, 'entities'), { recursive: true })
  const jsonlContent = `${RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
  const entityContent = `${ENTITY_RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'entities.jsonl'), entityContent, 'utf-8')
  console.log('Wrote jsonl/input.jsonl and jsonl/entities.jsonl')
}

main()
