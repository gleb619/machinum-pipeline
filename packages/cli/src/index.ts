#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { initCommand } from './commands/init.js'
import { runCommand } from './commands/run.js'
import { resumeCommand } from './commands/resume.js'
import { listRunsCommand } from './commands/list.js'
import { inspectCommand } from './commands/inspect.js'
import { toolCommand } from './commands/tool.js'

export async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0] ?? ''

  switch (command) {
    case 'init':
      await initCommand(args.slice(1))
      break
    case 'run':
      await runCommand(args.slice(1))
      break
    case 'resume':
      await resumeCommand(args.slice(1))
      break
    case 'ls':
      if (args[1] === 'runs') {
        await listRunsCommand(args.slice(2))
      } else {
        console.error('Usage: mt ls runs')
        process.exit(1)
      }
      break
    case 'inspect':
      await inspectCommand(args.slice(1))
      break
    case 'tool':
      await toolCommand(args.slice(1))
      break
    case 'serve':
      console.error('mt serve — not yet implemented')
      process.exit(1)
    case 'router':
      console.error('mt router — not yet implemented')
      process.exit(1)
    case 'mcp':
      console.error('mt mcp — not yet implemented')
      process.exit(1)
    case '--help':
    case '-h':
    case '':
      console.log(`Mt — Pluggable document processing orchestration engine

Usage: mt <command> [options]

Commands:
  init                    Scaffold a new Mt project
  run <pipeline.ts>      Execute a pipeline (foreground)
  resume <runId>         Resume a paused/failed run
  ls runs                List all runs
  inspect <runId>        Show run details
  tool <name>            Invoke a tool standalone
  serve [-d|--detach]    Start admin backend
  router                 Start LLM router proxy
  mcp                    Start MCP server over stdio

Options:
  --help, -h             Show this help message
  --version, -v          Show version
`)
      break
    case '--version':
    case '-v':
      console.log('mt 0.1.0')
      break
    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run mt --help for usage information')
      process.exit(1)
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err: unknown) => {
    console.error('Fatal error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
