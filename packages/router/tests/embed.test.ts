import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEmbedState } from '../server/utils/embed.js'
import { redact } from '../server/utils/redact.js'
import {
  readVaultEntries,
  readVaultEntriesAsync,
  vaultSignature,
} from '../server/utils/vault-reader.js'

const MASTER = 'test-embed-master-password'
const SECRET = 'sk-or-v1-ROUTEREMBEDSECRET1234'

const AAD = Buffer.from('mt-embed-v1', 'ascii')

/** Fixture writer mirroring the store format (router tests must not import `@mt/*`). */
function encryptFixture(entries: Record<string, { secret: string }>, password: string): string {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ version: 1, entries }), 'utf-8'),
    cipher.final(),
  ])
  return JSON.stringify({
    version: 1,
    kdf: 'scrypt',
    n: 16384,
    r: 8,
    p: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  })
}

describe('router embed', () => {
  let dir: string
  let vaultFile: string
  let storePath: string
  const saved: Record<string, string | undefined> = {}

  const writeVault = async (entries: unknown, bump = 0) => {
    await writeFile(vaultFile, JSON.stringify({ version: 1, entries }))
    const t = new Date(Date.now() + bump)
    await utimes(vaultFile, t, t)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-router-embed-'))
    vaultFile = join(dir, 'vault.json')
    storePath = join(dir, 'secrets.embed.json')
    for (const key of ['MT_VAULT', 'MT_EMBED_PATH', 'MT_EMBED_PASSWORD', 'MT_EMBED']) {
      saved[key] = process.env[key]
    }
    process.env.MT_VAULT = vaultFile
    process.env.MT_EMBED_PATH = storePath
    process.env.MT_EMBED_PASSWORD = MASTER
    Reflect.deleteProperty(process.env, 'MT_EMBED')
    await writeFile(storePath, encryptFixture({ 'OpenRouter-Key': { secret: SECRET } }, MASTER), {
      mode: 0o600,
    })
    resetEmbedState()
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    resetEmbedState()
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves embed refs in the sync reader without writing values back', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'embed:OpenRouter-Key' } })
    expect(readVaultEntries([vaultFile]).a?.apiKey).toBe(SECRET)
    expect(await readFile(vaultFile, 'utf-8')).toContain('embed:OpenRouter-Key')
    expect(await readFile(vaultFile, 'utf-8')).not.toContain(SECRET)
  })

  it('resolves embed refs in the async reader too', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'embed://OpenRouter-Key' } })
    expect((await readVaultEntriesAsync([vaultFile])).a?.apiKey).toBe(SECRET)
  })

  it('changes the hot-reload signature when the store changes', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'embed:OpenRouter-Key' } })
    const before = vaultSignature([vaultFile])

    await writeFile(
      storePath,
      encryptFixture({ 'OpenRouter-Key': { secret: 'sk-or-v1-UPDATED' } }, MASTER),
      { mode: 0o600 },
    )
    const t = new Date(Date.now() + 5000)
    await utimes(storePath, t, t)
    resetEmbedState()

    expect(vaultSignature([vaultFile])).not.toBe(before)
  })

  it('MT_EMBED=false passes refs through', async () => {
    process.env.MT_EMBED = 'false'
    await writeVault({ a: { provider: 'openrouter', apiKey: 'embed:OpenRouter-Key' } })
    expect(readVaultEntries([vaultFile]).a?.apiKey).toBe('embed:OpenRouter-Key')
    expect((await readVaultEntriesAsync([vaultFile])).a?.apiKey).toBe('embed:OpenRouter-Key')
  })

  it('names the failing entry and never leaks the password or secret', async () => {
    process.env.MT_EMBED_PASSWORD = 'wrong-password'
    await writeVault({ a: { provider: 'openrouter', apiKey: 'embed:OpenRouter-Key' } })
    const err = await readVaultEntriesAsync([vaultFile]).catch((e: Error) => e)
    expect((err as Error).message).toContain('Vault entry "a"')
    expect((err as Error).message).toContain('wrong master password')
    expect((err as Error).message).not.toContain('wrong-password')
    expect((err as Error).message).not.toContain(SECRET)
  })

  it('redacts embed refs', () => {
    expect(redact('failed for embed:OpenRouter-Key and embed://Other/Key')).not.toContain(
      'OpenRouter-Key',
    )
  })
})
