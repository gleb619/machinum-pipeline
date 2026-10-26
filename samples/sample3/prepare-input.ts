import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SAMPLE_DIR = import.meta.dirname
const RECORDS = [
  { id: 1, text: 'First line of the document.' },
  { id: 2, text: 'Second line of the document.' },
  { id: 3, text: 'Third line of the document.' },
]

async function main(): Promise<void> {
  await mkdir(join(SAMPLE_DIR, 'jsonl'), { recursive: true })
  const jsonlContent = `${RECORDS.map((record) => JSON.stringify({ item: record })).join('\n')}\n`
  await writeFile(join(SAMPLE_DIR, 'jsonl', 'input.jsonl'), jsonlContent, 'utf-8')
  console.log('Wrote jsonl/input.jsonl')
}

main()
