import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_EMBED_PASSWORD,
  DEFAULT_EMBED_WARNING,
  resetEmbedState,
} from '../server/utils/embed.js'
import { redact } from '../server/utils/redact.js'
import {
  readVaultEntries,
  readVaultEntriesAsync,
  vaultSignature,
} from '../server/utils/vault-reader.js'

import { encryptFixture } from './helpers/embed-fixture.js'

const MASTER = 'test-embed-master-password'
const SECRET = 'sk-or-v1-ROUTEREMBEDSECRET1234'

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

  it('rejects unsupported KDF parameters before decrypting', async () => {
    const raw = JSON.parse(await readFile(storePath, 'utf-8')) as Record<string, unknown>
    await writeFile(storePath, JSON.stringify({ ...raw, n: 32768 }), { mode: 0o600 })
    resetEmbedState()
    await writeVault({ a: { provider: 'openrouter', apiKey: 'embed:OpenRouter-Key' } })
    const err = await readVaultEntriesAsync([vaultFile]).catch((e: Error) => e)
    expect((err as Error).message).toContain('unsupported scrypt parameters')
    expect((err as Error).message).not.toContain(SECRET)
  })

  it('redacts embed refs', () => {
    expect(redact('failed for embed:OpenRouter-Key and embed://Other/Key')).not.toContain(
      'OpenRouter-Key',
    )
  })

  it('falls back to the built-in default password and warns once', async () => {
    Reflect.deleteProperty(process.env, 'MT_EMBED_PASSWORD')
    Reflect.deleteProperty(process.env, 'MT_EMBED_PASSWORD_FILE')
    await writeFile(
      storePath,
      encryptFixture({ 'OpenRouter-Key': { secret: SECRET } }, DEFAULT_EMBED_PASSWORD),
    )
    resetEmbedState()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeVault({ a: { provider: 'openrouter', apiKey: 'embed:OpenRouter-Key' } })
    expect(readVaultEntries([vaultFile]).a?.apiKey).toBe(SECRET)
    expect(readVaultEntries([vaultFile]).a?.apiKey).toBe(SECRET)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe(DEFAULT_EMBED_WARNING)
  })
  it('reads a v2 store with two keys and secrets under different kids', async () => {
    await writeFile(
      storePath,
      encryptFixture(
        { one: { secret: 'alpha', kid: 'k1' }, two: { secret: 'beta', kid: 'prod' } },
        MASTER,
      ),
    )
    resetEmbedState()
    await writeVault({
      a: { provider: 'openrouter', apiKey: 'embed:one' },
      b: { provider: 'openrouter', apiKey: 'embed:two' },
    })
    const entries = readVaultEntries([vaultFile])
    expect(entries.a?.apiKey).toBe('alpha')
    expect(entries.b?.apiKey).toBe('beta')
  })

  it('reads a store written, re-keyed and rotated by core (shared v2 format)', async () => {
    const core = await import('../../core/src/embed.js')
    const coreEnv = { MT_EMBED_PATH: storePath, MT_EMBED_PASSWORD: MASTER }
    const NEW = 'router-compat-new-master'
    await rm(storePath)
    core.resetEmbedCache()
    await core.setEmbedSecret({ name: 'one', secret: 'alpha' }, {}, coreEnv)
    await core.generateEmbedKey({ kid: 'prod' }, coreEnv)
    await core.setEmbedSecret({ name: 'two', secret: 'beta' }, {}, coreEnv)
    await core.rekeyEmbedStore({ newPassword: NEW }, coreEnv)
    await core.rotateEmbedSecret(
      { name: 'one', secret: 'alpha-2' },
      {},
      { ...coreEnv, MT_EMBED_PASSWORD: NEW },
    )
    process.env.MT_EMBED_PASSWORD = NEW
    resetEmbedState()
    await writeVault({
      a: { provider: 'openrouter', apiKey: 'embed:one' },
      b: { provider: 'openrouter', apiKey: 'embed:two' },
    })
    const entries = readVaultEntries([vaultFile])
    expect(entries.a?.apiKey).toBe('alpha-2')
    expect(entries.b?.apiKey).toBe('beta')

    process.env.MT_EMBED_PASSWORD = MASTER
    resetEmbedState()
    await writeVault({ a: { provider: 'openrouter', apiKey: 'embed:one' } }, 5)
    expect(() => readVaultEntries([vaultFile])).toThrow('wrong master password')
  })
})
