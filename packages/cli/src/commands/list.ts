import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunStateData } from '@mt/core'

/**
 * `mt ls runs` — list all runs.
 */
export async function listRunsCommand(_args: string[]): Promise<void> {
  const runsDir = join(process.cwd(), '.mt', 'runs')
  
  try {
    const runIds = await readdir(runsDir)
    const runs: RunStateData[] = []

    for (const runId of runIds) {
      const statePath = join(runsDir, runId, 'state.json')
      try {
        const content = await readFile(statePath, 'utf-8')
        const stateData = JSON.parse(content) as RunStateData
        runs.push(stateData)
      } catch (err) {
        console.error(`Error reading state for run ${runId}:`, err)
      }
    }

    if (runs.length === 0) {
      console.log('No runs found.')
      return
    }

    // Sort by start time descending
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())

    console.table(
      runs.map((r) => ({
        RunID: r.runId,
        Pipeline: r.pipelineId,
        State: r.state,
        Started: new Date(r.startedAt).toLocaleString(),
      })),
    )
  } catch (err) {
    if ((err as any).code === 'ENOENT') {
      console.log('No runs found.')
    } else {
      console.error('Error listing runs:', err)
      process.exit(1)
    }
  }
}
