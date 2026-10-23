import { realpathSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * mt-worker — child-process entry point for out-of-process Mt tools.
 *
 * Usage: `<runtime> <runtime argv> worker <module> <toolName>`
 *   - bun:  `bun run  worker <module> <toolName>`
 *   - deno: `deno run -A worker <module> <toolName>`
 *   - npx:  `npx tsx  worker <module> <toolName>`
 *
 * Protocol — NDJSON over stdio, identical for one-shot and streaming runs:
 *   stdin  line 1: `{"type":"init","toolContext":{...}}` (optional, carries ToolContext)
 *   stdin  line N: `<Envelope>`
 *   stdout line N: `<Envelope>` on success, `{"error":"..."}` on failure
 *
 * This file is standalone on purpose: it imports nothing from the package, so
 * bun/deno/tsx can execute it without resolving workspace dependencies. The
 * tool module is imported by specifier and may itself import `@mt/core`.
 */

/** Minimal shape the worker needs from a tool — the rest of `Tool` is irrelevant here. */
interface WorkerTool {
  name: string
  invoke(envelope: unknown, ctx: unknown): Promise<unknown>
}

const OUT = process.stdout

/** Emit a worker error line and exit non-zero. */
function fail(message: string): never {
  OUT.write(`${JSON.stringify({ error: message })}\n`)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** True when a module export looks like a tool. */
function isTool(value: unknown): value is WorkerTool {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof (value as { invoke?: unknown }).invoke === 'function'
  )
}

/** Resolve a file path (or file URL) to an importable specifier. */
function toSpecifier(module: string): string {
  if (module.startsWith('file://')) return module
  return pathToFileURL(module).href
}

/**
 * Find `toolName` among a module's exports.
 *
 * Accepted shapes, in any order:
 *   1. `export default defineTool({ name })`
 *   2. any named export whose `Tool.name` matches (key name may differ)
 *   3. `export const tools = { [name]: tool }` — record of tools, one level deep
 *
 * Throws when the tool is absent — `main` turns that into a worker error line.
 */
export function pickTool(mod: Record<string, unknown>, toolName: string): WorkerTool {
  const direct: WorkerTool[] = []
  for (const value of Object.values(mod)) {
    if (isTool(value)) {
      if (value.name === toolName) return value
      direct.push(value)
    }
  }
  // One level into exported records (`export const tools = { ... }`).
  for (const value of Object.values(mod)) {
    if (!value || typeof value !== 'object') continue
    const nested = (value as Record<string, unknown>)[toolName]
    if (isTool(nested)) return nested
  }

  const exported = Object.keys(mod).join(', ') || '(none)'
  throw new Error(
    `Tool '${toolName}' not found in module exports [${exported}]. ` +
      `Export it as \`export default defineTool({ name: '${toolName}' })\` or under the name '${toolName}'.`,
  )
}

/** Async-iterate stdin line by line, across Node, bun and deno. */
async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) yield line
    }
  }
  if (buffer.trim()) yield buffer
}

/**
 * Worker main loop: read the init line, then invoke the tool per envelope.
 */
export async function main(argv: string[]): Promise<void> {
  const [moduleArg, toolName] = argv

  if (!moduleArg || !toolName) {
    fail('Usage: mt-worker <module> <toolName>')
  }

  let mod: Record<string, unknown>
  try {
    mod = (await import(toSpecifier(moduleArg))) as Record<string, unknown>
  } catch (error) {
    fail(`Cannot import tool module '${moduleArg}': ${errorMessage(error)}`)
  }

  let tool: WorkerTool
  try {
    tool = pickTool(mod, toolName)
  } catch (error) {
    fail(errorMessage(error))
  }

  let toolContext: unknown = { run: undefined, step: undefined }

  for await (const line of readLines()) {
    let message: { type?: string; toolContext?: unknown }
    try {
      message = JSON.parse(line) as { type?: string; toolContext?: unknown }
    } catch (error) {
      fail(`Invalid NDJSON on stdin: ${errorMessage(error)}`)
    }

    // Init line: the parent hands over the ToolContext before any envelope.
    if (message.type === 'init') {
      toolContext = message.toolContext ?? toolContext
      continue
    }

    try {
      const result = await tool.invoke(message, toolContext)
      OUT.write(`${JSON.stringify(result ?? null)}\n`)
    } catch (error) {
      fail(`Tool '${toolName}' threw: ${errorMessage(error)}`)
    }
  }

  process.exit(0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

// Only run when executed as the entry script — importing this file (e.g. in
// tests) must not start the loop. `argv[1]` may be a symlink (a `mt-worker`
// bin), while `import.meta.url` is always resolved, so compare real paths.
function isEntryScript(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return import.meta.url === pathToFileURL(entry).href
  }
}

if (isEntryScript()) {
  main(process.argv.slice(2)).catch((error: unknown) => fail(errorMessage(error)))
}
