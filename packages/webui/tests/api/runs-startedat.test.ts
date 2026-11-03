import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../../server/standalone.js'

describe('GET /api/runs reads startedAt', () => {
  let dir: string
  let previousCwd: string
  let handle: BackendHandle

  beforeAll(async () => {
    dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'runs-startedat.'))
    previousCwd = process.cwd()
    process.chdir(dir)
    await writeFile(
      join(dir, 'mt.json'),
      JSON.stringify({ project: { name: 'startedat-fixture' } }),
    )
    await rm(join(dir, '.mt'), { recursive: true, force: true }).catch(() => {})
    const stateDir = join(dir, '.mt', 'runs', 'run-1')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(stateDir, { recursive: true }))
    await writeFile(
      join(dir, '.mt', 'runs', 'run-1', 'state.json'),
      JSON.stringify({
        runId: 'run-1',
        pipelineId: 'p1',
        state: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T01:00:00.000Z',
        checkpoint: { stepId: 's1', state: 'done' },
        contextRef: '',
      }),
    )
    handle = await startBackend({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await handle?.close()
    process.chdir(previousCwd)
    await rm(dir, { recursive: true, force: true })
  })

  it('returns started equal to startedAt', async () => {
    const res = await fetch(`${handle.url}/api/runs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; started?: string }>
    const item = body.find((r) => r.id === 'run-1')
    expect(item).toBeDefined()
    expect(item?.started).toBe('2026-01-01T00:00:00.000Z')
  })
})
