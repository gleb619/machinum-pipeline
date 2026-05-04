import { type ChildProcess, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build, createNitro, prepare } from 'nitropack'

interface ServeOptions {
  port: number
  host: string
  detach: boolean
}

function parseArgs(args: string[]): ServeOptions {
  const options: ServeOptions = { port: 3000, host: 'localhost', detach: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      options.port = Number.parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--host' && i + 1 < args.length) {
      options.host = args[i + 1]
      i++
    } else if (args[i] === '-d' || args[i] === '--detach') {
      options.detach = true
    }
  }
  return options
}

async function detachServe(options: ServeOptions): Promise<void> {
  const rootDir = resolve(process.cwd(), 'packages', 'backend')

  const nitro = await createNitro({
    rootDir,
    dev: false,
    preset: 'node-server',
  })

  await prepare(nitro)
  await build(nitro)

  const entryPoint = join(process.cwd(), 'packages', 'backend', '.output', 'server', 'index.mjs')
  const backendDir = join(process.cwd(), '.mt', 'backend')
  await mkdir(backendDir, { recursive: true })

  const logStream = createWriteStream(join(backendDir, 'server.log'), { flags: 'a' })

  const child: ChildProcess = spawn('node', [entryPoint], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NITRO_PORT: String(options.port),
      NITRO_HOST: options.host,
    },
  })

  if (child.stdout) child.stdout.pipe(logStream)
  if (child.stderr) child.stderr.pipe(logStream)

  const { writeFile } = await import('node:fs/promises')
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

  const rootDir = resolve(process.cwd(), 'packages', 'backend')

  const nitro = await createNitro({
    rootDir,
    dev: true,
    preset: 'node-server',
  })

  await prepare(nitro)
  await build(nitro)

  console.log(`Backend listening on http://${options.host}:${options.port}`)
}
