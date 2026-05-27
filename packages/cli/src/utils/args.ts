import type { InitOptions, Settings } from '../commands/init.js'

/**
 * Parse command-line arguments for `mt init`.
 *
 * Supports:
 *   mt init [projectName]
 *   mt init [projectName] --settings <json>
 *   mt init [projectName] -s <json>
 */
export function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--settings' || arg === '-s') {
      const jsonStr = args[++i]
      if (!jsonStr || jsonStr.startsWith('-')) {
        console.error('Error: --settings requires a JSON argument')
        process.exit(1)
      }
      try {
        options.settings = JSON.parse(jsonStr) as Settings
      } catch {
        console.error(`Error: Invalid JSON for --settings: ${jsonStr}`)
        process.exit(1)
      }
    } else if (!arg.startsWith('-')) {
      // First non-flag argument is the project name
      options.projectName = arg
    }
  }

  return options
}
