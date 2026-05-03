import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MtConfig } from './config.js'

export interface DiscoveredPipeline {
  path: string
  declared: string
}

export async function discoverPipelines(projectRoot: string): Promise<DiscoveredPipeline[]> {
  const configPath = join(projectRoot, 'mt.json')
  let config: MtConfig
  try {
    const raw = await readFile(configPath, 'utf-8')
    config = JSON.parse(raw) as MtConfig
  } catch {
    return []
  }

  const pipelines = config.pipelines ?? []
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
