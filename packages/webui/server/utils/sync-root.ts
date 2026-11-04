import { join, resolve } from 'node:path'
import { DEFAULT_MAX_FILE_BYTES, isValidProjectId, readMtConfig } from '@mt/core'
import type { H3Event } from 'h3'
import { resolveInsideRoot } from './resolve-inside-root.js'

export interface MirrorRoots {
  serveRoot: string
  mirrorsRoot: string
  mirrorRoot: string
}

/** Project root captured by `startBackend` (tests/embedded) or the process defaults. */
export function serveRootOf(event: H3Event): string {
  const context = event.context as { mtProjectRoot?: unknown }
  if (typeof context.mtProjectRoot === 'string' && context.mtProjectRoot !== '') {
    return context.mtProjectRoot
  }
  return process.env.MT_PROJECT_ROOT || process.cwd()
}

export function resolveMirrorRoots(serveRoot: string, projectId: string): MirrorRoots {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid projectId '${projectId}': expected a safe path segment`)
  }
  const base = resolve(serveRoot)
  const mirrorsRoot = join(base, '.mt', 'remote')
  return {
    serveRoot: base,
    mirrorsRoot,
    mirrorRoot: resolveInsideRoot(mirrorsRoot, projectId),
  }
}

export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value[0]
    return typeof first === 'string' ? first : undefined
  }
  return undefined
}

export function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
}

export async function readSyncLimits(serveRoot: string): Promise<{ maxFileBytes: number }> {
  try {
    const config = await readMtConfig(serveRoot)
    const value = config.remote?.sync?.maxFileBytes
    return { maxFileBytes: value ?? DEFAULT_MAX_FILE_BYTES }
  } catch {
    // A malformed config is reported elsewhere; the sync endpoint keeps its safe default.
    return { maxFileBytes: DEFAULT_MAX_FILE_BYTES }
  }
}
