import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGlobalContext } from '@mt/core'

interface RouterOptions {
  port?: number
  host?: string
  mock?: boolean
  logDir?: string
  detach: boolean
  help: boolean
}

const USAGE = `Usage: mt router [options]

Start the OpenRouter proxy and its dashboard.

Options:
  --port <n>        Listen port (default 7777, or mt.json router.port; 0 picks a free port)
  --host <host>     Bind host (default: localhost)
  --mock            Deterministic responses, no upstream calls (no API keys needed)
  --log-dir <dir>   Cost-log directory (default: ~/.mt/router)
  -d, --detach      Run in the background (PID + logs under .mt/router/)
  --help, -h        Show this help
`

function parseArgs(args: string[]): RouterOptions {
  const options: RouterOptions = { detach: false, help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--port' && i + 1 < args.length) {
      options.port = Number.parseInt(args[i + 1] as string, 10)
      i++
    } else if (arg === '--host' && i + 1 < args.length) {
      options.host = args[i + 1] as string
      i++
    } else if (arg === '--log-dir' && i + 1 < args.length) {
      options.logDir = args[i + 1] as string
      i++
    } else if (arg === '--mock') {
      options.mock = true
    } else if (arg === '-d' || arg === '--detach') {
      options.detach = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    }
  }
  return options
}

/** Flags to re-pass to the detached child; undefined options keep falling back to env/config. */
function forwardArgs(options: RouterOptions): string[] {
  const args: string[] = []
  if (options.port !== undefined) args.push('--port', String(options.port))
  if (options.host) args.push('--host', options.host)
  if (options.logDir) args.push('--log-dir', options.logDir)
  if (options.mock) args.push('--mock')
  return args
}

/** Dashboard assets: npm package `dist/router-ui`, or the monorepo `packages/router/public`. */
function findDashboardDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.MT_ROUTER_UI_DIR,
    join(here, '..', '..', 'router-ui'), // mt package: dist/cli/commands -> dist/router-ui
    join(here, '..', '..', '..', 'router', 'public'), // monorepo: packages/cli/dist/commands
  ]
  return candidates.find((c): c is string => !!c && existsSync(join(c, 'index.html')))
}

async function detachRouter(options: RouterOptions): Promise<void> {
  const routerDir = join(process.cwd(), '.mt', 'router')
  await mkdir(routerDir, { recursive: true })
  const logStream = createWriteStream(join(routerDir, 'server.log'), { flags: 'a' })
  await new Promise<void>((r) => logStream.once('open', () => r()))

  // Re-run this same program in the foreground. Compiled Bun binary: execPath is the binary itself
  // (argv[1] is a virtual /$bunfs path); otherwise execPath is node/bun and argv[1] the script.
  const compiled = process.argv[1]?.startsWith('/$bunfs') === true
  const entry = compiled ? [] : [process.argv[1] as string]
  const child = spawn(process.execPath, [...entry, 'router', ...forwardArgs(options)], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: process.env,
  })

  await writeFile(join(routerDir, 'pid'), String(child.pid ?? 0))
  child.unref()

  console.log(`Router PID ${child.pid ?? 0}, logs at .mt/router/server.log`)
}

export async function routerCommand(args: string[]): Promise<void> {
  const options = parseArgs(args)
  if (options.help) {
    console.log(USAGE)
    return
  }

  if (options.detach) {
    await detachRouter(options)
    return
  }

  // Lazy: pulls h3 (and @mt/tools) only when serving, so the CLI starts without the router runtime.
  const { startRouter } = await import('@mt/router/standalone')

  // Secrets come from mt.json -> secrets.envFile; process.env already wins over the file.
  const globalContext = await loadGlobalContext(process.cwd())
  const rawKeys =
    globalContext.env.OPENROUTER_API_KEYS ?? globalContext.env.OPENROUTER_API_KEY ?? ''
  const apiKeys = rawKeys
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)

  const handle = await startRouter({
    port: options.port,
    host: options.host,
    mock: options.mock,
    logDir: options.logDir,
    apiKeys,
    dashboardDir: findDashboardDir(),
  })
  console.log(`Router listening on ${handle.url}${handle.mock ? ' (mock mode)' : ''}`)

  const shutdown = (): void => {
    handle.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
