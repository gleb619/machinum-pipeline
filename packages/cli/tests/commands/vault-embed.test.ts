import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetEmbedDefaultWarning } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultCommand } from '../../src/commands/vault.js'

const MASTER = 'cli-embed-master-password'
const SECRET = 'sk-or-v1-CLIEMBEDSECRET1234'
const NEXT = 'sk-or-v1-CLINEXTSECRET5678'

function logged(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
}

describe('vault embed subcommands', () => {
  let dir: string
  let storePath: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-vault-embed-cli-'))
    storePath = join(dir, 'secrets.embed.json')
    for (const key of [
      'MT_EMBED_PATH',
      'MT_EMBED_PASSWORD',
      'MT_EMBED_PASSWORD_FILE',
      'MT_VAULT',
    ]) {
      saved[key] = process.env[key]
    }
    process.env.MT_EMBED_PATH = storePath
    process.env.MT_EMBED_PASSWORD = MASTER
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`EXIT ${code}`)
    })
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('embed-init creates a 0600 store and refuses to overwrite it', async () => {
    await vaultCommand(['embed-init'])
    expect(logged().join('\n')).toContain(storePath)
    expect((await stat(storePath)).mode & 0o777).toBe(0o600)

    await expect(vaultCommand(['embed-init'])).rejects.toThrow('EXIT 1')
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('already exists')
  })

  it('embed-add stores a secret and embed-list shows it without the value', async () => {
    await vaultCommand(['embed-init'])
    await vaultCommand(['embed-add', 'OpenRouter-Key', '--secret', SECRET, '--username', 'boris'])

    const output = logged().join('\n')
    expect(output).toContain('Saved embedded secret "OpenRouter-Key"')
    expect(output).not.toContain(SECRET)

    vi.mocked(console.log).mockClear()
    await vaultCommand(['embed-list'])
    const list = logged().join('\n')
    expect(list).toContain('OpenRouter-Key')
    expect(list).toContain('boris')
    expect(list).not.toContain(SECRET)
  })

  it('embed-add --force overwrites an existing entry', async () => {
    await vaultCommand(['embed-init'])
    await vaultCommand(['embed-add', 'Key', '--secret', 'one'])
    await expect(vaultCommand(['embed-add', 'Key', '--secret', 'two'])).rejects.toThrow('EXIT 1')
    await vaultCommand(['embed-add', 'Key', '--secret', 'two', '--force'])

    vi.mocked(console.log).mockClear()
    await vaultCommand(['embed-status'])
    expect(logged().join('\n')).toContain('unlocked: 1 entry')
  })

  it('embed-status reports path, credentials and unlock state', async () => {
    await vaultCommand(['embed-init'])
    await vaultCommand(['embed-add', 'Key', '--secret', SECRET])

    vi.mocked(console.log).mockClear()
    await vaultCommand(['embed-status'])
    const output = logged().join('\n')
    expect(output).toContain(`store: ${storePath}`)
    expect(output).toContain('state: exists')
    expect(output).toContain('credentials: configured')
    expect(output).toContain('unlocked: 1 entry')
    expect(output).not.toContain(SECRET)
  })

  it('embed-status reports a missing store without failing', async () => {
    process.env.MT_EMBED_PATH = join(dir, 'missing.embed.json')
    await vaultCommand(['embed-status'])
    expect(logged().join('\n')).toContain('state: missing')
  })

  it('without credentials the built-in default password is used, with a one-time warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetEmbedDefaultWarning()
    Reflect.deleteProperty(process.env, 'MT_EMBED_PASSWORD')
    Reflect.deleteProperty(process.env, 'MT_EMBED_PASSWORD_FILE')
    await vaultCommand(['embed-add', 'Key', '--secret', SECRET])
    await vaultCommand(['embed-add', 'Key2', '--secret', SECRET])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('MT_EMBED_PASSWORD')
    expect(warn.mock.calls.flat().join('\n')).not.toContain(SECRET)

    vi.mocked(console.log).mockClear()
    await vaultCommand(['embed-status'])
    expect(logged().join('\n')).toContain('built-in default')
    expect(logged().join('\n')).toContain('unlocked: 2 entries')
  })

  it('a store made with another password is not readable with the default', async () => {
    await vaultCommand(['embed-add', 'Key', '--secret', SECRET])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Reflect.deleteProperty(process.env, 'MT_EMBED_PASSWORD')
    await expect(vaultCommand(['embed-add', 'Key2', '--secret', SECRET])).rejects.toThrow('EXIT 1')
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('wrong master password')
  })

  it('vault add can store an embed ref and keeps it on disk', async () => {
    const vaultPath = join(dir, 'vault.json')
    process.env.MT_VAULT = vaultPath
    await vaultCommand([
      'add',
      'or',
      '--provider',
      'openrouter',
      '--api-key',
      'embed:OpenRouter-Key',
      '--force',
    ])
    const stored = JSON.parse(await readFile(vaultPath, 'utf-8'))
    expect(stored.entries.or.apiKey).toBe('embed:OpenRouter-Key')
  })
  it('embed-rekey (file) then embed-rotate (value file) keep refs and never print values', async () => {
    const pwFile = join(dir, 'new.pw')
    const valFile = join(dir, 'value.txt')
    await writeFile(pwFile, 'brand-new-master\n', { mode: 0o600 })
    await writeFile(valFile, `${NEXT}\n`, { mode: 0o600 })
    await vaultCommand(['embed-add', 'Key', '--secret', SECRET])
    await vaultCommand(['embed-rekey', '--new-password-file', pwFile])
    expect((await stat(storePath)).mode & 0o777).toBe(0o600)

    await expect(vaultCommand(['embed-list'])).rejects.toThrow('EXIT 1')
    process.env.MT_EMBED_PASSWORD = 'brand-new-master'
    await vaultCommand(['embed-rotate', 'Key', '--value-file', valFile])
    vi.mocked(console.log).mockClear()
    await vaultCommand(['embed-list'])
    const out = logged().join('\n')
    expect(out).toContain('Key')
    expect(out).toContain('rotated')
    const all = [...logged(), ...vi.mocked(console.error).mock.calls.flat().map(String)].join('\n')
    for (const leaked of [SECRET, NEXT, 'brand-new-master']) expect(all).not.toContain(leaked)
  })

  it('embed-rekey with the same password and embed-rotate of a missing name fail', async () => {
    const pwFile = join(dir, 'same.pw')
    await writeFile(pwFile, MASTER)
    await vaultCommand(['embed-add', 'Key', '--secret', SECRET])
    await expect(vaultCommand(['embed-rekey', '--new-password-file', pwFile])).rejects.toThrow(
      'EXIT 1',
    )
    const valFile = join(dir, 'v.txt')
    await writeFile(valFile, NEXT)
    await expect(vaultCommand(['embed-rotate', 'Nope', '--value-file', valFile])).rejects.toThrow(
      'EXIT 1',
    )
    const errs = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(errs).toContain('identical')
    expect(errs).toContain('mt vault embed-add')
    expect(errs).not.toContain(NEXT)
  })

  it('embed-rotate rejects the value as a CLI argument', async () => {
    await vaultCommand(['embed-add', 'Key', '--secret', SECRET])
    await expect(vaultCommand(['embed-rotate', 'Key', '--secret', NEXT])).rejects.toThrow('EXIT 1')
  })
  it('embed-keyring manages encryption keys; secrets under different kids resolve', async () => {
    const keyFile = join(dir, 'enc.key')
    await writeFile(keyFile, `${'cd'.repeat(32)}\n`, { mode: 0o600 })
    await vaultCommand(['embed-add', 'One', '--secret', SECRET])
    await vaultCommand(['embed-keyring', 'add', '--kid', 'ops', '--enc-key-file', keyFile])
    await vaultCommand(['embed-add', 'Two', '--secret', NEXT])
    await vaultCommand(['embed-add', 'Three', '--secret', 'three', '--kid', 'k1'])
    await expect(vaultCommand(['embed-keyring', 'rm', 'k1'])).rejects.toThrow('EXIT 1')
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('still seals 2')

    vi.mocked(console.log).mockClear()
    await vaultCommand(['embed-keyring', 'rotate', '--reencrypt'])
    await vaultCommand(['embed-keyring', 'list'])
    await vaultCommand(['embed-list'])
    await vaultCommand(['embed-status'])
    await vaultCommand(['embed-keyring', 'rm', 'k1'])
    const out = logged().join('\n')
    expect(out).toContain('re-encrypted 3 secrets')
    expect(out).toContain('active: k2')
    for (const leaked of [SECRET, NEXT, 'cd'.repeat(32)]) expect(out).not.toContain(leaked)
  })
})
