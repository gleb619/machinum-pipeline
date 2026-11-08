import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_EMBED_PASSWORD,
  DEFAULT_EMBED_WARNING,
  createEmbedStore,
  generateMasterKey,
  getEmbedSecret,
  masterKeyStatus,
  resetEmbedCache,
  resetEmbedDefaultWarning,
  resetMasterKeyWarnings,
  resolveMasterKey,
  setEmbedSecret,
  writeMasterKeyFile,
} from '../src/secrets.js'

describe('master key', () => {
  let dir: string
  let env: Record<string, string | undefined>
  let projectKey: string
  let userKey: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-masterkey-'))
    const project = join(dir, 'project')
    const home = join(dir, 'home')
    await mkdir(join(project, '.mt'), { recursive: true })
    await mkdir(home, { recursive: true })
    projectKey = join(project, '.mt', 'master.key')
    userKey = join(home, 'master.key')
    env = { MT_PROJECT_ROOT: project, MT_HOME: home, MT_EMBED_PATH: join(dir, 'store.json') }
    resetEmbedCache()
    resetEmbedDefaultWarning()
    resetMasterKeyWarnings()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('generates 256-bit base64url keys', () => {
    const key = generateMasterKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateMasterKey()).not.toBe(key)
  })

  it('writes mode 0600, refuses to overwrite, overwrites with force', async () => {
    await writeMasterKeyFile(projectKey)
    expect((await stat(projectKey)).mode & 0o777).toBe(0o600)
    const first = await readFile(projectKey, 'utf-8')
    expect(first.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(writeMasterKeyFile(projectKey)).rejects.toThrow('refusing to overwrite')
    expect(await readFile(projectKey, 'utf-8')).toBe(first)
    await writeMasterKeyFile(projectKey, { force: true })
    expect(await readFile(projectKey, 'utf-8')).not.toBe(first)
  })

  it('resolves env > env file > project > user > default', async () => {
    const pwFile = join(dir, 'pw')
    await writeFile(pwFile, 'from-file\n')
    await writeFile(projectKey, 'project-key\n')
    await writeFile(userKey, 'user-key\n')
    await chmod(projectKey, 0o600)
    await chmod(userKey, 0o600)

    expect(
      await resolveMasterKey({ ...env, MT_EMBED_PASSWORD: 'e', MT_EMBED_PASSWORD_FILE: pwFile }),
    ).toMatchObject({ source: 'env', password: 'e' })
    expect(await resolveMasterKey({ ...env, MT_EMBED_PASSWORD_FILE: pwFile })).toMatchObject({
      source: 'env-file',
      password: 'from-file',
    })
    expect(await resolveMasterKey(env)).toMatchObject({
      source: 'project',
      password: 'project-key',
    })
    await rm(projectKey)
    expect(await resolveMasterKey(env)).toMatchObject({ source: 'user', password: 'user-key' })
    await rm(userKey)
    expect(await resolveMasterKey(env)).toBeUndefined()
  })

  it('warns once on a broad-permission key file but still uses it', async () => {
    await writeFile(projectKey, 'project-key\n')
    await chmod(projectKey, 0o644)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await resolveMasterKey(env))?.password).toBe('project-key')
    await resolveMasterKey(env)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('chmod 600')
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('project-key')
  })

  it('rejects an empty key file', async () => {
    await writeFile(projectKey, '\n')
    await chmod(projectKey, 0o600)
    await expect(resolveMasterKey(env)).rejects.toThrow('is empty')
  })

  it('seals the store under the project key file, not the default', async () => {
    await writeMasterKeyFile(projectKey)
    await createEmbedStore({ path: env.MT_EMBED_PATH }, env)
    await setEmbedSecret({ name: 'K', secret: 'sk-1' }, {}, env)
    resetEmbedCache()
    expect((await getEmbedSecret('K', env)).secret).toBe('sk-1')
    // wrong source (default password) cannot open it
    const other = { ...env, MT_PROJECT_ROOT: join(dir, 'elsewhere') }
    resetEmbedCache()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(getEmbedSecret('K', other)).rejects.toThrow('wrong master password')
  })

  it('default fallback warning suggests master-key generate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await createEmbedStore({ path: env.MT_EMBED_PATH }, env)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_EMBED_WARNING))
    expect(DEFAULT_EMBED_WARNING).toContain('mt vault master-key generate')
    expect(DEFAULT_EMBED_PASSWORD).toBeTruthy()
  })

  it('status reports the source and path without the key', async () => {
    expect((await masterKeyStatus(env)).source).toBe('default')
    await writeMasterKeyFile(projectKey)
    const key = (await readFile(projectKey, 'utf-8')).trim()
    const status = await masterKeyStatus(env)
    expect(status).toEqual({ source: 'project', path: projectKey, tooOpen: false })
    expect(JSON.stringify(status)).not.toContain(key)
  })
})
