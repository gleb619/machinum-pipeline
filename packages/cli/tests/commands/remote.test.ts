import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BackendHandle, startBackend } from '@mt/webui/standalone'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseRemoteArgs, remoteCommand } from '../../src/commands/remote.js'
import {
  SyncConflictError,
  resolveRemoteConfig,
  resolveRemoteToken,
  syncProjectPull,
  syncProjectPush,
} from '../../src/utils/remote-client.js'

async function writeProject(root: string, url: string, projectId: string): Promise<void> {
  await mkdir(join(root, 'pipelines'), { recursive: true })
  await mkdir(join(root, 'lib'), { recursive: true })
  await mkdir(join(root, 'input'), { recursive: true })
  await writeFile(
    join(root, 'mt.json'),
    `${JSON.stringify(
      {
        project: { name: 'cli-sync-fixture' },
        pipelines: ['./pipelines/main.ts'],
        remote: { url, projectId },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(root, 'pipelines', 'main.ts'),
    [
      "import { helper } from '../lib/helper.js'",
      'export default { from: \'.from("jsonl://./input/ch1.jsonl")\', to: \'.to("md://./out")\' }',
      'void helper',
    ].join('\n'),
  )
  await writeFile(join(root, 'lib', 'helper.ts'), 'export const helper = 1\n')
  await writeFile(join(root, 'input', 'ch1.jsonl'), '{"item":"hello"}\n')
  await writeFile(join(root, '.env'), 'SECRET=nope\n')
}

describe('mt remote sync (T203)', () => {
  const previousToken = process.env.MT_SERVE_TOKEN
  const projectId = 'cli-sync-project'
  let local: string
  let remoteRoot: string
  let remote: BackendHandle
  let localServer: BackendHandle

  beforeAll(async () => {
    Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    local = await mkdtemp(join(tmpdir(), 'mt-cli-sync-local-'))
    remoteRoot = await mkdtemp(join(tmpdir(), 'mt-cli-sync-remote-'))
    remote = await startBackend({
      port: 0,
      host: '127.0.0.1',
      router: false,
      projectRoot: remoteRoot,
    })
    localServer = await startBackend({
      port: 0,
      host: '127.0.0.1',
      router: false,
      projectRoot: local,
    })
    await writeProject(local, remote.url, projectId)
  })

  afterAll(async () => {
    await remote.close()
    await localServer.close()
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    else process.env.MT_SERVE_TOKEN = previousToken
    await rm(local, { recursive: true, force: true })
    await rm(remoteRoot, { recursive: true, force: true })
  })

  it('round-trips push and output pull through two in-process servers', async () => {
    const config = await resolveRemoteConfig(local)
    expect(config).toMatchObject({
      url: remote.url,
      projectId,
      mode: 'http',
      maxFileBytes: 20 * 1024 * 1024,
    })

    const pushed = await syncProjectPush({
      root: local,
      url: config.url,
      token: config.token,
      projectId: config.projectId,
    })
    expect(pushed.transferred).toBeGreaterThan(0)
    expect(pushed.dryRun).toBe(false)

    const mirror = join(remoteRoot, '.mt', 'remote', projectId)
    expect(await readFile(join(mirror, 'pipelines', 'main.ts'), 'utf8')).toContain('helper')
    expect(await readFile(join(mirror, 'lib', 'helper.ts'), 'utf8')).toContain('helper')
    await expect(readFile(join(mirror, '.env'), 'utf8')).rejects.toThrow()
    expect(
      await readFile(join(local, '.mt', 'remote', `${projectId}.sync.json`), 'utf8'),
    ).toContain('pipelines/main.ts')

    // Simulate a completed remote run, then pull its outputs back over the HTTP API.
    await mkdir(join(mirror, '.mt', 'runs', 'r1'), { recursive: true })
    await mkdir(join(mirror, 'out'), { recursive: true })
    await writeFile(join(mirror, '.mt', 'runs', 'r1', 'state.json'), '{"state":"done"}\n')
    await writeFile(join(mirror, 'out', 'ch1.md'), '# translated\n')
    const pulled = await syncProjectPull({
      root: local,
      url: config.url,
      token: config.token,
      projectId: config.projectId,
      runId: 'r1',
    })
    expect(pulled.transferred).toBe(2)
    expect(await readFile(join(local, '.mt', 'runs', 'r1', 'state.json'), 'utf8')).toContain('done')
    expect(await readFile(join(local, 'out', 'ch1.md'), 'utf8')).toContain('translated')
  })

  it('prints a dry-run diff without changing the remote', async () => {
    await writeFile(
      join(local, 'pipelines', 'main.ts'),
      [
        "import { helper } from '../lib/helper.js'",
        'export default { from: \'.from("jsonl://./input/ch1.jsonl")\', to: \'.to("md://./out")\' }',
        'void helper // changed',
      ].join('\n'),
    )
    const before = await readFile(
      join(remoteRoot, '.mt', 'remote', projectId, 'pipelines', 'main.ts'),
      'utf8',
    )
    const result = await syncProjectPush({
      root: local,
      url: remote.url,
      projectId,
      dryRun: true,
    })
    expect(result.changed).toContain('pipelines/main.ts')
    expect(
      await readFile(join(remoteRoot, '.mt', 'remote', projectId, 'pipelines', 'main.ts'), 'utf8'),
    ).toBe(before)
  })

  it('refuses a both-changed file unless --force is used', async () => {
    const mirrorFile = join(remoteRoot, '.mt', 'remote', projectId, 'pipelines', 'main.ts')
    await writeFile(mirrorFile, 'remote change\n')
    await writeFile(
      join(local, 'pipelines', 'main.ts'),
      [
        "import { helper } from '../lib/helper.js'",
        'export default { from: \'.from("jsonl://./input/ch1.jsonl")\', to: \'.to("md://./out")\' }',
        'void helper // local change',
      ].join('\n'),
    )
    await expect(
      syncProjectPush({ root: local, url: remote.url, projectId }),
    ).rejects.toBeInstanceOf(SyncConflictError)

    await syncProjectPush({ root: local, url: remote.url, projectId, force: true })
    expect(await readFile(mirrorFile, 'utf8')).toContain('local change')
  })

  it('prunes removed files only when requested', async () => {
    await rm(join(local, 'lib', 'helper.ts'))
    const dry = await syncProjectPush({ root: local, url: remote.url, projectId, dryRun: true })
    expect(dry.removed).toContain('lib/helper.ts')
    await syncProjectPush({ root: local, url: remote.url, projectId, prune: true, force: true })
    await expect(
      readFile(join(remoteRoot, '.mt', 'remote', projectId, 'lib', 'helper.ts'), 'utf8'),
    ).rejects.toThrow()
  })

  it('parses flags and runs the CLI command from cwd', async () => {
    expect(parseRemoteArgs(['--pull', '--dry-run', '--run', 'r1'])).toMatchObject({
      direction: 'pull',
      dryRun: true,
      runId: 'r1',
    })
    expect(() => parseRemoteArgs(['--push', '--pull'])).toThrow(/mutually exclusive/)
    expect(() => parseRemoteArgs(['--watch', '--pull'])).toThrow(/--watch/)

    const original = process.cwd()
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      process.chdir(local)
      await remoteCommand(['sync', '--dry-run'])
      expect(spy.mock.calls.some((call) => String(call[0]).includes('remote sync complete'))).toBe(
        true,
      )
    } finally {
      process.chdir(original)
      spy.mockRestore()
    }
  })

  it('resolves a token from an env ref without printing it', async () => {
    process.env.MT_TEST_REMOTE_TOKEN = 'secret-token'
    try {
      expect(await resolveRemoteToken('env:MT_TEST_REMOTE_TOKEN')).toBe('secret-token')
      expect(await resolveRemoteToken('MT_TEST_REMOTE_TOKEN')).toBe('secret-token')
      await expect(resolveRemoteToken('env:MISSING_REMOTE_TOKEN')).rejects.toThrow(/MISSING/)
    } finally {
      process.env.MT_TEST_REMOTE_TOKEN = undefined
    }
  })
})
