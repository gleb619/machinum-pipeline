import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../../server/standalone.js'

interface Frame {
  path: string
  data?: Buffer
  op?: 'write' | 'delete'
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function encodeFrames(frames: readonly Frame[]): Uint8Array {
  const chunks: Buffer[] = []
  for (const frame of frames) {
    const body = frame.data ?? Buffer.alloc(0)
    const header = Buffer.from(
      JSON.stringify({
        path: frame.path,
        op: frame.op ?? 'write',
        size: body.length,
        sha256: frame.data === undefined ? undefined : sha256(body),
      }),
      'utf8',
    )
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(header.length, 0)
    chunks.push(length, header, body)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

async function putFrames(
  handle: BackendHandle,
  projectId: string,
  frames: readonly Frame[],
  token?: string,
): Promise<Response> {
  return fetch(`${handle.url}/api/sync/files?projectId=${projectId}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: encodeFrames(frames),
  })
}

async function manifest(
  handle: BackendHandle,
  projectId: string,
  scope = 'sources',
  runId?: string,
  token?: string,
): Promise<Array<{ path: string; size: number; sha256: string; mtime: number }>> {
  const params = new URLSearchParams({ projectId, scope })
  if (runId) params.set('runId', runId)
  const res = await fetch(`${handle.url}/api/sync/manifest?${params}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Array<{ path: string; size: number; sha256: string; mtime: number }>
}

async function getFile(
  handle: BackendHandle,
  projectId: string,
  path: string,
  scope = 'sources',
  runId?: string,
  token?: string,
): Promise<Response> {
  const params = new URLSearchParams({ projectId, path, scope })
  if (runId) params.set('runId', runId)
  return fetch(`${handle.url}/api/sync/files?${params}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
}

describe('sync API (T203)', () => {
  const previousToken = process.env.MT_SERVE_TOKEN
  let dir: string
  let handle: BackendHandle

  beforeAll(async () => {
    Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    dir = await mkdtemp(join(tmpdir(), 'mt-webui-sync-'))
    handle = await startBackend({ port: 0, host: '127.0.0.1', router: false, projectRoot: dir })
  })

  afterAll(async () => {
    await handle.close()
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    else process.env.MT_SERVE_TOKEN = previousToken
    await rm(dir, { recursive: true, force: true })
  })

  it('pushes frames, lists a manifest and serves files back', async () => {
    const data = Buffer.from('export default 1\n')
    const response = await putFrames(handle, 'proj-1', [
      { path: 'pipelines/a.ts', data },
      { path: 'mt.json', data: Buffer.from('{"project":{"name":"x"}}\n') },
    ])
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ written: 2, deleted: 0 })

    const entries = await manifest(handle, 'proj-1')
    expect(entries.map((entry) => entry.path)).toEqual(['mt.json', 'pipelines/a.ts'])
    expect(entries[1]?.sha256).toBe(sha256(data))

    const fetched = await getFile(handle, 'proj-1', 'pipelines/a.ts')
    expect(fetched.status).toBe(200)
    expect(Buffer.from(await fetched.arrayBuffer()).toString()).toBe(data.toString())
    expect(fetched.headers.get('x-mt-sync-sha256')).toBe(sha256(data))
  })

  it('prunes with a delete frame', async () => {
    const response = await putFrames(handle, 'proj-1', [{ path: 'pipelines/a.ts', op: 'delete' }])
    expect(response.status).toBe(200)
    expect((await response.json()) as { deleted: number }).toMatchObject({ deleted: 1 })
    expect((await manifest(handle, 'proj-1')).map((entry) => entry.path)).toEqual(['mt.json'])
  })

  it('rejects traversal, absolute paths, secrets and symlink escapes', async () => {
    for (const path of ['../escape.ts', '/etc/passwd', '.env', '.env.local', '.mt/vault.json']) {
      const response = await putFrames(handle, 'proj-2', [{ path, data: Buffer.from('x') }])
      expect(response.status).toBe(400)
    }

    const outside = await mkdtemp(join(tmpdir(), 'mt-webui-sync-outside-'))
    const mirror = join(dir, '.mt', 'remote', 'proj-3')
    await mkdir(mirror, { recursive: true })
    await symlink(outside, join(mirror, 'link'))
    const response = await putFrames(handle, 'proj-3', [
      { path: 'link/escape.ts', data: Buffer.from('x') },
    ])
    expect(response.status).toBe(400)
    await rm(outside, { recursive: true, force: true })
  })

  it('enforces the per-file cap from mt.json', async () => {
    const capDir = await mkdtemp(join(tmpdir(), 'mt-webui-sync-cap-'))
    await writeFile(
      join(capDir, 'mt.json'),
      JSON.stringify({ remote: { sync: { maxFileBytes: 4 } } }),
    )
    const capped = await startBackend({
      port: 0,
      host: '127.0.0.1',
      router: false,
      projectRoot: capDir,
    })
    try {
      const response = await putFrames(capped, 'cap-proj', [
        { path: 'big.txt', data: Buffer.from('12345') },
      ])
      expect(response.status).toBe(413)
      const ok = await putFrames(capped, 'cap-proj', [
        { path: 'small.txt', data: Buffer.from('1234') },
      ])
      expect(ok.status).toBe(200)
    } finally {
      await capped.close()
      await rm(capDir, { recursive: true, force: true })
    }
  })

  it('serves outputs scope including .mt/runs', async () => {
    const mirror = join(dir, '.mt', 'remote', 'proj-out')
    await mkdir(join(mirror, '.mt', 'runs', 'r1'), { recursive: true })
    await mkdir(join(mirror, 'out'), { recursive: true })
    await writeFile(join(mirror, '.mt', 'runs', 'r1', 'state.json'), '{"state":"done"}')
    await mkdir(join(mirror, 'pipelines'), { recursive: true })
    await writeFile(
      join(mirror, 'pipelines', 'main.ts'),
      'export default { to: \'.to("md://./out")\' }\n',
    )
    await writeFile(join(mirror, 'out', 'result.md'), '# done\n')

    const entries = await manifest(handle, 'proj-out', 'outputs', 'r1')
    expect(entries.map((entry) => entry.path)).toEqual(['.mt/runs/r1/state.json', 'out/result.md'])
    expect(
      (await getFile(handle, 'proj-out', '.mt/runs/r1/state.json', 'outputs', 'r1')).status,
    ).toBe(200)
    expect((await getFile(handle, 'proj-out', '.mt/runs/r1/state.json', 'sources')).status).toBe(
      400,
    )
  })
})

describe('sync auth (T203 + T202)', () => {
  const TOKEN = 'sync-token-secret'
  const previousToken = process.env.MT_SERVE_TOKEN
  let dir: string
  let handle: BackendHandle

  beforeAll(async () => {
    Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    dir = await mkdtemp(join(tmpdir(), 'mt-webui-sync-auth-'))
    handle = await startBackend({
      port: 0,
      host: '127.0.0.1',
      router: false,
      projectRoot: dir,
      token: TOKEN,
    })
  })

  afterAll(async () => {
    await handle.close()
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    else process.env.MT_SERVE_TOKEN = previousToken
    await rm(dir, { recursive: true, force: true })
  })

  it('requires the bearer token for sync routes', async () => {
    expect((await fetch(`${handle.url}/api/sync/manifest?projectId=p`)).status).toBe(401)
    expect((await putFrames(handle, 'p', [{ path: 'x.txt', data: Buffer.from('x') }])).status).toBe(
      401,
    )
    expect((await manifest(handle, 'p', 'sources', undefined, TOKEN)).length).toBe(0)
    expect(
      (await putFrames(handle, 'p', [{ path: 'x.txt', data: Buffer.from('x') }], TOKEN)).status,
    ).toBe(200)
    expect((await manifest(handle, 'p', 'sources', undefined, TOKEN))[0]?.path).toBe('x.txt')
  })

  it('keeps health minimal without auth and extended with auth', async () => {
    expect(await (await fetch(`${handle.url}/api/health`)).json()).toEqual({ status: 'ok' })
    const authed = await fetch(`${handle.url}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(await authed.json()).toMatchObject({ status: 'ok', version: '0.1.0', syncVersion: 1 })
  })
})
