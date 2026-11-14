import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadVault, resolveVaultRef } from '@mt/core'
import { afterEach, describe, expect, it } from 'vitest'

describe('vault from the nested sample run root', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('finds the repository vault above samples/sample2-practical', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sample2-vault-'))
    const repo = join(dir, 'repo')
    const run = join(repo, 'samples', 'sample2-practical')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(join(repo, '.mt'), { recursive: true })
    await mkdir(join(run, '.mt'), { recursive: true })
    await writeFile(
      join(repo, '.mt', 'vault.json'),
      JSON.stringify({
        version: 1,
        entries: { gpu: { provider: 'ollama', baseUrl: 'http://gpu:11434/v1' } },
      }),
    )

    const vault = await loadVault(run, { MT_HOME: join(dir, 'home') })

    expect(resolveVaultRef(vault, 'vault://gpu').entry.baseUrl).toBe('http://gpu:11434/v1')
  })
})
