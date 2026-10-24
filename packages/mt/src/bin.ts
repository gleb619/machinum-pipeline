#!/usr/bin/env node
import { main } from '@mt/cli'
import { setPipelineModuleLoader } from '@mt/core'
import { registerEmbeddedModules } from './embed.js'
import { importPipelineModule } from './pipeline-loader.js'

registerEmbeddedModules()
// Pipelines are loaded with per-importer resolution: the project's own copy of a library wins
// over the copy embedded in the binary.
setPipelineModuleLoader(importPipelineModule)

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
