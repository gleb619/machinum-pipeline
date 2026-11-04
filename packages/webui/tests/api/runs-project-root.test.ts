import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../../server/standalone.js'

async function writeSlowPipeline(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(
    path,
    `const slow = {
  name: 'slow-fixture',
  version: '1.0.0',
  async invoke(ex) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return ex
  },
}
export default {
  id: 'remote-root-fixture',
  retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
  onError: 'fail-run',
  steps: [
    {
      type: 'source',
      config: {
        uri: 'probe://one',
        instance: {
          uri: 'probe://one',
          lifestyle: 'resumable',
          async *start() {
            yield { item: 'one', meta: {} }
          },
        },
      },
    },
    { type: 'tool', config: { name: slow.name, version: slow.version, tool: slow } },
    {
      type: 'target',
      config: {
        uri: 'mem://out',
        instance: {
          uri: 'mem://out',
          async open() {},
          async write() {},
          async close() {},
        },
      },
    },
  ],
}
`,
  )
}

async function postStart(handle: BackendHandle, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${handle.url}/api/runs/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/runs/start projectId mirror root', () => {
  const projectId = 'remote-project'
  let root: string
  let handle: BackendHandle

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-webui-project-root-'))
    await writeFile(join(root, 'mt.json'), JSON.stringify({ project: { name: 'serve-root' } }))
    await writeSlowPipeline(join(root, '.mt', 'remote', projectId, 'pipelines', 'remote.mjs'))
    handle = await startBackend({ port: 0, host: '127.0.0.1', router: false, projectRoot: root })
  })

  afterAll(async () => {
    await handle.close()
    await rm(root, { recursive: true, force: true })
  })

  it('runs a pipeline inside .mt/remote/<projectId> and writes run state there', async () => {
    const response = await postStart(handle, {
      projectId,
      pipeline: 'pipelines/remote.mjs',
    })
    expect(response.status).toBe(200)
    const { runId } = (await response.json()) as { runId: string }

    const statePath = join(root, '.mt', 'remote', projectId, '.mt', 'runs', runId, 'state.json')
    await vi.waitFor(async () => {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as { state: string }
      expect(state.state).toBe('done')
    })
  })

  it('rejects project traversal and pipeline traversal', async () => {
    expect(
      (
        await postStart(handle, {
          projectId: '../escape',
          pipeline: 'pipelines/remote.mjs',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await postStart(handle, {
          projectId: 'other-project',
          pipeline: '../../../../escape.mjs',
        })
      ).status,
    ).toBe(400)
  })

  it('returns 409 when the project already has an active run', async () => {
    const activeProject = 'busy-project'
    await writeSlowPipeline(join(root, '.mt', 'remote', activeProject, 'pipelines', 'remote.mjs'))
    const first = await postStart(handle, {
      projectId: activeProject,
      pipeline: 'pipelines/remote.mjs',
    })
    expect(first.status).toBe(200)
    const second = await postStart(handle, {
      projectId: activeProject,
      pipeline: 'pipelines/remote.mjs',
    })
    expect(second.status).toBe(409)
    const { runId } = (await first.json()) as { runId: string }
    await vi.waitFor(async () => {
      const state = JSON.parse(
        await readFile(
          join(root, '.mt', 'remote', activeProject, '.mt', 'runs', runId, 'state.json'),
          'utf8',
        ),
      ) as { state: string }
      expect(state.state).toBe('done')
    })
  })
})

describe('GET /api/runs/:id/artifacts', () => {
  const projectId = 'artifact-project'
  let root: string
  let handle: BackendHandle

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-webui-artifacts-'))
    const mirror = join(root, '.mt', 'remote', projectId)
    await mkdir(join(mirror, 'pipelines'), { recursive: true })
    await mkdir(join(mirror, '.mt', 'runs', 'run-artifact'), { recursive: true })
    await mkdir(join(mirror, 'out'), { recursive: true })
    await writeFile(
      join(mirror, 'pipelines', 'main.mjs'),
      "export default { id: 'out', steps: [], to: '.to(\"md://./out\")' }\n",
    )
    await writeFile(
      join(mirror, '.mt', 'runs', 'run-artifact', 'state.json'),
      JSON.stringify({ runId: 'run-artifact', state: 'done' }),
    )
    await writeFile(join(mirror, 'out', 'result.md'), '# result\n')
    handle = await startBackend({ port: 0, host: '127.0.0.1', router: false, projectRoot: root })
  })

  afterAll(async () => {
    await handle.close()
    await rm(root, { recursive: true, force: true })
  })

  it('returns the T203 output manifest for the mirrored run', async () => {
    const response = await fetch(
      `${handle.url}/api/runs/run-artifact/artifacts?projectId=${projectId}`,
    )
    expect(response.status).toBe(200)
    const entries = (await response.json()) as Array<{ path: string; sha256: string }>
    expect(entries.map((entry) => entry.path)).toEqual([
      '.mt/runs/run-artifact/state.json',
      'out/result.md',
    ])
    expect(entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true)
  })

  it('rejects invalid run ids and project ids', async () => {
    expect((await fetch(`${handle.url}/api/runs/..%2Fescape/artifacts`)).status).toBe(400)
    expect(
      (await fetch(`${handle.url}/api/runs/run-artifact/artifacts?projectId=..%2Fescape`)).status,
    ).toBe(400)
  })
})
