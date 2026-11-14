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

  it('ends the stream immediately when replaying an already finished run', async () => {
    await mkdir(join(dir, '.mt', 'runs', 'done-run'), { recursive: true })
    await writeFile(
      join(dir, '.mt', 'runs', 'done-run', 'events.jsonl'),
      '{"type":"started"}\n{"type":"done"}\n',
    )

    const body = await (
      await fetch(`${handle.url}/api/runs/done-run/events?stream=true`, {
        signal: AbortSignal.timeout(3000),
      })
    ).text()

    expect(body).toContain('event: done')
    expect(body).toContain('event: end')
  })

  it('ends the stream when a done line is appended to a running log', async () => {
    // The shared ru-run log is still open; the append below terminates it.
    const eventsFile = join(dir, '.mt', 'runs', 'ru-run', 'events.jsonl')
    const started = Date.now()
    const res = await fetch(`${handle.url}/api/runs/ru-run/events?stream=true`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.body) throw new Error('response has no body')

    await appendFile(eventsFile, '{"type":"done"}\n')
    const body = await res.text()

    expect(body).toContain('event: done')
    expect(body).toContain('event: end')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('does not end the stream on a paused event', async () => {
    await mkdir(join(dir, '.mt', 'runs', 'paused-run'), { recursive: true })
    await writeFile(
      join(dir, '.mt', 'runs', 'paused-run', 'events.jsonl'),
      '{"type":"started"}\n{"type":"paused"}\n',
    )

    const res = await fetch(`${handle.url}/api/runs/paused-run/events?stream=true`)
    if (!res.body) throw new Error('response has no body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let received = ''
    try {
      while (!received.includes('event: paused')) {
        const { done, value } = await reader.read()
        if (done) throw new Error('stream closed on a paused event')
        received += decoder.decode(value, { stream: true })
      }
      const next = await Promise.race([
        reader.read(),
        new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 1200)),
      ])
      expect(next).toBe('open')
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

  it('resumes after Last-Event-ID without replaying earlier events', async () => {
    await mkdir(join(dir, '.mt', 'runs', 'resume-run'), { recursive: true })
    await writeFile(
      join(dir, '.mt', 'runs', 'resume-run', 'events.jsonl'),
      '{"type":"first"}\n{"type":"second"}\n',
    )

    const first = await (await fetch(`${handle.url}/api/runs/resume-run/events`)).text()
    const firstId = /^id: (\d+)$/m.exec(first)?.[1]
    expect(firstId).toBeDefined()
    expect(first).toContain('"type":"first"')

    const resumed = await (
      await fetch(`${handle.url}/api/runs/resume-run/events`, {
        headers: { 'Last-Event-ID': firstId ?? '0' },
      })
    ).text()
    expect(resumed).not.toContain('"type":"first"')
    expect(resumed).toContain('"type":"second"')
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
