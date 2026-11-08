import type { PersistedExchange } from '../exchange.js'

/**
 * Dead-letter entry written to .mt/runs/<runId>/dead-letter.jsonl
 */
export interface DeadLetterEntry {
  timestamp: string
  /** Persisted form: variables yes (non-ephemeral), `meta` no. */
  envelope: PersistedExchange
  error: {
    message: string
    name: string
  }
  stepId: string
}
