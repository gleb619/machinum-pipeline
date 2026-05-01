import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CheckpointNode, RunStateData } from '@mt/core'

/**
 * `mt inspect <runId>` — show detailed information about a run.
 */
export async function inspectCommand(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: mt inspect <runId>')
    process.exit(1)
    return
  }

  const runId = args[0] as string
  const statePath = join(process.cwd(), '.mt', 'runs', runId, 'state.json')

  try {
    const content = await readFile(statePath, 'utf-8')
    const stateData = JSON.parse(content) as RunStateData

    console.log(`\n\uD83D\uDD0D Inspecting Run: ${stateData.runId}`)
    console.log('--------------------------------------------------')
    console.log(`Pipeline:  ${stateData.pipelineId}`)
    console.log(`State:     ${stateData.state.toUpperCase()}`)
    console.log(`Started:   ${new Date(stateData.startedAt).toLocaleString()}`)
    console.log(`Updated:   ${new Date(stateData.updatedAt).toLocaleString()}`)
    console.log('--------------------------------------------------\n')

    console.log('Checkpoint Tree:')
    printCheckpointTree(stateData.checkpoint)

    // Optional: Events/Logs summary could go here if implemented
    const logPath = join(process.cwd(), '.mt', 'runs', runId, 'run.log')
    try {
      // Check if run.log exists in the run directory (though currently it's global,
      // we might want to support per-run logs as per docs)
      const logContent = await readFile(logPath, 'utf-8')
      const lines = logContent.trim().split('\n')
      const lastLines = lines.slice(-5)
      console.log('\nLast Log Entries:')
      for (const line of lastLines) console.log(`  ${line}`)
    } catch {
      // Ignore if log not found
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`Error: Run "${runId}" not found.`)
    } else {
      console.error(`Error inspecting run ${runId}:`, err)
    }
    process.exit(1)
    return
  }
}

function printCheckpointTree(node: CheckpointNode, depth = 0): void {
  const indent = '  '.repeat(depth)
  const statusIcon = getStatusIcon(node.state)
  const errorSuffix = node.error ? ` (Error: ${node.error})` : ''

  console.log(`${indent}${statusIcon} ${node.stepId}${errorSuffix}`)

  if (node.children) {
    for (const child of node.children) {
      printCheckpointTree(child, depth + 1)
    }
  }
}

function getStatusIcon(state: string): string {
  switch (state) {
    case 'done':
      return '✅'
    case 'in-progress':
      return '⏳'
    case 'failed':
      return '❌'
    case 'pending':
      return '◻️'
    default:
      return '❓'
  }
}
