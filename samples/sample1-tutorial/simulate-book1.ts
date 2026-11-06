import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Client of the HTTP source of pipe02. While
 * `mt run ./pipelines/pipe02-waypoints.ts --pipeline httpIngestPipeline` waits for POSTs,
 * this script posts the first three chapters of `books/book1`.
 *
 *   pnpm run simulate
 */
const BASE_URL = process.env.MT_HTTP_URL ?? 'http://localhost:9877'
const BOOK_DIR = join(import.meta.dirname, '..', '..', 'books', 'book1')
const FILES = ['chapter-1.en.md', 'chapter-2.en.md', 'chapter-3.en.md']

function titleOf(markdown: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? 'Untitled'
}

async function send(file: string): Promise<boolean> {
  const content = readFileSync(join(BOOK_DIR, file), 'utf-8')
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      title: titleOf(content),
      body: content,
      lang: 'en',
      sourceFile: file,
    }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    console.error(`${file}: HTTP ${response.status}`)
    return false
  }
  console.log(`${file}: sent`)
  return true
}

let sent = 0
for (const file of FILES) {
  if (await send(file)) sent += 1
}
console.log(`${sent}/${FILES.length} chapter(s) posted to ${BASE_URL}`)
process.exit(sent === FILES.length ? 0 : 1)
