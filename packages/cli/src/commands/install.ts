import { loadGlobalContext, readMtConfig } from '@mt/core'

// Ensure built-in sources/targets are registered before resolving URIs
import '@mt/waypoint'

import { runLifecycleScript } from './utils/lifecycle.js'

const USAGE = `Usage: mt install [--pipeline <name>]

Run the project's install lifecycle script (mt.json scripts.install) — a
pipeline module executed once for project setup.

Options:
  --pipeline <name>   Named export to run instead of the default export
  -h, --help          Show this help
`

interface InstallOptions {
  help: boolean
  pipelineName?: string
}

function fail(message: string): never {
  throw new Error(message)
}

function parseArgs(args: string[]): InstallOptions {
  const options: InstallOptions = { help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    switch (arg) {
      case '--pipeline': {
        const value = args[i + 1]
        if (value === undefined) fail('Option --pipeline requires a value')
        options.pipelineName = value
        i++
        break
      }
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        if (arg.startsWith('-')) fail(`Unknown option: ${arg}`)
        fail(`Unexpected argument: ${arg}\n\n${USAGE}`)
    }
  }
  return options
}

/**
 * `mt install` — execute the `scripts.install` pipeline from mt.json.
 */
export async function installCommand(args: string[]): Promise<void> {
  try {
    await dispatch(args)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

async function dispatch(args: string[]): Promise<void> {
  const options = parseArgs(args)
  if (options.help) {
    console.log(USAGE)
    return
  }

  const projectRoot = process.cwd()
  const config = await readMtConfig(projectRoot)
  if (!config.scripts?.install) {
    fail('no scripts.install defined in mt.json')
  }

  const ctx = await loadGlobalContext(projectRoot)
  await runLifecycleScript(ctx, 'install', {
    pipelineName: options.pipelineName,
    logger: console,
  })
  console.log('Install script completed')
}
