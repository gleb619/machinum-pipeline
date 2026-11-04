import type { Runner } from '@mt/core'

/**
 * In-memory registry of active Runner instances, keyed by runId.
 * Used by the admin API to pause/resume running pipelines.
 */
const runners = new Map<string, Runner>()

/**
 * Active remote run per project id. A `null` value is a claim made before the
 * Runner has minted its run id, so two concurrent start requests cannot both
 * pass the duplicate check while one is still loading its pipeline module.
 */
const projectRuns = new Map<string, Runner | null>()

export function registerRunner(runId: string, runner: Runner): void {
  runners.set(runId, runner)
}

export function getRunner(runId: string): Runner | undefined {
  return runners.get(runId)
}

export function removeRunner(runId: string): void {
  runners.delete(runId)
}

/** Claim the single active-run slot for a project. Returns false when already taken. */
export function claimProjectRun(projectId: string): boolean {
  if (projectRuns.has(projectId)) return false
  projectRuns.set(projectId, null)
  return true
}

/** Attach the live Runner to a project slot claimed by {@link claimProjectRun}. */
export function attachProjectRunner(projectId: string, runner: Runner): void {
  projectRuns.set(projectId, runner)
}

/** Release a project slot. With a runner, only release it if it is still the owner. */
export function releaseProjectRun(projectId: string, runner?: Runner): void {
  if (runner === undefined) {
    projectRuns.delete(projectId)
    return
  }
  if (projectRuns.get(projectId) === runner) projectRuns.delete(projectId)
}

export function getProjectRunner(projectId: string): Runner | undefined {
  const runner = projectRuns.get(projectId)
  return runner ?? undefined
}
