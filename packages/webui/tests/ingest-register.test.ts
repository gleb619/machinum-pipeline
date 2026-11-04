import { spawn } from 'node:child_process'
import { type Server, createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../server/standalone.js'

async function until(label: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('cross-process ingest registration', () => {
  let handle: BackendHandle

  beforeAll(async () => {
    handle = await startBackend({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await handle.close()
  })

  it('registers a loopback target and forwards POST bodies to it', async () => {
    const received: string[] = []
    const target: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(202, { 'Content-Type': 'application/json', 'Retry-After': '3' })
        res.end(JSON.stringify({ accepted: true }))
      })
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()))
    const targetPort = (target.address() as { port: number }).port

    try {
      const registered = await fetch(`${handle.url}/api/ingest/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/remote-ingest',
          runId: 'run-1',
          targetUrl: `http://127.0.0.1:${targetPort}/forwarded`,
        }),
      })
      expect(registered.status).toBe(200)

      const forwarded = await fetch(`${handle.url}/remote-ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 7 }),
      })
      expect(forwarded.status).toBe(202)
      expect(forwarded.headers.get('retry-after')).toBe('3')
      expect(await forwarded.json()).toEqual({ accepted: true })
      expect(received).toEqual([JSON.stringify({ id: 7 })])

      const removed = await fetch(`${handle.url}/api/ingest/register`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/remote-ingest' }),
      })
      expect(await removed.json()).toEqual({ removed: true })
      expect(
        (await fetch(`${handle.url}/remote-ingest`, { method: 'POST', body: '{}' })).status,
      ).toBe(404)
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })

  it('rejects non-loopback forward targets', async () => {
    const response = await fetch(`${handle.url}/api/ingest/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/remote-ingest',
        runId: 'run-2',
        targetUrl: 'http://example.com/ingest',
      }),
    })
    expect(response.status).toBe(400)
  })

  it('forwards to a spawned child source in MT_INGEST_PARENT mode', async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ingest-child.ts')
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      env: {
        ...process.env,
        MT_INGEST_PARENT: handle.url,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    try {
      let posted = false
      await until('the child to register its ingest path', async () => {
        if (posted) return true
        const response = await fetch(`${handle.url}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 42 }),
        })
        if (response.status === 200) posted = true
        return posted
      })

      await until('the child to print the delivered item', async () => stdout.includes('ITEM'))
      expect(stdout).toContain('ITEM {"id":42}')
      expect(stderr.trim()).toBe('')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    } finally {
      if (child.exitCode === null) child.kill()
    }
  })
})
