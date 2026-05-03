import { resolve } from 'node:path'
import { build, createNitro, prepare } from 'nitropack'

interface ServeOptions {
  port: number
  host: string
}

function parseArgs(args: string[]): ServeOptions {
  const options: ServeOptions = { port: 3000, host: 'localhost' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      options.port = Number.parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--host' && i + 1 < args.length) {
      options.host = args[i + 1]
      i++
    }
  }
  return options
}

export async function serveCommand(args: string[]): Promise<void> {
  const options = parseArgs(args)
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
