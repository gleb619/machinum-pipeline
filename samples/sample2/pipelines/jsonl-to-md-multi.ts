import { definePipeline, defineTool } from '@mt/core'
import { summaryTool, entitiesTool, schemaTool } from '@mt/tools'
import '@mt/waypoint'

// Tool 1: Word counter — counts words in markdown content and adds to envelope meta
const wordCounter = defineTool<string, string>({
  name: 'word-counter',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    const wordCount = (env.item as string).split(/\s+/).filter(Boolean).length
    return { ...env, meta: { ...env.meta, wordCount } }
  },
  exec: 'inproc',
})

// Tool 2: Chapter indexer — extracts chapter number from heading and adds to meta
const chapterIndexer = defineTool<string, string>({
  name: 'chapter-indexer',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    const chapterMatch = (env.item as string).match(/^#\s*Chapter\s*(\d+)/m)
    const chapterNum = chapterMatch ? parseInt(chapterMatch[1], 10) : 0
    return { ...env, meta: { ...env.meta, chapterNum } }
  },
  exec: 'inproc',
})

// Schema tools fragment (tools-only pipeline for fork)
const schemaToolsFragment = definePipeline()
  .use(summaryTool)
  .use(entitiesTool)
  .use(schemaTool)

// Primary pipeline — JSONL → Markdown chapters → fork(schema tools) → batch → output.md
export default definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (item: any) => {
    return [`# ${item.title}\n\n${item.body}\n`]
  })
  .tap(async (item) => {
    console.log(`[tap] Processing: ${item.slice(0, 60)}...`)
  })
  .use(wordCounter)
  .use(chapterIndexer)
  .subflow(schemaToolsFragment)
  .batch(3)
  .to('md://./md/output.md')

// Schema-doc pipeline — JSONL → Markdown → focused tools → per-chapter schema-doc output
// Demonstrates focused tools (summary/entities/schema) + @mt/waypoint schema-doc:// target
export const schemaPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (item: any) => {
    return [`# ${item.title}\n\n${item.body}\n`]
  })
  .use(chapterIndexer)
  .use(summaryTool)
  .use(entitiesTool)
  .use(schemaTool)
  .to('schema-doc://./chapters/schema')
