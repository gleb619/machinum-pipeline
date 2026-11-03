import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../../server/standalone.js'

/**
 * T112: POST /api/runs/start must confine the pipeline path to the project root. A traversal or
 * absolute path outside the root is a 400, a missing file is a 404, and any other module load
 * error (e.g. a throw inside the pipeline module) is a 500 with the real message.
 */
describe('POST /api/runs/start confines the pipeline path to the project root', () => {
  let dir: string
  let outsideDir: string
  let previousCwd: string
  let handle: BackendHandle

  async function postStart(pipeline: string): Promise<Response> {
    return fetch(`${handle.url}/api/runs/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipeline }),
    })
  }

  beforeAll(async () => {
    // Under the vitest root so the runtime-written pipeline module stays resolvable
    dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'runs-start-confine.ignore.'))
    outsideDir = await mkdtemp(join(tmpdir(), 'mt-t112-outside.'))
    previousCwd = process.cwd()

    await writeFile(join(dir, 'mt.json'), JSON.stringify({ project: { name: 'confine-fixture' } }))
    await writeFile(join(dir, 'throws.mjs'), `throw new Error('boom on import')\n`)
    await writeFile(join(outsideDir, 'evil.mjs'), `export default { id: 'evil', steps: [] }\n`)

    process.chdir(dir)
    handle = await startBackend({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await handle?.close()
    process.chdir(previousCwd)
    await rm(dir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('rejects a relative path that traverses outside the project root (400)', async () => {
    const res = await postStart('../evil.mjs')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { statusMessage?: string }
    expect(body.statusMessage).toContain('outside project')
  })

  it('rejects an absolute path outside the project root (400)', async () => {
    const res = await postStart(join(outsideDir, 'evil.mjs'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { statusMessage?: string }
    expect(body.statusMessage).toContain('outside project')
  })

  it('returns 404 for a pipeline file that does not exist', async () => {
    const res = await postStart('missing.mjs')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { statusMessage?: string }
    expect(body.statusMessage).toContain('not found')
  })

  it('returns 500 with the real error message when the module throws on import', async () => {
    const res = await postStart('throws.mjs')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { statusMessage?: string }
    expect(body.statusMessage).toContain('boom on import')
  })
})
