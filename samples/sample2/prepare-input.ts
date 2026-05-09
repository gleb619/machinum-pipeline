import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BOOK_DIR = join(import.meta.dirname, '..', '..', 'books', 'book1')
const OUTPUT_DIR = join(import.meta.dirname, 'jsonl')
const OUTPUT_FILE = join(OUTPUT_DIR, 'input.jsonl')

const files = ['chapter-1.en.md', 'chapter-2.en.md', 'chapter-3.en.md']

mkdirSync(OUTPUT_DIR, { recursive: true })

const lines: string[] = []
for (const file of files) {
  const content = readFileSync(join(BOOK_DIR, file), 'utf8')
  const titleMatch = content.match(/^#\s+(.+)$/m)
  const title = titleMatch ? titleMatch[1].trim() : file
  const envelope = JSON.stringify({ item: { title, body: content, sourceFile: file }, meta: {} })
  lines.push(envelope)
}

writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n')
console.log(`Wrote ${lines.length} chapters to ${OUTPUT_FILE}`)
