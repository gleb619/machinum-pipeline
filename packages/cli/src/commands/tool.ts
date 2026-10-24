import { readFileSync } from 'node:fs'

/**
 * Executes a tool standalone.
 * Reads JSON envelope from stdin, invokes tool, writes JSON result to stdout.
 */
export async function toolCommand(args: string[]): Promise<void> {
  const toolName = args[0]
  if (!toolName) {
    console.error('Usage: mt tool <name>')
    process.exit(1)
  }

  // NOTE: This assumes tools are discoverable/imported into a global registry.
  // In v1, this may require a dynamic import or registry pre-registration.

  // Read stdin for the envelope
  const input = readFileSync(0, 'utf8')
  const _envelope = JSON.parse(input)

  console.error(`Tool ${toolName} not yet fully implemented for dynamic discovery.`)
  process.exit(1)
}
