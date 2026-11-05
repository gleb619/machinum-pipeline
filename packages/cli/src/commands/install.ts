import { annotate, loadGlobalContext, readMtConfig, useCase } from '@mt/core'

// Ensure built-in sources/targets are registered before resolving URIs
import '@mt/waypoint'

import { runLifecycleScript } from './utils/lifecycle.js'

const USAGE = `Usage: mt install

Run the project's install lifecycle script (mt.json scripts.install) — a
pipeline module executed once for project setup.

Options:
  -h, --help          Show this help
`

interface InstallOptions {
  help: boolean
}

function fail(message: string): never {
  throw new Error(message)
}

function parseArgs(args: string[]): InstallOptions {
  const options: InstallOptions = { help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    switch (arg) {
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

annotate(
  installCommand,
  useCase('UC077', {
    name: 'Install mt without Docker',
    description:
      'Put the single-file mt binary on a machine with a verified download or build it from source.',
  }),
)

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
    logger: console,
  })
  console.log('Install script completed')
}
