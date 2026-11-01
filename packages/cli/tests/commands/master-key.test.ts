import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmbedStore, getEmbedSecret, resetEmbedCache, setEmbedSecret } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureProjectMasterKey, generateMasterKeyFile } from '../../src/commands/master-key.js'
import { vaultCommand } from '../../src/commands/vault.js'

describe('master-key command', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let projectKey: string
  const saved: Record<string, string | undefined> = {}
  const KEYS = [
    'MT_HOME',
    'MT_PROJECT_ROOT',
    'MT_EMBED_PATH',
    'MT_EMBED_PASSWORD',
    'MT_EMBED_PASSWORD_FILE',
  ]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-mk-cli-'))
    for (const key of KEYS) {
      saved[key] = process.env[key]
      Reflect.deleteProperty(process.env, key)
    }
    await mkdir(join(dir, 'project'), { recursive: true })
    await mkdir(join(dir, 'home'), { recursive: true })
    projectKey = join(dir, 'project', '.mt', 'master.key')
    env = {
      MT_PROJECT_ROOT: join(dir, 'project'),
      MT_HOME: join(dir, 'home'),
      MT_EMBED_PATH: join(dir, 'store.json'),
    }
    Object.assign(process.env, env)
    resetEmbedCache()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    vi.restoreAllMocks()
    resetEmbedCache()
    await rm(dir, { recursive: true, force: true })
  })

  it('generates the project key (0600) and refuses to overwrite it', async () => {
    const result = await generateMasterKeyFile({}, env)
    expect(result.path).toBe(projectKey)
    expect((await stat(projectKey)).mode & 0o777).toBe(0o600)
    const before = await readFile(projectKey, 'utf-8')
    await expect(generateMasterKeyFile({}, env)).rejects.toThrow('refusing to overwrite')
    expect(await readFile(projectKey, 'utf-8')).toBe(before)
  })

  it('--user targets the user key; --path targets a custom file', async () => {
    expect((await generateMasterKeyFile({ user: true }, env)).path).toBe(
      join(dir, 'home', 'master.key'),
    )
    const custom = join(dir, 'custom.key')
    expect((await generateMasterKeyFile({ path: custom }, env)).path).toBe(custom)
  })

  it('refuses when a store exists unless --rekey or --force', async () => {
    await createEmbedStore({ path: env.MT_EMBED_PATH }, env)
    await expect(generateMasterKeyFile({}, env)).rejects.toThrow('--rekey')
    await expect(readFile(projectKey)).rejects.toThrow()
  })

  it('--rekey re-wraps an existing default-sealed store under the new key', async () => {
    await createEmbedStore({ path: env.MT_EMBED_PATH }, env)
    await setEmbedSecret({ name: 'K', secret: 'sk-keep' }, {}, env)
    resetEmbedCache()
    const result = await generateMasterKeyFile({ rekey: true }, env)
    expect(result.rekeyed).toBe(1)
    resetEmbedCache()
    expect((await getEmbedSecret('K', env)).secret).toBe('sk-keep')
    // really sealed under the file: another project root (default password) cannot open it
    resetEmbedCache()
    await expect(
      getEmbedSecret('K', { ...env, MT_PROJECT_ROOT: join(dir, 'other') }),
    ).rejects.toThrow('wrong master password')
  })

  it('--rekey rolls the key file back when re-keying fails', async () => {
    await createEmbedStore({ path: env.MT_EMBED_PATH, password: 'unknown-pw' }, env)
    await expect(generateMasterKeyFile({ rekey: true }, env)).rejects.toThrow()
    await expect(readFile(projectKey)).rejects.toThrow()
  })

  it('--force overwrites an existing key file', async () => {
    await generateMasterKeyFile({}, env)
    const before = await readFile(projectKey, 'utf-8')
    await generateMasterKeyFile({ force: true }, env)
    expect(await readFile(projectKey, 'utf-8')).not.toBe(before)
  })

  it('status and generate output never contain the key', async () => {
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '))
    })
    await vaultCommand(['master-key', 'generate'])
    await vaultCommand(['master-key', 'status'])
    await vaultCommand(['master-key', 'show-path'])
    const key = (await readFile(projectKey, 'utf-8')).trim()
    const text = out.join('\n')
    expect(text).not.toContain(key)
    expect(text).toContain('source: project')
    expect(text).toContain(projectKey)
  })

  it('ensureProjectMasterKey creates once, then reports exists', async () => {
    const root = join(dir, 'fresh')
    await mkdir(root, { recursive: true })
    expect((await ensureProjectMasterKey(root, process.env)).status).toBe('created')
    expect((await ensureProjectMasterKey(root, process.env)).status).toBe('exists')
  })

  it('ensureProjectMasterKey skips when a store exists or a key is configured', async () => {
    const root = join(dir, 'fresh')
    await mkdir(root, { recursive: true })
    await createEmbedStore({ path: env.MT_EMBED_PATH }, env)
    expect((await ensureProjectMasterKey(root, process.env)).status).toBe('skipped')
    await rm(env.MT_EMBED_PATH as string)
    await writeFile(join(dir, 'home', 'master.key'), 'user-key\n', { mode: 0o600 })
    expect((await ensureProjectMasterKey(root, process.env)).status).toBe('skipped')
  })
})
