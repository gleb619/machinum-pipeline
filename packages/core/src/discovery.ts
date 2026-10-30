import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readMtConfig } from './config.js'

export interface DiscoveredPipeline {
  path: string
  declared: string
}

export async function discoverPipelines(projectRoot: string): Promise<DiscoveredPipeline[]> {
  const config = await readMtConfig(projectRoot)
  const pipelines = config.pipelines
  if (pipelines === undefined) return []
  if (!isStringArray(pipelines)) {
    const configPath = join(projectRoot, 'mt.json')
    throw new Error(
      `Invalid mt.json at ${configPath}: pipelines must be an array of strings, got ${JSON.stringify(pipelines)}`,
    )
  }

  const result: DiscoveredPipeline[] = []
  for (const declared of pipelines) {
    const absPath = join(projectRoot, declared)
    try {
      await stat(absPath)
      result.push({ path: absPath, declared })
    } catch {
      console.error(`[discovery] Pipeline not found, skipping: ${declared}`)
    }
  }
  return result
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
