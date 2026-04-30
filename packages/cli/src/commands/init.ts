import { join } from 'node:path'
import type { MtConfig } from '@mt/core'
import { DEFAULT_MT_CONFIG, Store } from '@mt/core'

/**
 * `mt init` — scaffold a new Mt project.
 * Creates mt.json, .mt/ directory, and a sample pipeline.
 */
export async function initCommand(args: string[]): Promise<void> {
  const projectRoot = process.cwd()
  const projectName = args[0] ?? 'my-book-project'
  const config: MtConfig = {
    ...DEFAULT_MT_CONFIG,
    project: { ...DEFAULT_MT_CONFIG.project, name: projectName },
  }

  const store = new Store(join(projectRoot, '.mt'))

  // Create mt.json
  const configPath = join(projectRoot, 'mt.json')
  const { writeFile: fsWriteFile, mkdir } = await import('node:fs/promises')
  await fsWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  console.log(`Created ${configPath}`)

  // Create .mt/ directories
  await store.ensureDir()
  await store.ensureDir('runs')
  await store.ensureDir('cache')
  console.log(`Created ${store.getRoot()}/`)

  // Create sample pipeline
  const pipelinesDir = join(projectRoot, 'pipelines')
  await mkdir(pipelinesDir, { recursive: true })
  const samplePipelinePath = join(pipelinesDir, 'example.ts')
  const sampleContent = `import { definePipeline, source, target } from '@mt/core'

export default definePipeline({
  id: 'example',
  retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
  onError: 'fail-run',
})
  .from(source('jsonl://./input.jsonl'))
  .to(target('jsonl://./output.jsonl'))
`
  await fsWriteFile(samplePipelinePath, sampleContent, 'utf-8')
  console.log(`Created ${samplePipelinePath}`)

  console.log('\n\u2728 Project initialized! Next steps:')
  console.log('  1. Edit mt.json with your book metadata')
  console.log('  2. Create pipelines in ./pipelines/')
  console.log('  3. Run: mt run ./pipelines/example.ts')
}
