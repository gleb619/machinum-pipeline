import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

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
    execFileMock.mockReset()
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

  describe('vlt refs', () => {
    beforeEach(async () => {
      // Stub binary so resolution never attempts a real on-demand install.
      const binDir = join(home, 'bin')
      await mkdir(binDir, { recursive: true })
      await writeFile(join(binDir, 'vlt'), '#!/bin/sh\n', { mode: 0o755 })
    })

    const mockShow = (impl: (name: string) => string) => {
      execFileMock.mockImplementation(
        (_file: unknown, args: unknown, _opts: unknown, cb: unknown) => {
          const name = (args as string[])[1] as string
          expect(args).toEqual(['show', name, '--stdout'])
          ;(cb as (e: Error | null, so: string, se: string) => void)(null, `${impl(name)}\n`, '')
        },
      )
    }

    it('resolves vlt: refs in apiKey/apiKeys in memory', async () => {
      mockShow((name) => `sk-resolved-${name}`)
      await write(join(dir, 'proj', '.mt', 'vault.json'), {
        a: { provider: 'openrouter', apiKey: 'vlt:main', apiKeys: ['vlt:pool1', 'plain-key'] },
      })
      const v = await loadVault(join(dir, 'proj'), env)
      expect(v.entries.a?.apiKey).toBe('sk-resolved-main')
      expect(v.entries.a?.apiKeys).toEqual(['sk-resolved-pool1', 'plain-key'])
      expect(execFileMock).toHaveBeenCalledTimes(2)
    })

    it('never writes resolved values back to the vault file', async () => {
      mockShow(() => SECRET)
      const p = join(dir, 'proj', '.mt', 'vault.json')
      await write(p, { a: { provider: 'openrouter', apiKey: 'vlt:main' } })
      await loadVault(join(dir, 'proj'), env)
      const raw = await readFile(p, 'utf-8')
      expect(raw).toContain('vlt:main')
      expect(raw).not.toContain(SECRET)
      // Editing flows (load raw → save) keep the ref too.
      const stored = await loadVault(
        join(dir, 'proj'),
        { ...env, MT_VAULT: p },
        { resolveVlt: false },
      )
      await saveVault(p, stored)
      expect(await readFile(p, 'utf-8')).toContain('vlt:main')
    })

    it('MT_VLT=false keeps refs unresolved', async () => {
      await write(join(dir, 'proj', '.mt', 'vault.json'), {
        a: { provider: 'openrouter', apiKey: 'vlt:main' },
      })
      const v = await loadVault(join(dir, 'proj'), { ...env, MT_VLT: 'false' })
      expect(v.entries.a?.apiKey).toBe('vlt:main')
      expect(execFileMock).not.toHaveBeenCalled()
    })

    it('resolution failure names the entry without leaking output', async () => {
      execFileMock.mockImplementation(
        (_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          const err = Object.assign(new Error('exit 1'), { code: 1 })
          ;(cb as (e: Error | null, so: string, se: string) => void)(
            err,
            '',
            'session expired, LEAKEDOUTPUT',
          )
        },
      )
      await write(join(dir, 'proj', '.mt', 'vault.json'), {
        a: { provider: 'openrouter', apiKey: 'vlt:main' },
      })
      const err = await loadVault(join(dir, 'proj'), env).catch((e: Error) => e)
      expect((err as Error).message).toContain('Vault entry "a"')
      expect((err as Error).message).toMatch(/session expired or vault locked/)
      expect((err as Error).message).not.toContain('LEAKEDOUTPUT')
    })
  })
})
