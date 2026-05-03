import type { Runner } from '@mt/core'

/**
 * In-memory registry of active Runner instances, keyed by runId.
 * Used by the admin API to pause/resume running pipelines.
 */
const runners = new Map<string, Runner>()

export function registerRunner(runId: string, runner: Runner): void {
  runners.set(runId, runner)
}

export function getRunner(runId: string): Runner | undefined {
  return runners.get(runId)
}

export function removeRunner(runId: string): void {
  runners.delete(runId)
}
