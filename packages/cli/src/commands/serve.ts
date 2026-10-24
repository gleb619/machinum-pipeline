import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ServeOptions {
  port: number
  host: string
  detach: boolean
}

function parseArgs(args: string[]): ServeOptions {
  const options: ServeOptions = { port: 3000, host: 'localhost', detach: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      options.port = Number.parseInt(args[i + 1] as string, 10)
      i++
    } else if (args[i] === '--host' && i + 1 < args.length) {
      options.host = args[i + 1] as string
      i++
    } else if (args[i] === '-d' || args[i] === '--detach') {
      options.detach = true
    }
  }
  return options
}

/** Directory with the built admin UI (npm package `dist/ui`, or the monorepo frontend build). */
function findUiDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.MT_UI_DIR,
    join(here, '..', '..', 'ui'), // mt package: dist/cli/commands -> dist/ui
    join(here, '..', '..', '..', 'frontend', 'dist'), // monorepo: packages/cli/dist/commands
  ]
  return candidates.find((c): c is string => !!c && existsSync(join(c, 'index.html')))
}

async function detachServe(options: ServeOptions): Promise<void> {
  const backendDir = join(process.cwd(), '.mt', 'backend')
  await mkdir(backendDir, { recursive: true })
  const logStream = createWriteStream(join(backendDir, 'server.log'), { flags: 'a' })
  await new Promise<void>((r) => logStream.once('open', () => r()))

  // Re-run this same program in the foreground. Compiled Bun binary: execPath is the binary itself
  // (argv[1] is a virtual /$bunfs path); otherwise execPath is node/bun and argv[1] the script.
  const compiled = process.argv[1]?.startsWith('/$bunfs') === true
  const entry = compiled ? [] : [process.argv[1] as string]
  const child = spawn(
    process.execPath,
    [...entry, 'serve', '--port', String(options.port), '--host', options.host],
    { detached: true, stdio: ['ignore', logStream, logStream], env: process.env },
  )

  await writeFile(join(backendDir, 'pid'), String(child.pid ?? 0))
  child.unref()

  console.log(`Backend PID ${child.pid ?? 0}, logs at .mt/backend/server.log`)
}

export async function serveCommand(args: string[]): Promise<void> {
  const options = parseArgs(args)

  if (options.detach) {
    await detachServe(options)
    return
  }

  // Lazy: pulls h3 (+ better-sqlite3 under Node / bun:sqlite under Bun) only when serving.
  const { startBackend } = await import('@mt/backend/standalone')
  const uiDir = findUiDir()
  const handle = await startBackend({ port: options.port, host: options.host, uiDir })
  console.log(`Backend listening on ${handle.url}`)

  const shutdown = (): void => {
    handle.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
