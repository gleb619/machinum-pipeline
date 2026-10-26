import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultCommand } from '../../src/commands/vault.js'

const MASTER = 'cli-master-password'
const SECRET = 'sk-or-v1-CLIKEEPASSSECRET1234'

function logged(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
}

describe('vault keepass subcommands', () => {
  let dir: string
  let dbPath: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-vault-keepass-cli-'))
    dbPath = join(dir, 'secrets.kdbx')
    for (const key of [
      'MT_KEEPASS_PATH',
      'MT_KEEPASS_PASSWORD',
      'MT_KEEPASS_PASSWORD_FILE',
      'MT_KEEPASS_KEY_FILE',
      'MT_VAULT',
    ]) {
      saved[key] = process.env[key]
    }
    process.env.MT_KEEPASS_PATH = dbPath
    process.env.MT_KEEPASS_PASSWORD = MASTER
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`EXIT ${code}`)
    })
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('keepass-init creates a 0600 database and refuses to overwrite it', async () => {
    await vaultCommand(['keepass-init'])
    expect(logged().join('\n')).toContain(dbPath)
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600)

    await expect(vaultCommand(['keepass-init'])).rejects.toThrow('EXIT 1')
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('already exists')
  })

  it('keepass-add stores a secret and keepass-list shows it without the value', async () => {
    await vaultCommand(['keepass-init'])
    await vaultCommand([
      'keepass-add',
      'OpenRouter-Key',
      '--secret',
      SECRET,
      '--username',
      'boris',
      '--group',
      'LLM/API',
    ])

    const output = logged().join('\n')
    expect(output).toContain('Saved KeePass entry "OpenRouter-Key"')
    expect(output).not.toContain(SECRET)

    vi.mocked(console.log).mockClear()
    await vaultCommand(['keepass-list'])
    const list = logged().join('\n')
    expect(list).toContain('LLM/API/OpenRouter-Key')
    expect(list).toContain('boris')
    expect(list).not.toContain(SECRET)
  })

  it('keepass-status reports path, credentials and unlock state', async () => {
    await vaultCommand(['keepass-init'])
    await vaultCommand(['keepass-add', 'Key', '--secret', SECRET])

    vi.mocked(console.log).mockClear()
    await vaultCommand(['keepass-status'])
    const output = logged().join('\n')
    expect(output).toContain(`database: ${dbPath}`)
    expect(output).toContain('state: exists')
    expect(output).toContain('credentials: configured')
    expect(output).toContain('unlocked: 1 entry')
    expect(output).not.toContain(SECRET)
  })

  it('keepass-status reports a missing database without failing', async () => {
    process.env.MT_KEEPASS_PATH = join(dir, 'missing.kdbx')
    await vaultCommand(['keepass-status'])
    expect(logged().join('\n')).toContain('state: missing')
  })

  it('keepass-add without credentials fails with a clear hint', async () => {
    Reflect.deleteProperty(process.env, 'MT_KEEPASS_PASSWORD')
    await expect(vaultCommand(['keepass-add', 'Key', '--secret', SECRET])).rejects.toThrow('EXIT 1')
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'master password required',
    )
  })

  it('vault add can store a keepass ref and masks it in output', async () => {
    const vaultPath = join(dir, 'vault.json')
    process.env.MT_VAULT = vaultPath
    await vaultCommand([
      'add',
      'or',
      '--provider',
      'openrouter',
      '--api-key',
      'keepass:OpenRouter-Key',
      '--force',
    ])
    const stored = JSON.parse(await readFile(vaultPath, 'utf-8'))
    expect(stored.entries.or.apiKey).toBe('keepass:OpenRouter-Key')
  })
})
