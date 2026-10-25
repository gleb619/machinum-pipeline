import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultCommand } from '../../src/commands/vault.js'

const SECRET = 'sk-or-v1-SUPERSECRETVALUE1234'

/** Everything console.log printed during the test. */
function logged(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
}

/** Everything console.error printed during the test. */
function errored(): string[] {
  return vi.mocked(console.error).mock.calls.map((call) => String(call[0]))
}

describe('vault command', () => {
  let testDir: string
  let home: string
  let originalCwd: string
  let originalHome: string | undefined
  let originalMtHome: string | undefined
  let originalVault: string | undefined

  const projectVault = (): string => join(testDir, '.mt', 'vault.json')
  const userVault = (): string => join(home, '.mt', 'vault.json')

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-vault-cli-'))
    home = join(testDir, 'home')
    originalCwd = process.cwd()
    originalHome = process.env.HOME
    originalMtHome = process.env.MT_HOME
    originalVault = process.env.MT_VAULT

    process.chdir(testDir)
    process.env.HOME = home
    process.env.MT_HOME = join(home, '.mt')
    Reflect.deleteProperty(process.env, 'MT_VAULT')

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`EXIT ${code}`)
    })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'HOME')
    else process.env.HOME = originalHome
    if (originalMtHome === undefined) Reflect.deleteProperty(process.env, 'MT_HOME')
    else process.env.MT_HOME = originalMtHome
    if (originalVault === undefined) Reflect.deleteProperty(process.env, 'MT_VAULT')
    else process.env.MT_VAULT = originalVault
    await rm(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('init creates an empty project vault with mode 0600', async () => {
    await vaultCommand(['init'])

    const content = JSON.parse(await readFile(projectVault(), 'utf-8'))
    expect(content).toEqual({ version: 1, entries: {} })
    expect((await stat(projectVault())).mode & 0o777).toBe(0o600)
  })

  it('init is idempotent and does not drop existing entries', async () => {
    await vaultCommand(['init'])
    await vaultCommand(['add', 'x', '--provider', 'ollama'])

    await vaultCommand(['init'])

    const content = JSON.parse(await readFile(projectVault(), 'utf-8'))
    expect(Object.keys(content.entries)).toEqual(['x'])
  })

  it('init adds the vault gitignore patterns', async () => {
    await vaultCommand(['init'])
    const gitignore = await readFile(join(testDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.mt/')
    expect(gitignore).toContain('vault.json')
    expect(gitignore).toContain('*.vault.json')
    expect(gitignore).toContain('.mt/vault*')
  })

  it('add stores the entry in the project vault', async () => {
    await vaultCommand([
      'add',
      'local',
      '--provider',
      'ollama',
      '--base-url',
      'http://host:11434/v1',
      '--models',
      'a,b',
      '--default-model',
      'a',
      '--notes',
      'test entry',
    ])

    const content = JSON.parse(await readFile(projectVault(), 'utf-8'))
    expect(content.entries.local).toEqual({
      provider: 'ollama',
      baseUrl: 'http://host:11434/v1',
      models: ['a', 'b'],
      defaultModel: 'a',
      notes: 'test entry',
    })
  })

  it('add writes to the user vault with --user', async () => {
    await vaultCommand(['add', 'local', '--provider', 'ollama', '--user'])

    const content = JSON.parse(await readFile(userVault(), 'utf-8'))
    expect(content.entries.local?.provider).toBe('ollama')
    await expect(readFile(projectVault(), 'utf-8')).rejects.toThrow()
  })

  it('add refuses to overwrite without --force', async () => {
    await vaultCommand(['add', 'local', '--provider', 'ollama'])
    await expect(vaultCommand(['add', 'local', '--provider', 'openai'])).rejects.toThrow('EXIT 1')
    expect(errored().join('\n')).toContain('already exists')

    await vaultCommand(['add', 'local', '--provider', 'openai', '--force'])
    const content = JSON.parse(await readFile(projectVault(), 'utf-8'))
    expect(content.entries.local?.provider).toBe('openai')
  })

  it('add rejects names with a slash and unknown providers', async () => {
    await expect(vaultCommand(['add', 'a/b', '--provider', 'ollama'])).rejects.toThrow('EXIT 1')
    expect(errored().join('\n')).toContain('contain no "/"')

    await expect(vaultCommand(['add', 'x', '--provider', 'nope'])).rejects.toThrow('EXIT 1')
    expect(errored().join('\n')).toContain('Unknown provider "nope"')
  })

  it('list shows name, provider, base URL and model count', async () => {
    await vaultCommand([
      'add',
      'local',
      '--provider',
      'ollama',
      '--base-url',
      'http://host:11434/v1',
      '--models',
      'a,b',
    ])

    await vaultCommand(['list'])

    const line = logged().find((entry) => entry.includes('2 models'))
    expect(line).toBeDefined()
    expect(line).toContain('local')
    expect(line).toContain('ollama')
    expect(line).toContain('http://host:11434/v1')
  })

  it('list reports an empty vault', async () => {
    await vaultCommand(['list'])
    expect(logged().join('\n')).toContain('Vault is empty')
  })

  it('show masks the API key', async () => {
    await vaultCommand(['add', 'local', '--provider', 'openrouter', '--api-key', SECRET])

    await vaultCommand(['show', 'local'])

    const output = logged().join('\n')
    expect(output).not.toContain(SECRET)
    expect(output).not.toContain('SUPERSECRET')
    expect(output).toContain('1234')
  })

  it('show --reveal prints the raw API key', async () => {
    await vaultCommand(['add', 'local', '--provider', 'openrouter', '--api-key', SECRET])

    await vaultCommand(['show', 'local', '--reveal'])

    expect(logged().join('\n')).toContain(SECRET)
  })

  it('show fails for an unknown entry', async () => {
    await expect(vaultCommand(['show', 'nope'])).rejects.toThrow('EXIT 1')
    expect(errored().join('\n')).toContain('Unknown vault entry "nope"')
  })

  it('rm removes the entry from the project vault', async () => {
    await vaultCommand(['add', 'local', '--provider', 'ollama'])
    await vaultCommand(['rm', 'local'])

    const content = JSON.parse(await readFile(projectVault(), 'utf-8'))
    expect(content.entries).toEqual({})
  })

  it('rm removes an entry that lives in the user vault', async () => {
    await vaultCommand(['add', 'local', '--provider', 'ollama', '--user'])
    await vaultCommand(['rm', 'local'])

    const content = JSON.parse(await readFile(userVault(), 'utf-8'))
    expect(content.entries).toEqual({})
  })

  it('rm fails for an unknown entry', async () => {
    await expect(vaultCommand(['rm', 'nope'])).rejects.toThrow('EXIT 1')
    expect(errored().join('\n')).toContain('Unknown vault entry "nope"')
  })

  it('path prints the resolved paths and whether they exist', async () => {
    await vaultCommand(['init'])

    await vaultCommand(['path'])

    const output = logged().join('\n')
    expect(output).toContain(userVault())
    expect(output).toContain(projectVault())
    expect(output).toContain('exists')
    expect(output).toContain('missing')
  })

  it('honours MT_VAULT as the only vault path', async () => {
    const custom = join(testDir, 'custom-vault.json')
    process.env.MT_VAULT = custom

    await vaultCommand(['add', 'local', '--provider', 'ollama'])

    const content = JSON.parse(await readFile(custom, 'utf-8'))
    expect(content.entries.local?.provider).toBe('ollama')
  })

  it('never prints a raw key in the add confirmation', async () => {
    await vaultCommand(['add', 'local', '--provider', 'openrouter', '--api-key', SECRET])

    expect(logged().join('\n')).not.toContain(SECRET)
  })

  it('rejects an unknown subcommand', async () => {
    await expect(vaultCommand(['bogus'])).rejects.toThrow('EXIT 1')
    expect(errored().join('\n')).toContain('Unknown vault subcommand: bogus')
  })

  it('reads entries written directly into the vault file', async () => {
    await vaultCommand(['init'])
    await writeFile(
      projectVault(),
      JSON.stringify({ version: 1, entries: { manual: { provider: 'openai' } } }),
      'utf-8',
    )

    await vaultCommand(['list'])

    expect(logged().join('\n')).toContain('manual')
  })
})
