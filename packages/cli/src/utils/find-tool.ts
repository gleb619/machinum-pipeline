import { resolve } from 'node:path'
import { discoverPipelines, importPipelineModule } from '@mt/core'
import type { Pipeline, PipelineStep, Tool } from '@mt/core'

export interface ToolMatch {
  tool: Tool<unknown, unknown>
  pipelineId: string
  pipelinePath: string
}

/** True when the value looks like a Pipeline (id + steps), regardless of how it was built. */
function isPipeline(value: unknown): value is Pipeline {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; steps?: unknown }
  return typeof candidate.id === 'string' && Array.isArray(candidate.steps)
}

/** True when the value looks like a Tool (name + invoke). */
function isTool(value: unknown): value is Tool<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; invoke?: unknown }
  return typeof candidate.name === 'string' && typeof candidate.invoke === 'function'
}

/** Tools used by the tool steps of one pipeline. */
function toolsOf(pipeline: Pipeline): Tool<unknown, unknown>[] {
  const tools: Tool<unknown, unknown>[] = []
  for (const step of pipeline.steps as PipelineStep[]) {
    if (step.type !== 'tool') continue
    const tool = (step.config as { tool?: unknown }).tool
    if (isTool(tool)) tools.push(tool)
  }
  return tools
}

/**
 * Pipeline files to scan: the single `--pipeline` file, or every pipeline declared in mt.json
 * (discoverPipelines). Errors from a pipeline file that fails to load propagate to the caller.
 */
async function pipelineFiles(projectRoot: string, pipelineFile?: string): Promise<string[]> {
  if (pipelineFile) return [resolve(projectRoot, pipelineFile)]
  const discovered = await discoverPipelines(projectRoot)
  return discovered.map((entry) => entry.path)
}

/**
 * Names of all tools used by the scanned pipelines (unique, sorted). Powers the
 * "Unknown tool" hint of `mt tool <name>`.
 */
export async function listToolNames(projectRoot: string, pipelineFile?: string): Promise<string[]> {
  const names = new Set<string>()
  for (const file of await pipelineFiles(projectRoot, pipelineFile)) {
    const mod = await importPipelineModule(file)
    for (const value of Object.values(mod)) {
      if (!isPipeline(value)) continue
      for (const tool of toolsOf(value)) names.add(tool.name)
    }
  }
  return [...names].sort()
}

/**
 * Find a tool by name, scanning the tool steps of the project's pipelines.
 * Returns undefined when no pipeline uses a tool with that name; throws when the name is
 * ambiguous (used by more than one pipeline) — pass `pipelineFile` to disambiguate.
 */
export async function findTool(
  projectRoot: string,
  name: string,
  pipelineFile?: string,
): Promise<ToolMatch | undefined> {
  const matches: ToolMatch[] = []
  for (const file of await pipelineFiles(projectRoot, pipelineFile)) {
    const mod = await importPipelineModule(file)
    for (const value of Object.values(mod)) {
      if (!isPipeline(value)) continue
      for (const tool of toolsOf(value)) {
        if (tool.name === name) {
          matches.push({ tool, pipelineId: value.id, pipelinePath: file })
        }
      }
    }
  }
  if (matches.length > 1) {
    const sources = matches.map((match) => `${match.pipelineId} (${match.pipelinePath})`)
    throw new Error(
      `Tool '${name}' is ambiguous — used by multiple pipelines: ${sources.join(', ')}. Re-run with --pipeline <file>.`,
    )
  }
  return matches[0]
}
