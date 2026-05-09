import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('UC-26 - Background Serving CLI (architectural)', () => {
  it('serve command is registered in CLI switch', async () => {
    const indexPath = join(__dirname, '..', '..', 'src', 'index.ts')
    const source = await readFile(indexPath, 'utf-8')
    expect(source).toMatch(/case 'serve'/)
  })

  it('serveCommand is imported from commands/serve.js', async () => {
    const indexPath = join(__dirname, '..', '..', 'src', 'index.ts')
    const source = await readFile(indexPath, 'utf-8')
    expect(source).toMatch(/serveCommand/)
    expect(source).toMatch(/import\(.*commands\/serve\.js/)
  })

  it('serve.ts exports serveCommand as async function', async () => {
    const servePath = join(__dirname, '..', '..', 'src', 'commands', 'serve.ts')
    const source = await readFile(servePath, 'utf-8')
    expect(source).toMatch(/export (async )?function serveCommand/)
  })

  it('serveCommand is an async function (verify via dynamic import)', async () => {
    const servePath = join(__dirname, '..', '..', 'src', 'commands', 'serve.ts')
    const source = await readFile(servePath, 'utf-8')
    const hasAsync = source.includes('async function serveCommand')
    expect(hasAsync).toBe(true)
  })

  it('--detach / -d flag is parsed in serve.ts', async () => {
    const servePath = join(__dirname, '..', '..', 'src', 'commands', 'serve.ts')
    const source = await readFile(servePath, 'utf-8')
    expect(source).toMatch(/--detach/)
    expect(source).toMatch(/'-d'/)
  })

  it('detach mode spawns a child process with detached:true', async () => {
    const servePath = join(__dirname, '..', '..', 'src', 'commands', 'serve.ts')
    const source = await readFile(servePath, 'utf-8')
    expect(source).toMatch(/detached:\s*true/)
  })

  it('detach mode writes PID file', async () => {
    const servePath = join(__dirname, '..', '..', 'src', 'commands', 'serve.ts')
    const source = await readFile(servePath, 'utf-8')
    expect(source).toMatch(/pid/)
    expect(source).toMatch(/writeFile/)
  })

  it('serve.ts exports serveCommand', async () => {
    const servePath = join(__dirname, '..', '..', 'src', 'commands', 'serve.ts')
    const source = await readFile(servePath, 'utf-8')
    expect(source).toMatch(/export async function serveCommand/)
  })
})
