import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../../server/standalone.js'

describe('SSE events tailing (T132)', () => {
  let dir: string
  let previousCwd: string
  let handle: BackendHandle

  beforeAll(async () => {
    previousCwd = process.cwd()
    dir = await mkdtemp(join(tmpdir(), 'mt-backend-t132-'))
    await mkdir(join(dir, '.mt', 'runs', 'ru-run'), { recursive: true })
    await writeFile(
      join(dir, '.mt', 'runs', 'ru-run', 'events.jsonl'),
      '{"type":"Глава 1 — начало"}\n{"type":"Глава 2 — продолжение"}\n',
    )
    process.chdir(dir)
    handle = await startBackend({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await handle.close()
    process.chdir(previousCwd)
    await rm(dir, { recursive: true, force: true })
  })

  it('delivers each Cyrillic event exactly once across ?stream=true polls after an append', async () => {
    const res = await fetch(`${handle.url}/api/runs/ru-run/events?stream=true`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    if (!res.body) throw new Error('response has no body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let received = ''
    const readUntil = async (needle: string) => {
      while (!received.includes(needle)) {
        const { done, value } = await reader.read()
        if (done) throw new Error(`stream closed before ${needle}`)
        received += decoder.decode(value, { stream: true })
      }
    }

    try {
      await readUntil('event: Глава 2 — продолжение')
      const beforeAppend = received

      await appendFile(
        join(dir, '.mt', 'runs', 'ru-run', 'events.jsonl'),
        '{"type":"Глава 3 — конец"}\n',
      )
      await readUntil('event: Глава 3 — конец')

      // Exactly-once: no event is re-sent by a later poll, despite multi-byte offsets
      for (const line of beforeAppend.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        expect(received.split(trimmed).length - 1).toBe(1)
      }
    } finally {
      await reader.cancel()
    }
  })

  it('replays a >64 KB event line intact', async () => {
    await mkdir(join(dir, '.mt', 'runs', 'big-run'), { recursive: true })
    const big = JSON.stringify({ type: 'big', text: 'ж'.repeat(100_000) })
    await writeFile(join(dir, '.mt', 'runs', 'big-run', 'events.jsonl'), `${big}\n`)

    const res = await fetch(`${handle.url}/api/runs/big-run/events`)
    expect(res.status).toBe(200)
    const body = await res.text()

    const dataLine = body
      .split('\n')
      .find((l) => l.startsWith('data: ') && l.includes('"type":"big"'))
    expect(dataLine).toBeDefined()
    const evt = JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as { text: string }
    expect(evt.text).toBe('ж'.repeat(100_000))
  })

  it('rejects run ids with path traversal on events, run detail, and items (400)', async () => {
    const encoded = '..%2F..%2Fescape'
    expect((await fetch(`${handle.url}/api/runs/${encoded}/events`)).status).toBe(400)
    expect((await fetch(`${handle.url}/api/runs/${encoded}`)).status).toBe(400)
    const items = await fetch(`${handle.url}/api/runs/${encoded}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    })
    expect(items.status).toBe(400)
  })
})
