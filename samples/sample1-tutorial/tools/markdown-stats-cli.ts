#!/usr/bin/env tsx
import { runToolCli } from '@mt/core'
import { markdownStatsTool } from '@mt/tools'

process.exitCode = await runToolCli(markdownStatsTool)
