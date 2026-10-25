import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadGlobalContext } from '../src/config.js'
import {
  type Vault,
  loadVault,
  maskVault,
  parseVaultRef,
  resolveVaultRef,
  saveVault,
} from '../src/vault.js'

const SECRET = 'sk-or-v1-SUPERSECRETVALUE1234'

describe('vault', () => {
  let dir: string
  let home: string
  let env: Record<string, string>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-vault-'))
    home = join(dir, 'home')
    await mkdir(join(dir, 'proj', '.mt'), { recursive: true })
    await mkdir(home, { recursive: true })
    env = { MT_HOME: home }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const write = (path: string, entries: Record<string, unknown>) =>
    writeFile(path, JSON.stringify({ version: 1, entries }))

  it('parses refs', () => {
    expect(parseVaultRef('vault://a')).toEqual({ entry: 'a' })
    expect(parseVaultRef('vault://a/llama3:8b')).toEqual({ entry: 'a', model: 'llama3:8b' })
    expect(parseVaultRef('@vault/a/openai/gpt-4o')).toEqual({ entry: 'a', model: 'openai/gpt-4o' })
    expect(parseVaultRef('openai/gpt-4o')).toBeUndefined()
    expect(parseVaultRef('vault://')).toBeUndefined()
  })

  it('missing files give empty vault', async () => {
    expect(await loadVault(join(dir, 'proj'), env)).toEqual({ version: 1, entries: {} })
  })

  it('project overrides user by name', async () => {
    await write(join(home, 'vault.json'), {
      a: { provider: 'ollama', baseUrl: 'http://user' },
      b: { provider: 'openai' },
    })
    await write(join(dir, 'proj', '.mt', 'vault.json'), {
      a: { provider: 'ollama', baseUrl: 'http://project' },
    })
    const v = await loadVault(join(dir, 'proj'), env)
    expect(v.entries.a?.baseUrl).toBe('http://project')
    expect(v.entries.b?.provider).toBe('openai')
  })

  it('MT_VAULT overrides everything', async () => {
    await write(join(home, 'vault.json'), { a: { provider: 'ollama' } })
    const custom = join(dir, 'custom.json')
    await write(custom, { z: { provider: 'custom' } })
    const v = await loadVault(join(dir, 'proj'), { ...env, MT_VAULT: custom })
    expect(Object.keys(v.entries)).toEqual(['z'])
  })

  it('masks secrets', () => {
    const vault: Vault = {
      version: 1,
      entries: {
        a: {
          provider: 'openrouter',
          apiKey: SECRET,
          apiKeys: [SECRET],
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      },
    }
    const masked = maskVault(vault)
    expect(masked.entries.a?.apiKey).toBe('sk-…1234')
    expect(JSON.stringify(masked)).not.toContain('SUPERSECRET')
    expect(vault.entries.a?.apiKey).toBe(SECRET)
  })

  it('errors name file and entry but not secrets', async () => {
    const p = join(dir, 'proj', '.mt', 'vault.json')
    await write(p, { bad: { provider: 'nope', apiKey: SECRET } })
    const err = await loadVault(join(dir, 'proj'), env).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain(p)
    expect((err as Error).message).toContain('bad')
    expect((err as Error).message).not.toContain('SUPERSECRET')

    await write(p, { bad: { provider: 'openai', apiKey: 42 } })
    await expect(loadVault(join(dir, 'proj'), env)).rejects.toThrow(/"apiKey" must be a string/)

    await writeFile(p, `{"version":1, "apiKey": "${SECRET}" oops`)
    const bad = await loadVault(join(dir, 'proj'), env).catch((e: Error) => e)
    expect((bad as Error).message).toContain('malformed JSON')
    expect((bad as Error).message).not.toContain('SUPERSECRET')
  })

  it('resolves refs with defaultModel and validates models', () => {
    const vault: Vault = {
      version: 1,
      entries: {
        o: { provider: 'ollama', models: ['m1', 'x/m2'], defaultModel: 'm1', apiKey: SECRET },
      },
    }
    expect(resolveVaultRef(vault, 'vault://o').model).toBe('m1')
    expect(resolveVaultRef(vault, '@vault/o/x/m2').model).toBe('x/m2')
    expect(resolveVaultRef(vault, 'vault://o').name).toBe('o')
    expect(() => resolveVaultRef(vault, 'vault://nope')).toThrow(/Available entries: o/)
    expect(() => resolveVaultRef(vault, 'vault://o/zzz')).toThrow(/Available models: m1, x\/m2/)
    try {
      resolveVaultRef(vault, 'vault://o/zzz')
    } catch (e) {
      expect((e as Error).message).not.toContain('SUPERSECRET')
    }
  })

  it('saves atomically with mode 0600', async () => {
    const p = join(dir, 'out', 'vault.json')
    await saveVault(p, { version: 1, entries: { a: { provider: 'ollama' } } })
    expect((await stat(p)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(dir, 'out'))).toEqual(['vault.json'])
    expect((await loadVault(dir, { MT_VAULT: p })).entries.a?.provider).toBe('ollama')
  })

  it('global context carries vault but excludes it from serialization', async () => {
    const saved = process.env.MT_VAULT
    const p = join(dir, 'v.json')
    await write(p, { a: { provider: 'openai', apiKey: SECRET } })
    process.env.MT_VAULT = p
    try {
      const ctx = await loadGlobalContext(join(dir, 'proj'))
      expect(ctx.vault?.entries.a?.apiKey).toBe(SECRET)
      expect(JSON.stringify(ctx)).not.toContain('SUPERSECRET')
      expect(Object.keys(ctx)).not.toContain('vault')
      expect(JSON.stringify({ ...ctx })).not.toContain('SUPERSECRET')
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'MT_VAULT')
      else process.env.MT_VAULT = saved
    }
  })
})
