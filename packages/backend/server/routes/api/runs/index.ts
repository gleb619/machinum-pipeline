import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineEventHandler } from 'h3'

interface RunInfo {
  id: string
  state: string
  started?: string
}

export default defineEventHandler(async () => {
  const runsDir = join(process.cwd(), '.mt', 'runs')
  try {
    const entries = await readdir(runsDir, { withFileTypes: true })
    const runs: RunInfo[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const statePath = join(runsDir, entry.name, 'state.json')
        try {
          const stateRaw = await readFile(statePath, 'utf-8')
          const state = JSON.parse(stateRaw)
          runs.push({
            id: entry.name,
            state: state.state || 'unknown',
            started: state.started,
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
