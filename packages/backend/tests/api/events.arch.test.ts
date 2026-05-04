import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('UC-29 - SSE event streaming (architectural)', () => {
  const eventsPath = join(
    __dirname,
    '..',
    '..',
    'server',
    'routes',
    'api',
    'runs',
    '[id]',
    'events.ts',
  )

  it('exists and exports default defineEventHandler', async () => {
    const source = await readFile(eventsPath, 'utf-8')
    expect(source).toMatch(/export default defineEventHandler/)
  })

  it('sets Content-Type: text/event-stream header', async () => {
    const source = await readFile(eventsPath, 'utf-8')
    expect(source).toMatch(/Content-Type.*text\/event-stream/)
  })

  it('sets Cache-Control: no-cache header', async () => {
    const source = await readFile(eventsPath, 'utf-8')
    expect(source).toMatch(/Cache-Control.*no-cache/)
  })

  it('sets Connection: keep-alive header', async () => {
    const source = await readFile(eventsPath, 'utf-8')
    expect(source).toMatch(/Connection.*keep-alive/)
  })

  it('reads from events.jsonl file', async () => {
    const source = await readFile(eventsPath, 'utf-8')
    expect(source).toMatch(/events\.jsonl/)
  })

  it('uses SSE framing with event: and data: prefix', async () => {
    const source = await readFile(eventsPath, 'utf-8')
    expect(source).toMatch(/event:/)
    expect(source).toMatch(/data:/)
  })

  it('uses createReadStream for file reading', async () => {
    const source = await readFile(eventsPath, 'utf-8')
    expect(source).toMatch(/createReadStream/)
  })

  it('uses getRouterParam for id parameter', async () => {
    const source = await readFile(eventsPath, 'utf-8')
    expect(source).toMatch(/getRouterParam/)
  })
})
