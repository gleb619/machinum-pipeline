import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addEntry,
  emptyVault,
  isValidEntryName,
  isVaultProvider,
  removeEntry,
  saveVault,
} from '../src/vault.js'

const SECRET = 'sk-or-v1-SUPERSECRETVALUE1234'

describe('vault write helpers', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-vault-write-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('recognizes providers and entry names', () => {
    expect(isVaultProvider('ollama')).toBe(true)
    expect(isVaultProvider('nope')).toBe(false)
    expect(isValidEntryName('local')).toBe(true)
    expect(isValidEntryName('')).toBe(false)
    expect(isValidEntryName('a/b')).toBe(false)
  })

  it('adds entries without mutating the source vault', () => {
    const base = emptyVault()
    const next = addEntry(base, 'local', { provider: 'ollama', baseUrl: 'http://h/v1' })
    expect(base.entries).toEqual({})
    expect(next.entries.local?.provider).toBe('ollama')
  })

  it('replaces an existing entry on add', () => {
    const first = addEntry(emptyVault(), 'local', { provider: 'ollama' })
    const second = addEntry(first, 'local', { provider: 'openai' })
    expect(Object.keys(second.entries)).toEqual(['local'])
    expect(second.entries.local?.provider).toBe('openai')
  })

  it('rejects names with a slash and unknown providers', () => {
    expect(() => addEntry(emptyVault(), 'a/b', { provider: 'ollama' })).toThrow(/contain no "\/"/)
    expect(() => addEntry(emptyVault(), 'x', { provider: 'nope' as never })).toThrow(
      /provider" must be one of/,
    )
  })

  it('removes entries and rejects unknown names', () => {
    const vault = addEntry(emptyVault(), 'local', { provider: 'ollama', apiKey: SECRET })
    const next = removeEntry(vault, 'local')
    expect(next.entries).toEqual({})
    expect(vault.entries.local?.apiKey).toBe(SECRET)
    expect(() => removeEntry(vault, 'nope')).toThrow(/Unknown vault entry "nope"/)
  })

  it('saves atomically with mode 0600', async () => {
    const path = join(dir, 'nested', 'vault.json')
    await saveVault(path, addEntry(emptyVault(), 'local', { provider: 'ollama', apiKey: SECRET }))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(dir, 'nested'))).toEqual(['vault.json'])
  })
})
