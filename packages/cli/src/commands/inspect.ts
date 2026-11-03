import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CheckpointNode, DeadLetterEntry, RunStateData } from '@mt/core'
import { annotate, useCase } from '@mt/core'

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

    // The CLI writes each run's log to .mt/runs/<runId>/run.log
    const logPath = join(process.cwd(), '.mt', 'runs', runId, 'run.log')
    try {
      const logContent = await readFile(logPath, 'utf-8')
      const lines = logContent.trim().split('\n')
      const lastLines = lines.slice(-5)
      console.log('\nLast Log Entries:')
      for (const line of lastLines) {
        console.log(`  ${line}`)
      }
    } catch {
      // Ignore if log not found
    }

    // Dead letters: the envelopes the `dead-letter` error policy dropped. A run can
    // end DONE after dropping items, so this queue is the only trace of them.
    await printDeadLetters(join(process.cwd(), '.mt', 'runs', runId, 'dead-letter.jsonl'))
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

annotate(
  inspectCommand,
  useCase('UC009', {
    name: 'Inspect a Run',
    description: 'View state, checkpoint tree, and recent log entries for a Run.',
  }),
)

/**
 * Parse a dead-letter queue: one JSON object per line. A malformed line (the queue
 * is append-only, a crash can truncate the last one) is skipped, not fatal.
 */
function parseDeadLetters(content: string): DeadLetterEntry[] {
  const entries: DeadLetterEntry[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<DeadLetterEntry>
      if (!parsed || typeof parsed !== 'object') continue
      entries.push({
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : 'unknown time',
        stepId: typeof parsed.stepId === 'string' ? parsed.stepId : 'unknown step',
        error: {
          message: parsed.error?.message ?? 'unknown error',
          name: parsed.error?.name ?? 'Error',
        },
        envelope: parsed.envelope ?? { id: 'unknown', variables: [] },
      })
    } catch {
      // Skip the malformed line.
    }
  }
  return entries
}

/** Compact description of the dropped envelope: its id and the persisted variables. */
function describeEnvelope(entry: DeadLetterEntry): string {
  const variables = (entry.envelope?.variables ?? []).filter((variable) => !variable.ephemeral)
  const parts = [`exchange ${entry.envelope?.id ?? 'unknown'}`]
  for (const variable of variables.slice(0, 3)) {
    const value =
      typeof variable.value === 'string' ? variable.value : JSON.stringify(variable.value)
    parts.push(`${variable.name}=${value}`)
  }
  return ` (${parts.join(', ')})`
}

/**
 * Print the dead-letter queue of a run: how many envelopes were dropped and the
 * last few entries (step, error, envelope). Nothing is printed when the run has
 * no dead letters.
 */
async function printDeadLetters(path: string): Promise<void> {
  let content: string
  try {
    content = await readFile(path, 'utf-8')
  } catch {
    // No dead-letter queue for this run.
    return
  }

  const entries = parseDeadLetters(content)
  if (entries.length === 0) return

  console.log(`\nDead letters: ${entries.length}`)
  for (const entry of entries.slice(-3)) {
    console.log(
      `  [${entry.timestamp}] ${entry.stepId}: ${entry.error.message}${describeEnvelope(entry)}`,
    )
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
