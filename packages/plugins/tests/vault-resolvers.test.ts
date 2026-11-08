import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { loadVault, registerSecretResolver, resetSecretResolvers, saveVault } from '@mt/core'
import { VLT_REF_PREFIX, resolveVltValue } from '../src/vlt.js'

const SECRET = 'sk-or-v1-SUPERSECRETVALUE1234'

beforeAll(() => {
  registerSecretResolver(VLT_REF_PREFIX, resolveVltValue)
})

afterAll(() => {
  resetSecretResolvers()
})

describe('vault vlt: refs via @mt/plugins resolver', () => {
  let dir: string
  let home: string
  let env: Record<string, string>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-vault-vlt-'))
    home = join(dir, 'home')
    await mkdir(join(dir, 'proj', '.mt'), { recursive: true })
    await mkdir(home, { recursive: true })
    env = { MT_HOME: home }
    execFileMock.mockReset()
    // Stub binary so resolution never attempts a real on-demand install.
    const binDir = join(home, 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, 'vlt'), '#!/bin/sh\n', { mode: 0o755 })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const write = (path: string, entries: Record<string, unknown>) =>
    writeFile(path, JSON.stringify({ version: 1, entries }))

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
      a: { provider: 'openrouter', apiKey: 'vlt:main', apiKeys: ['vlt:pool1', 'vlt:pool2'] },
    })
    const v = await loadVault(join(dir, 'proj'), env)
    expect(v.entries.a?.apiKey).toBe('sk-resolved-main')
    expect(v.entries.a?.apiKeys).toEqual(['sk-resolved-pool1', 'sk-resolved-pool2'])
    expect(execFileMock).toHaveBeenCalledTimes(3)
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
