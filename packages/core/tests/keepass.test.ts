import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as kdbxweb from 'kdbxweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addKeepassSecret,
  createKeepassDatabase,
  defaultKeepassPath,
  getKeepassSecret,
  isKeepassRef,
  keepassCredentialsConfigured,
  listKeepassEntries,
  resetKeepassCache,
  resolveKeepassValue,
} from '../src/keepass.js'
import { loadVault, saveVault } from '../src/vault.js'

const MASTER = 'test-master-password'
const SECRET = 'sk-or-v1-KEEPASSSECRET1234'

describe('keepass backend', () => {
  let dir: string
  let dbPath: string
  let env: Record<string, string | undefined>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-keepass-'))
    dbPath = join(dir, 'secrets.kdbx')
    env = { MT_KEEPASS_PATH: dbPath, MT_KEEPASS_PASSWORD: MASTER }
    resetKeepassCache()
  })

  afterEach(async () => {
    resetKeepassCache()
    await rm(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('creates a database and resolves a secret by title', async () => {
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    const added = await addKeepassSecret(
      {
        title: 'OpenRouter-Key',
        secret: SECRET,
        username: 'boris',
        group: 'LLM/API',
      },
      { path: dbPath },
      env,
    )

    const secret = await getKeepassSecret('OpenRouter-Key', env)
    expect(secret.password).toBe(SECRET)
    expect(secret.username).toBe('boris')
    expect(secret.group).toBe('LLM/API')
    expect(secret.uuid).toBe(added.uuid)
  })

  it('resolves by UUID and group/title path', async () => {
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    const added = await addKeepassSecret(
      { title: 'Key', secret: SECRET, group: 'API' },
      { path: dbPath },
      env,
    )

    expect((await getKeepassSecret(added.uuid, env)).password).toBe(SECRET)
    expect((await getKeepassSecret('API/Key', env)).password).toBe(SECRET)
  })

  it('updates an existing entry instead of duplicating it', async () => {
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    await addKeepassSecret({ title: 'Key', secret: 'one' }, { path: dbPath }, env)
    await addKeepassSecret({ title: 'Key', secret: 'two' }, { path: dbPath }, env)

    expect((await getKeepassSecret('Key', env)).password).toBe('two')
    expect(await listKeepassEntries(env)).toHaveLength(1)
  })

  it('lists entry metadata without passwords', async () => {
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    await addKeepassSecret(
      { title: 'Key', secret: SECRET, username: 'u', group: 'API' },
      { path: dbPath },
      env,
    )

    const entries = await listKeepassEntries(env)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ title: 'Key', username: 'u', group: 'API' })
    expect(entries[0]).not.toHaveProperty('password')
  })

  it('reports a missing database without echoing secrets', async () => {
    const err = await getKeepassSecret('Key', env).catch((e: Error) => e)
    expect((err as Error).message).toContain('KeePass database not found')
    expect((err as Error).message).toContain(dbPath)
  })

  it('reports a wrong master password without leaking it', async () => {
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    const err = await getKeepassSecret('Key', {
      ...env,
      MT_KEEPASS_PASSWORD: 'wrong-password',
    }).catch((e: Error) => e)
    expect((err as Error).message).toContain('wrong master password')
    expect((err as Error).message).not.toContain('wrong-password')
  })

  it('requires configured credentials', async () => {
    expect(keepassCredentialsConfigured(env)).toBe(true)
    expect(keepassCredentialsConfigured({})).toBe(false)
    const err = await getKeepassSecret('Key', { MT_KEEPASS_PATH: dbPath }).catch((e: Error) => e)
    expect((err as Error).message).toContain('master password required')
  })

  it('reads the master password from a file', async () => {
    const passwordFile = join(dir, 'master.txt')
    await writeFile(passwordFile, `${MASTER}\n`)
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    await addKeepassSecret({ title: 'Key', secret: SECRET }, { path: dbPath }, env)

    const secret = await getKeepassSecret('Key', {
      MT_KEEPASS_PATH: dbPath,
      MT_KEEPASS_PASSWORD_FILE: passwordFile,
    })
    expect(secret.password).toBe(SECRET)
  })

  it('supports a key file in addition to the password', async () => {
    const keyFile = join(dir, 'key.bin')
    await writeFile(keyFile, await kdbxweb.Credentials.createRandomKeyFile())
    await createKeepassDatabase({ path: dbPath, password: MASTER, keyFile })
    await addKeepassSecret({ title: 'Key', secret: SECRET }, { path: dbPath, keyFile }, env)

    const secret = await getKeepassSecret('Key', { ...env, MT_KEEPASS_KEY_FILE: keyFile })
    expect(secret.password).toBe(SECRET)
    const err = await getKeepassSecret('Key', env).catch((e: Error) => e)
    expect((err as Error).message).toContain('wrong master password/key file')
  })

  it('memoizes the database between reads', async () => {
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    await addKeepassSecret({ title: 'Key', secret: SECRET }, { path: dbPath }, env)
    const load = vi.spyOn(kdbxweb.Kdbx, 'load')

    await getKeepassSecret('Key', env)
    await getKeepassSecret('Key', env)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('recognizes refs and passes them through when disabled', async () => {
    expect(isKeepassRef('keepass:Key')).toBe(true)
    expect(isKeepassRef('vault://x')).toBe(false)
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    await addKeepassSecret({ title: 'Key', secret: SECRET }, { path: dbPath }, env)
    expect(await resolveKeepassValue('keepass:Key', env)).toBe(SECRET)
    expect(await resolveKeepassValue('keepass://Key', env)).toBe(SECRET)
    expect(await resolveKeepassValue('keepass:Key', { ...env, MT_KEEPASS: 'false' })).toBe(
      'keepass:Key',
    )
    expect(await resolveKeepassValue('plain', env)).toBe('plain')
  })

  it('resolves keepass refs in a vault without writing values back', async () => {
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    await addKeepassSecret({ title: 'OpenRouter-Key', secret: SECRET }, { path: dbPath }, env)
    const project = join(dir, 'proj')
    const vaultPath = join(project, '.mt', 'vault.json')
    await saveVault(vaultPath, {
      version: 1,
      entries: {
        a: { provider: 'openrouter', apiKey: 'keepass:OpenRouter-Key' },
      },
    })

    const vault = await loadVault(project, env)
    expect(vault.entries.a?.apiKey).toBe(SECRET)

    const stored = await loadVault(project, env, { resolveRefs: false })
    expect(stored.entries.a?.apiKey).toBe('keepass:OpenRouter-Key')
    expect(await readFile(vaultPath, 'utf-8')).toContain('keepass:OpenRouter-Key')
    expect(await readFile(vaultPath, 'utf-8')).not.toContain(SECRET)
  })

  it('names the failing vault entry, not the secret', async () => {
    await createKeepassDatabase({ path: dbPath, password: MASTER })
    const project = join(dir, 'proj')
    await saveVault(join(project, '.mt', 'vault.json'), {
      version: 1,
      entries: { a: { provider: 'openrouter', apiKey: 'keepass:Missing' } },
    })
    const err = await loadVault(project, env).catch((e: Error) => e)
    expect((err as Error).message).toContain('Vault entry "a"')
    expect((err as Error).message).toContain('KeePass entry "Missing" not found')
  })
})
