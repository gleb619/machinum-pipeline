import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultCommand } from '../../src/commands/vault.js'

const MASTER = 'cli-embed-master-password'
const SECRET = 'sk-or-v1-CLIEMBEDSECRET1234'

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

  it('embed-add without credentials fails with a clear hint', async () => {
    await vaultCommand(['embed-init'])
    Reflect.deleteProperty(process.env, 'MT_EMBED_PASSWORD')
    await expect(vaultCommand(['embed-add', 'Key', '--secret', SECRET])).rejects.toThrow('EXIT 1')
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'master password required',
    )
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
})
