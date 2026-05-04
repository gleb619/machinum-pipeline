import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE_URL = process.env.MT_HTTP_URL || 'http://localhost:9876'
const TIMEOUT_MS = 5000

const BOOK_DIR = join(import.meta.dirname, '..', '..', 'books', 'book1')

const files: string[] = [
  'chapter-1.en.md',
  'chapter-2.en.md',
  'chapter-3.en.md',
]

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : 'Untitled'
}

async function sendFile(file: string): Promise<boolean> {
  const filePath = join(BOOK_DIR, file)
  let content: string

  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error(`Failed to read ${file}:`, (err as Error).message)
    return false
  }

  const payload = {
    title: extractTitle(content),
    body: content,
    lang: 'en',
    sourceFile: file,
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (response.ok) {
      console.log(`${file} sent successfully (status: ${response.status})`)
      return true
    } else {
      console.error(`${file} failed with status: ${response.status}`)
      return false
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.error(`${file} timed out after ${TIMEOUT_MS}ms`)
    } else {
      console.error(`${file} error:`, (err as Error).message)
    }
    return false
  }
}

async function run(): Promise<void> {
  console.log(`Starting upload of ${files.length} files to ${BASE_URL}...\n`)

  let successCount = 0
  for (const file of files) {
    if (await sendFile(file)) {
      successCount++
    }
    console.log('---\n')
  }

  console.log(`All requests completed. ${successCount}/${files.length} succeeded.`)
  process.exit(successCount === files.length ? 0 : 1)
}

run().catch((err: unknown) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
