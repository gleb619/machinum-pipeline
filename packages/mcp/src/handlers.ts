import type { DiscoveredPipeline } from '@mt/core'
import { discoverPipelines } from '@mt/core'

interface InitializeResult {
  protocolVersion: '2024-11-05'
  capabilities: {
    tools: { listChanged: false }
    resources: { listChanged: false }
  }
  serverInfo: {
    name: 'mt-mcp'
    version: '0.1.0'
  }
}

interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

interface ResourceItem {
  uri: string
  name: string
  description: string
  mimeType?: string
}

interface ResourceReadResult {
  contents: Array<{
    uri: string
    mimeType: string
    text: string
  }>
}

export function handleInitialize(): InitializeResult {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false },
    },
    serverInfo: {
      name: 'mt-mcp',
      version: '0.1.0',
    },
  }
}

export function handleToolsList(): { tools: unknown[] } {
  return { tools: [] }
}

export async function handleToolsCall(params: {
  name: string
  arguments: Record<string, unknown>
}): Promise<ToolCallResult> {
  return {
    content: [{ type: 'text', text: `Tool not found: ${params.name}` }],
    isError: true,
  }
}

export async function handleResourcesList(
  projectRoot: string,
): Promise<{ resources: ResourceItem[] }> {
  const pipelines = await discoverPipelines(projectRoot)
  const resources: ResourceItem[] = pipelines.map((pipeline: DiscoveredPipeline) => ({
    uri: `mt://pipeline/${pipeline.path}`,
    name: pipeline.declared,
    description: '',
  }))

  return { resources }
}

export async function handleResourcesRead(params: { uri: string }): Promise<ResourceReadResult> {
  const uri = params.uri

  if (uri.startsWith('mt://pipeline/')) {
    const pipelinePath = uri.slice('mt://pipeline/'.length)
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ path: pipelinePath }),
        },
      ],
    }
  }

  if (uri.startsWith('mt://book/') || uri.startsWith('mt://chapter/')) {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ message: 'Source integration deferred to v2' }),
        },
      ],
    }
  }

  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ error: 'Unknown URI scheme' }),
      },
    ],
  }
}
