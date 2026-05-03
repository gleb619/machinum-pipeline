import type { Envelope } from '../types.js'
import type { Store } from '../store.js'

/**
 * Dead-letter entry written to .mt/runs/<runId>/dead-letter.jsonl
 */
export interface DeadLetterEntry {
  timestamp: string
  envelope: Envelope<unknown>
  error: {
    message: string
    name: string
  }
  stepId: string
}

/**
 * Write a dead-letter entry to the dead-letter queue.
 * Uses atomic file writes via Store.appendLines().
 *
 * @param store - The store instance for .mt operations
 * @param runId - The current run ID
 * @param envelope - The envelope that failed
 * @param error - The error that caused the failure
 * @param stepId - The step ID where failure occurred
 */
export async function writeDeadLetter(
  store: Store,
  runId: string,
  envelope: Envelope<unknown>,
  error: Error,
  stepId: string
): Promise<void> {
  const entry: DeadLetterEntry = {
    timestamp: new Date().toISOString(),
    envelope,
    error: {
      message: error.message,
      name: error.name,
    },
    stepId,
  }

  await store.ensureDir('runs', runId)
  await store.append(JSON.stringify(entry) + '\n', 'runs', runId, 'dead-letter.jsonl')
}