#!/usr/bin/env node
import { formatLogLine } from '@mt/core'
import { runBrowserTranslateServerCli } from '@mt/tools'

runBrowserTranslateServerCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(formatLogLine('error', `Fatal error: ${message}`))
  process.exit(1)
})
