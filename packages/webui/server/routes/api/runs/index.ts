import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunStateData } from '@mt/core'
import { defineEventHandler } from 'h3'
import { serveRootOf } from '../../../utils/sync-root.js'

interface RunInfo {
  id: string
  state: string
  started?: string
}

export default defineEventHandler(async (event) => {
  const runsDir = join(serveRootOf(event), '.mt', 'runs')
  try {
    const entries = await readdir(runsDir, { withFileTypes: true })
    const runs: RunInfo[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const statePath = join(runsDir, entry.name, 'state.json')
        try {
          const stateRaw = await readFile(statePath, 'utf-8')
          const state = JSON.parse(stateRaw) as RunStateData
          runs.push({
            id: entry.name,
            state: state.state || 'unknown',
            started: state.startedAt,
          })
        } catch {
          runs.push({ id: entry.name, state: 'unknown' })
        }
      }
    }
    return runs
  } catch {
    return []
  }
})
