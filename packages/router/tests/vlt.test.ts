import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readVaultEntries } from '../server/utils/vault-reader.js'
import { getVaultUpstreams, resetVaultState } from '../server/utils/vault-upstreams.js'
import { resetVltState } from '../server/utils/vlt.js'

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

const SECRET_A = 'sk-resolved-one'

describe('router vlt', () => {
  let dir: string
  let vaultFile: string
  let savedVault: string | undefined
  let savedPath: string | undefined

  const writeVault = async (entries: unknown, bump = 0) => {
    await writeFile(vaultFile, JSON.stringify({ version: 1, entries }))
    const t = new Date(Date.now() + bump)
    await utimes(vaultFile, t, t)
  }

  /** Make `vlt show` succeed, resolving each secret to `sk-resolved-<name>`. */
  const mockShowSuccess = () => {
    execFileSyncMock.mockImplementation((_binary: unknown, args: unknown) => {
      const name = (args as string[])[1] as string
      return `sk-resolved-${name}\n`
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-router-vlt-'))
    vaultFile = join(dir, 'vault.json')
    savedVault = process.env.MT_VAULT
    savedPath = process.env.PATH
    process.env.MT_VAULT = vaultFile
    // Stub binary so resolution never fails for a missing vlt.
    const binDir = join(dir, 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, 'vlt'), '#!/bin/sh\n', { mode: 0o755 })
    process.env.PATH = binDir
    execFileSyncMock.mockReset()
    resetVltState()
    resetVaultState()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    if (savedVault === undefined) Reflect.deleteProperty(process.env, 'MT_VAULT')
    else process.env.MT_VAULT = savedVault
    if (savedPath === undefined) Reflect.deleteProperty(process.env, 'PATH')
    else process.env.PATH = savedPath
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('readVaultEntries resolves vlt: refs in apiKey/apiKeys', async () => {
    mockShowSuccess()
    await writeVault({
      a: { provider: 'openrouter', apiKey: 'vlt:one', apiKeys: ['vlt:two', 'plain'] },
    })
    const merged = readVaultEntries([vaultFile])
    expect(merged.a?.apiKey).toBe('sk-resolved-one')
    expect(merged.a?.apiKeys).toEqual(['sk-resolved-two', 'plain'])
    // The file on disk keeps the refs.
    const raw = await readFile(vaultFile, 'utf-8')
    expect(raw).toContain('vlt:one')
    expect(raw).not.toContain(SECRET_A)
  })

  it('memoizes resolved secrets so polls do not fork vlt again', async () => {
    mockShowSuccess()
    await writeVault({ a: { provider: 'openrouter', apiKey: 'vlt:one' } })
    readVaultEntries([vaultFile])
    readVaultEntries([vaultFile])
    readVaultEntries([vaultFile])
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
  })

  it('MT_VLT=false passes refs through', async () => {
    await writeVault({ a: { provider: 'openrouter', apiKey: 'vlt:one' } })
    process.env.MT_VLT = 'false'
    try {
      const merged = readVaultEntries([vaultFile])
      expect(merged.a?.apiKey).toBe('vlt:one')
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(process.env, 'MT_VLT')
    }
  })

  it('keeps previous upstreams when vlt fails, then re-resolves after the session returns', async () => {
    mockShowSuccess()
    await writeVault({ a: { provider: 'openrouter', apiKey: 'vlt:one' } })
    expect(getVaultUpstreams().openRouterKeys).toEqual([SECRET_A])

    // Session dies: a new (unmemoized) ref fails to resolve, previous entries kept.
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'session expired' })
    })
    await writeVault({ a: { provider: 'openrouter', apiKey: 'vlt:two' } }, 5000)
    expect(getVaultUpstreams().openRouterKeys).toEqual([SECRET_A])
    const logged = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(logged).toContain('keeping previous')

    // Session back: the next reload re-resolves (the failed ref was not memoized).
    mockShowSuccess()
    await writeVault({ a: { provider: 'openrouter', apiKey: 'vlt:two' } }, 10_000)
    expect(getVaultUpstreams().openRouterKeys).toEqual(['sk-resolved-two'])
    expect(execFileSyncMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('resolution errors name the entry, never the output', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'session expired LEAKME' })
    })
    await writeVault({ a: { provider: 'openrouter', apiKey: 'vlt:one' } })
    const err = ((): Error => {
      try {
        readVaultEntries([vaultFile])
        return new Error('no error')
      } catch (e) {
        return e as Error
      }
    })()
    expect(err.message).toContain('Vault entry "a"')
    expect(err.message).not.toContain('LEAKME')
  })
})
