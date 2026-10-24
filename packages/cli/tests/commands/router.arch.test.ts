import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = async (...parts: string[]): Promise<string> =>
  readFile(join(__dirname, '..', '..', ...parts), 'utf-8')

describe('T086 - mt router CLI (architectural)', () => {
  it('router command is registered in the CLI switch', async () => {
    expect(await source('src', 'index.ts')).toMatch(/case 'router'/)
  })

  it('routerCommand is lazily imported from commands/router.js', async () => {
    const index = await source('src', 'index.ts')
    expect(index).toMatch(/routerCommand/)
    expect(index).toMatch(/import\(.*commands\/router\.js/)
  })

  it('reaches @mt/router only through the standalone entry point, dynamically', async () => {
    const router = await source('src', 'commands', 'router.ts')
    expect(router).toMatch(/await import\('@mt\/router\/standalone'\)/)
    expect(router).toMatch(/export async function routerCommand/)
  })

  it('parses --port / --mock / --log-dir / --detach', async () => {
    const router = await source('src', 'commands', 'router.ts')
    for (const flag of ['--port', '--mock', '--log-dir', '--detach', "'-d'"]) {
      expect(router).toContain(flag)
    }
  })

  it('detaches by re-executing the same program with a pid file and log', async () => {
    const router = await source('src', 'commands', 'router.ts')
    expect(router).toMatch(/detached:\s*true/)
    expect(router).toMatch(/\$bunfs/)
    expect(router).toMatch(/writeFile\(join\(routerDir, 'pid'\)/)
    expect(router).toMatch(/server\.log/)
  })

  it('documents the command in mt --help', async () => {
    expect(await source('src', 'index.ts')).toMatch(/router \[opts\]/)
  })
})
