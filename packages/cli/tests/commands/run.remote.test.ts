import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '@mt/waypoint'
import { type BackendHandle, startBackend } from '@mt/webui/standalone'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resumeCommand } from '../../src/commands/resume.js'
import { runCommand } from '../../src/commands/run.js'

const projectId = 'cli-remote-run'

function pipelineModule(id: string, mode: 'success' | 'failed' | 'slow'): string {
  const delay = mode === 'slow' ? 500 : 10
  const invoke =
    mode === 'failed'
      ? "throw new Error('remote boom')"
      : `await new Promise((resolve) => setTimeout(resolve, ${delay})); return ex`
  const count = mode === 'slow' ? 4 : 2
  const slowSecondStep =
    mode === 'slow'
      ? "    { type: 'tool', config: { name: 'second-tool', version: '1.0.0', tool, concurrency: '1' } },\n"
      : ''
  return `const tool = {
  name: 'fixture-tool',
  version: '1.0.0',
  async invoke(ex) {
    ${invoke}
  },
}
const outputMarker = '.to("jsonl://./${id}.jsonl")'
void outputMarker
export default {
  id: '${id}',
  retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
  onError: 'fail-run',
  steps: [
    { type: 'source', config: { uri: 'range://1..${count}' } },
    { type: 'tool', config: { name: tool.name, version: tool.version, tool, concurrency: '1' } },
${slowSecondStep}    { type: 'target', config: { uri: 'jsonl://./${id}.jsonl' } },
  ],
}
`
}

async function writeProject(root: string, url: string): Promise<void> {
  await mkdir(join(root, 'pipelines'), { recursive: true })
  await writeFile(
    join(root, 'mt.json'),
    `${JSON.stringify(
      {
        project: { name: 'cli-remote-run' },
        pipelines: ['./pipelines/success.mjs'],
        remote: { url, projectId },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(root, 'pipelines', 'success.mjs'),
    pipelineModule('remote-success', 'success'),
  )
  await writeFile(join(root, 'pipelines', 'failed.mjs'), pipelineModule('remote-failed', 'failed'))
  await writeFile(join(root, 'pipelines', 'slow.mjs'), pipelineModule('remote-slow', 'slow'))
}

function outputText(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((line) => String(line))
    .join('\n')
}

function clearOutput(): void {
  vi.mocked(console.log).mockClear()
  vi.mocked(console.error).mockClear()
}

async function waitForRunId(timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = /Remote run started: ([A-Za-z0-9-]+)/.exec(outputText())
    if (match?.[1] !== undefined) return match[1]
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for remote run id')
}

async function waitForState(runId: string, wanted: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(
        join(remoteRoot, '.mt', 'remote', projectId, '.mt', 'runs', runId, 'state.json'),
        'utf8',
      )
      if ((JSON.parse(raw) as { state?: string }).state === wanted) return
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for run state ${wanted}`)
}

let local: string
let remoteRoot: string
let server: BackendHandle
let originalCwd: string
const previousArtifactInterval = process.env.MT_REMOTE_ARTIFACT_INTERVAL_MS

beforeAll(async () => {
  originalCwd = process.cwd()
  local = await mkdtemp(join(tmpdir(), 'mt-cli-remote-local-'))
  remoteRoot = await mkdtemp(join(tmpdir(), 'mt-cli-remote-server-'))
  server = await startBackend({
    port: 0,
    host: '127.0.0.1',
    router: false,
    projectRoot: remoteRoot,
  })
  await writeProject(local, server.url)
  process.env.MT_REMOTE_ARTIFACT_INTERVAL_MS = '50'
  process.chdir(local)
})

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  clearOutput()
})

afterAll(async () => {
  process.chdir(originalCwd)
  if (previousArtifactInterval === undefined) {
    Reflect.deleteProperty(process.env, 'MT_REMOTE_ARTIFACT_INTERVAL_MS')
  } else {
    process.env.MT_REMOTE_ARTIFACT_INTERVAL_MS = previousArtifactInterval
  }
  await server.close()
  await rm(local, { recursive: true, force: true })
  await rm(remoteRoot, { recursive: true, force: true })
})

describe('mt run --remote (T204)', () => {
  it('pushes, starts, streams SSE and pulls run artifacts back', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT ${String(code)}`)
    })
    await runCommand(['pipelines/success.mjs', '--remote', server.url])

    const text = outputText()
    expect(text).toContain('Remote run complete')
    expect(text).toContain('Resume: mt resume ')
    expect(text).toContain(`--remote ${server.url}`)
    const runId = await waitForRunId()
    expect(exit).not.toHaveBeenCalled()

    const localState = JSON.parse(
      await readFile(join(local, '.mt', 'runs', runId, 'state.json'), 'utf8'),
    ) as { state: string }
    expect(localState.state).toBe('done')
    const output = await readFile(join(local, 'remote-success.jsonl'), 'utf8')
    expect(output).toContain('"value":1')
    expect(output).toContain('"value":2')
  })

  it('exits 1 when the remote run fails', async () => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT ${String(code)}`)
    })
    await expect(runCommand(['pipelines/failed.mjs', '--remote', server.url])).rejects.toThrow(
      'EXIT 1',
    )
    expect(outputText()).toContain('Remote run failed: remote boom')
  })

  it('pauses remotely and resume --remote re-attaches to finish', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT ${String(code)}`)
    })
    const running = runCommand(['pipelines/slow.mjs', '--remote', server.url])
    const runId = await waitForRunId()
    await waitForState(runId, 'running')

    const paused = await fetch(`${server.url}/api/runs/${runId}/pause`, { method: 'POST' })
    expect(paused.status).toBe(200)
    await running
    await waitForState(runId, 'paused')

    // Force a replay from offset 0: the historical `paused` event must not be
    // mistaken for a second pause after the resume request.
    await rm(join(local, '.mt', 'runs', runId), { recursive: true, force: true })

    await resumeCommand([runId, '--remote', server.url])
    await waitForState(runId, 'done')
    expect(exit).not.toHaveBeenCalled()
    const state = JSON.parse(
      await readFile(join(local, '.mt', 'runs', runId, 'state.json'), 'utf8'),
    ) as { state: string }
    expect(state.state).toBe('done')
  }, 15_000)

  it('turns the first Ctrl+C into a remote pause', async () => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT ${String(code)}`)
    })
    const running = runCommand(['pipelines/slow.mjs', '--remote', server.url])
    const runId = await waitForRunId()
    await waitForState(runId, 'running')

    const listeners = process.listeners('SIGINT')
    const listener = listeners.at(-1)
    if (!listener) throw new Error('SIGINT listener missing')
    await expect(listener('SIGINT')).rejects.toThrow('EXIT 0')
    await running
    await waitForState(runId, 'paused')
    process.removeListener('SIGINT', listener)
  }, 15_000)
})
