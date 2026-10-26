import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argon2d, argon2id } from 'hash-wasm'
import * as kdbxweb from 'kdbxweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redact } from '../server/utils/redact.js'
import {
  readVaultEntries,
  readVaultEntriesAsync,
  vaultHasKeepassRefs,
} from '../server/utils/vault-reader.js'
import {
  getVaultUpstreams,
  refreshVaultUpstreams,
  resetVaultState,
} from '../server/utils/vault-upstreams.js'

const MASTER = 'test-master-password'
const SECRET = 'sk-or-v1-ROUTERKEEPASSSECRET1234'

let argon2Ready = false

function ensureArgon2(): void {
  if (argon2Ready) return
  kdbxweb.CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type) => {
      const argon2 = type === kdbxweb.CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id
      const hash = await argon2({
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        memorySize: memory,
        iterations,
        parallelism,
        hashLength: length,
        outputType: 'binary',
      })
      const copy = new Uint8Array(hash.length)
      copy.set(hash)
      return copy.buffer
    },
  )
  argon2Ready = true
}

async function createDatabase(path: string, entries: Record<string, string>): Promise<void> {
  ensureArgon2()
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(MASTER))
  const db = kdbxweb.Kdbx.create(credentials, 'mt')
  const group = db.getDefaultGroup()
  for (const [title, secret] of Object.entries(entries)) {
    const entry = db.createEntry(group)
    entry.fields.set('Title', title)
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(secret))
  }
  await writeFile(path, Buffer.from(await db.save()), { mode: 0o600 })
}

describe('router keepass', () => {
  let dir: string
  let vaultFile: string
  let dbPath: string
  const saved: Record<string, string | undefined> = {}

  const writeVault = async (entries: unknown, bump = 0) => {
    await writeFile(vaultFile, JSON.stringify({ version: 1, entries }))
    const t = new Date(Date.now() + bump)
    await utimes(vaultFile, t, t)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-router-keepass-'))
    vaultFile = join(dir, 'vault.json')
    dbPath = join(dir, 'secrets.kdbx')
    for (const key of [
      'MT_VAULT',
      'MT_KEEPASS_PATH',
      'MT_KEEPASS_PASSWORD',
      'MT_KEEPASS_PASSWORD_FILE',
      'MT_KEEPASS_KEY_FILE',
      'MT_KEEPASS',
    ]) {
      saved[key] = process.env[key]
    }
    process.env.MT_VAULT = vaultFile
    process.env.MT_KEEPASS_PATH = dbPath
    process.env.MT_KEEPASS_PASSWORD = MASTER
    Reflect.deleteProperty(process.env, 'MT_KEEPASS')
    await createDatabase(dbPath, { 'OpenRouter-Key': SECRET })
    resetVaultState()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetVaultState()
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('detects and resolves keepass refs asynchronously', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'keepass:OpenRouter-Key' } })
    expect(vaultHasKeepassRefs([vaultFile])).toBe(true)

    const merged = await readVaultEntriesAsync([vaultFile])
    expect(merged.a?.apiKey).toBe(SECRET)
    expect(await readFile(vaultFile, 'utf-8')).toContain('keepass:OpenRouter-Key')
    expect(await readFile(vaultFile, 'utf-8')).not.toContain(SECRET)
  })

  it('leaves keepass refs unresolved in the sync reader', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'keepass:OpenRouter-Key' } })
    expect(readVaultEntries([vaultFile]).a?.apiKey).toBe('keepass:OpenRouter-Key')
  })

  it('MT_KEEPASS=false passes refs through', async () => {
    process.env.MT_KEEPASS = 'false'
    await writeVault({ a: { provider: 'openrouter', apiKey: 'keepass:OpenRouter-Key' } })
    expect((await readVaultEntriesAsync([vaultFile])).a?.apiKey).toBe('keepass:OpenRouter-Key')
  })

  it('feeds keepass secrets into the router upstreams', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'keepass:OpenRouter-Key' } })
    await refreshVaultUpstreams()
    expect(getVaultUpstreams().openRouterKeys).toEqual([SECRET])
  })

  it('keeps the previous upstreams while the async load is pending, then swaps', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'plain-one' } })
    expect(getVaultUpstreams().openRouterKeys).toEqual(['plain-one'])

    await writeVault({ a: { provider: 'openrouter', apiKey: 'keepass:OpenRouter-Key' } }, 5000)
    // Signature changed, but the keepass load is async: old value is still served.
    expect(getVaultUpstreams().openRouterKeys).toEqual(['plain-one'])
    await refreshVaultUpstreams()
    expect(getVaultUpstreams().openRouterKeys).toEqual([SECRET])
  })

  it('reloads when the database changes', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'keepass:OpenRouter-Key' } })
    await refreshVaultUpstreams()
    expect(getVaultUpstreams().openRouterKeys).toEqual([SECRET])

    await createDatabase(dbPath, { 'OpenRouter-Key': 'sk-or-v1-UPDATED' })
    await refreshVaultUpstreams()
    expect(getVaultUpstreams().openRouterKeys).toEqual(['sk-or-v1-UPDATED'])
  })

  it('names the failing entry and never leaks credentials', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'keepass:Missing' } })
    const err = await readVaultEntriesAsync([vaultFile]).catch((e: Error) => e)
    expect((err as Error).message).toContain('Vault entry "a"')
    expect((err as Error).message).toContain('KeePass entry "Missing" not found')
    expect((err as Error).message).not.toContain(MASTER)
  })

  it('redacts keepass refs', () => {
    expect(redact('failed for keepass:OpenRouter-Key and keepass://Group/Key')).not.toContain(
      'OpenRouter-Key',
    )
  })
})
