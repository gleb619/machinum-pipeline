import { resolve } from 'node:path'
import { defineTool } from '@mt/core'
import type { Envelope, Tool } from '@mt/core'

import { atomicWriteFile } from './fs-write.js'

/**
 * Docker-compose generator: emits a `docker-compose.yml` for the dev services a
 * pipeline needs (ollama / qdrant / lightrag presets) plus optional top-level
 * `include:` entries. YAML is hand-rolled — no yaml dependency.
 */

/** Services with a built-in compose preset. */
export type DockerComposeService = 'ollama' | 'qdrant' | 'lightrag'

export interface DockerComposeEmitterOptions {
  /** Output file path, relative to the project root. Default: `./docker-compose.yml`. */
  outPath?: string
  /** Service presets to include (each rendered with a minimal image/ports/volumes). */
  services: DockerComposeService[]
  /** Other compose file paths merged via the top-level docker compose `include:` instruction. */
  include?: string[]
}

export interface DockerComposeOutput {
  /** Absolute path of the written file. */
  path: string
  services: DockerComposeService[]
  include: string[]
}

interface ServicePreset {
  image: string
  port: number
  volume: string
}

const SERVICE_PRESETS: Record<DockerComposeService, ServicePreset> = {
  ollama: { image: 'ollama/ollama', port: 11434, volume: 'ollama_data' },
  qdrant: { image: 'qdrant/qdrant', port: 6333, volume: 'qdrant_data' },
  // Placeholder image — pin a real LightRAG image before relying on this preset.
  lightrag: { image: 'lightrag/lightrag', port: 9621, volume: 'lightrag_data' },
}

function renderService(name: DockerComposeService, preset: ServicePreset): string {
  return [
    `  ${name}:`,
    `    image: ${preset.image}`,
    '    restart: unless-stopped',
    '    ports:',
    `      - "${preset.port}:${preset.port}"`,
    '    volumes:',
    `      - ${preset.volume}:/data`,
  ].join('\n')
}

function renderCompose(services: DockerComposeService[], include: string[]): string {
  const blocks: string[] = ['services:']
  for (const service of services) {
    blocks.push(renderService(service, SERVICE_PRESETS[service]))
  }
  if (include.length > 0) {
    blocks.push('include:')
    for (const path of include) {
      blocks.push(`  - ${path}`)
    }
  }
  blocks.push('')
  return blocks.join('\n')
}

/**
 * Build the compose file from `env.item` options and write it atomically.
 * `env.item` may be omitted; the factory `options` alone are enough.
 */
export function dockerComposeEmitter(
  options: DockerComposeEmitterOptions,
): Tool<unknown, DockerComposeOutput> {
  const outPath = options.outPath ?? './docker-compose.yml'
  return defineTool<unknown, DockerComposeOutput>({
    name: 'docker-compose-emitter',
    version: '1.0.0',
    mdDescription:
      'Generates a docker-compose.yml with ollama/qdrant/lightrag service presets ' +
      'and optional top-level include: entries; written atomically relative to the project root.',
    async invoke(env: Envelope<unknown>, ctx) {
      const projectRoot = ctx.run.global.project.root
      const targetPath = resolve(projectRoot, outPath)
      const include = options.include ?? []
      const content = renderCompose(options.services, include)
      await atomicWriteFile(targetPath, content)
      const meta = { ...env.meta, dockerCompose: { path: targetPath, services: options.services } }
      return { item: { path: targetPath, services: options.services, include }, meta }
    },
  })
}
