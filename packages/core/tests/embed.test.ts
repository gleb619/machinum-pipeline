import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createEmbedStore,
  defaultEmbedPath,
  embedCredentialsConfigured,
  getEmbedSecret,
  isEmbedRef,
  listEmbedEntries,
  resetEmbedCache,
  resolveEmbedValue,
  setEmbedSecret,
} from '../src/embed.js'
import { loadVault, saveVault } from '../src/vault.js'

const MASTER = 'test-embed-master-password'
const SECRET = 'sk-or-v1-EMBEDSECRET1234'

describe('embed backend', () => {
  let dir: string
  let storePath: string
  let env: Record<string, string | undefined>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-embed-'))
    storePath = join(dir, 'secrets.embed.json')
    env = { MT_EMBED_PATH: storePath, MT_EMBED_PASSWORD: MASTER }
    resetEmbedCache()
  })

  afterEach(async () => {
    resetEmbedCache()
    await rm(dir, { recursive: true, force: true })
  })

  it('creates a store and resolves a secret by name', async () => {
    await createEmbedStore({ path: storePath, password: MASTER })
    const result = await setEmbedSecret(
      { name: 'OpenRouter-Key', secret: SECRET, username: 'boris', notes: 'main key' },
      { path: storePath },
      env,
    )

    expect(result.path).toBe(storePath)
    const secret = await getEmbedSecret('OpenRouter-Key', env)
    expect(secret.secret).toBe(SECRET)
    expect(secret.username).toBe('boris')
    expect(secret.notes).toBe('main key')
  })

  it('accepts embed: and embed:// prefixes in get and resolve', async () => {
    await createEmbedStore({ path: storePath, password: MASTER })
    await setEmbedSecret({ name: 'Key', secret: SECRET }, { path: storePath }, env)

    expect((await getEmbedSecret('embed:Key', env)).secret).toBe(SECRET)
    expect((await getEmbedSecret('embed://Key', env)).secret).toBe(SECRET)
    expect(await resolveEmbedValue('embed://Key', env)).toBe(SECRET)
    expect(await resolveEmbedValue('plain', env)).toBe('plain')
  })

  it('lists entry metadata without secrets, sorted by name', async () => {
    await createEmbedStore({ path: storePath, password: MASTER })
    await setEmbedSecret({ name: 'b-key', secret: 'two', username: 'u2' }, { path: storePath }, env)
    await setEmbedSecret({ name: 'a-key', secret: 'one' }, { path: storePath }, env)

    const entries = await listEmbedEntries(env)
    expect(entries.map((entry) => entry.name)).toEqual(['a-key', 'b-key'])
    expect(entries[0]).not.toHaveProperty('secret')
    expect(JSON.stringify(entries)).not.toContain('one')
  })

  it('refuses to create over an existing store', async () => {
    await createEmbedStore({ path: storePath, password: MASTER })
    const err = await createEmbedStore({ path: storePath, password: MASTER }).catch((e: Error) => e)
    expect((err as Error).message).toContain('already exists')
  })

  it('requires an existing store and honors overwrite', async () => {
    const missing = await setEmbedSecret(
      { name: 'Key', secret: SECRET },
      { path: storePath },
      env,
    ).catch((e: Error) => e)
    expect((missing as Error).message).toContain('embed-init')

    await createEmbedStore({ path: storePath, password: MASTER })
    await setEmbedSecret({ name: 'Key', secret: 'one' }, { path: storePath }, env)
    const dup = await setEmbedSecret(
      { name: 'Key', secret: 'two' },
      { path: storePath },
      env,
    ).catch((e: Error) => e)
    expect((dup as Error).message).toContain('already exists')
    expect((await getEmbedSecret('Key', env)).secret).toBe('one')

    await setEmbedSecret({ name: 'Key', secret: 'two' }, { path: storePath, overwrite: true }, env)
    expect((await getEmbedSecret('Key', env)).secret).toBe('two')
  })

  it('reports a wrong password without leaking it', async () => {
    await createEmbedStore({ path: storePath, password: MASTER })
    await setEmbedSecret({ name: 'Key', secret: SECRET }, { path: storePath }, env)
    const err = await getEmbedSecret('Key', { ...env, MT_EMBED_PASSWORD: 'wrong-password' }).catch(
      (e: Error) => e,
    )
    expect((err as Error).message).toContain('wrong master password')
    expect((err as Error).message).not.toContain('wrong-password')
    expect((err as Error).message).not.toContain(SECRET)
  })

  it('reads the master password from a file', async () => {
    const passwordFile = join(dir, 'master.txt')
    await writeFile(passwordFile, `${MASTER}\n`)
    await createEmbedStore({ path: storePath, password: MASTER })
    await setEmbedSecret({ name: 'Key', secret: SECRET }, { path: storePath }, env)

    const secret = await getEmbedSecret('Key', {
      MT_EMBED_PATH: storePath,
      MT_EMBED_PASSWORD_FILE: passwordFile,
    })
    expect(secret.secret).toBe(SECRET)
  })

  it('requires configured non-empty credentials', async () => {
    expect(embedCredentialsConfigured(env)).toBe(true)
    expect(embedCredentialsConfigured({})).toBe(false)
    expect(embedCredentialsConfigured({ MT_EMBED_PASSWORD: '' })).toBe(false)
    const err = await getEmbedSecret('Key', { MT_EMBED_PATH: storePath }).catch((e: Error) => e)
    expect((err as Error).message).toContain('master password required')
    expect((err as Error).message).toContain('MT_EMBED_PASSWORD')

    const empty = await createEmbedStore({ path: storePath, password: '' }).catch((e: Error) => e)
    expect((empty as Error).message).toContain('non-empty')
  })

  it('detects tampering and malformed envelopes', async () => {
    await createEmbedStore({ path: storePath, password: MASTER })
    await setEmbedSecret({ name: 'Key', secret: SECRET }, { path: storePath }, env)

    const raw = await readFile(storePath, 'utf-8')
    const envelope = JSON.parse(raw) as { ciphertext: string }
    const bytes = Buffer.from(envelope.ciphertext, 'base64')
    const first = bytes[0] ?? 0
    bytes[0] = first === 0 ? 1 : first ^ 0xff
    envelope.ciphertext = bytes.toString('base64')
    await writeFile(storePath, JSON.stringify(envelope))
    resetEmbedCache(storePath)

    const err = await getEmbedSecret('Key', env).catch((e: Error) => e)
    expect((err as Error).message).toContain('wrong master password')
    expect((err as Error).message).not.toContain(SECRET)

    await writeFile(storePath, JSON.stringify({ version: 2, kdf: 'scrypt' }))
    resetEmbedCache(storePath)
    const bad = await getEmbedSecret('Key', env).catch((e: Error) => e)
    expect((bad as Error).message).toContain('Invalid embedded store')

    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        kdf: 'scrypt',
        n: 32768,
        r: 8,
        p: 1,
        salt: '',
        iv: '',
        tag: '',
        ciphertext: '',
      }),
    )
    resetEmbedCache(storePath)
    const kdf = await getEmbedSecret('Key', env).catch((e: Error) => e)
    expect((kdf as Error).message).toContain('fixed KDF parameters')
  })

  it('recognizes refs and passes them through when disabled', async () => {
    expect(isEmbedRef('embed:Key')).toBe(true)
    expect(isEmbedRef('keepass:Key')).toBe(false)
    await createEmbedStore({ path: storePath, password: MASTER })
    await setEmbedSecret({ name: 'Key', secret: SECRET }, { path: storePath }, env)

    expect(await resolveEmbedValue('embed:Key', env)).toBe(SECRET)
    expect(await resolveEmbedValue('embed:Key', { ...env, MT_EMBED: 'false' })).toBe('embed:Key')
  })

  it('writes the store with mode 0600 and resolves vault refs without writing back', async () => {
    await createEmbedStore({ path: storePath, password: MASTER })
    await setEmbedSecret({ name: 'OpenRouter-Key', secret: SECRET }, { path: storePath }, env)
    expect((await stat(storePath)).mode & 0o777).toBe(0o600)

    const project = join(dir, 'proj')
    const vaultPath = join(project, '.mt', 'vault.json')
    await saveVault(vaultPath, {
      version: 1,
      entries: { a: { provider: 'openrouter', apiKey: 'embed:OpenRouter-Key' } },
    })

    const vault = await loadVault(project, env)
    expect(vault.entries.a?.apiKey).toBe(SECRET)

    const stored = await loadVault(project, env, { resolveRefs: false })
    expect(stored.entries.a?.apiKey).toBe('embed:OpenRouter-Key')
    expect(await readFile(vaultPath, 'utf-8')).toContain('embed:OpenRouter-Key')
    expect(await readFile(vaultPath, 'utf-8')).not.toContain(SECRET)
  })

  it('names the failing vault entry, not the secret', async () => {
    await createEmbedStore({ path: storePath, password: MASTER })
    const project = join(dir, 'proj')
    await saveVault(join(project, '.mt', 'vault.json'), {
      version: 1,
      entries: { a: { provider: 'openrouter', apiKey: 'embed:Missing' } },
    })
    const err = await loadVault(project, env).catch((e: Error) => e)
    expect((err as Error).message).toContain('Vault entry "a"')
    expect((err as Error).message).toContain('Embedded store entry "Missing" not found')
    expect((err as Error).message).not.toContain(SECRET)
  })

  it('defaults the path from MT_HOME', () => {
    expect(defaultEmbedPath({ MT_HOME: '/h' })).toBe('/h/secrets.embed.json')
    expect(defaultEmbedPath({ HOME: '/x' })).toBe('/x/.mt/secrets.embed.json')
    expect(defaultEmbedPath({ MT_EMBED_PATH: 'rel/f.json' })).toBe(resolve('rel/f.json'))
  })
})
