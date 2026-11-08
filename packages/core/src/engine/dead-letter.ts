import { toPersisted } from '../exchange.js'
import type { Store } from '../store.js'
import type { DeadLetterEntry, Envelope, PersistedExchange } from '../types.js'

/**
 * Write a dead-letter entry to the dead-letter queue.
 * Appends to the append-only dead-letter queue via Store.append() (non-atomic by design, see store.ts).
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
  stepId: string,
): Promise<void> {
  const entry: DeadLetterEntry = {
    timestamp: new Date().toISOString(),
    envelope: toPersisted(envelope),
    error: {
      message: error.message,
      name: error.name,
    },
    stepId,
  }

  await store.ensureDir('runs', runId)
  await store.append(`${JSON.stringify(entry)}\n`, 'runs', runId, 'dead-letter.jsonl')
}
