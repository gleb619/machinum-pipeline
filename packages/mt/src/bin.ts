#!/usr/bin/env node
import { main } from '@mt/cli'
import { registerEmbeddedModules } from './embed.js'

registerEmbeddedModules()

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
