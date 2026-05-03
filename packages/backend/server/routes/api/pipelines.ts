import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineEventHandler } from 'h3'

interface MtConfig {
  pipelines?: string[]
}

export default defineEventHandler(async () => {
  const projectRoot = process.cwd()
  const configPath = join(projectRoot, 'mt.json')

  let config: MtConfig
  try {
    const raw = await readFile(configPath, 'utf-8')
    config = JSON.parse(raw) as MtConfig
  } catch {
    return []
  }

  const declared = config.pipelines ?? []
  return declared.map((p) => ({ path: join(projectRoot, p), declared: p }))
})
