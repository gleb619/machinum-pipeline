import { definePipeline, defineTool } from '@mt/core'
import { summaryTool, entitiesTool, schemaTool } from '@mt/tools'
import '@mt/waypoint'
import { schemaPipeline } from './jsonl-to-md-multi.js'

// Stub tools -----------------------------------------------------------------

const validationTool = defineTool<any, any>({
  name: 'validation-stub',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    // STUB: TODO — check markdown structure, frontmatter, headings
    // STUB: TODO — throw/flag invalid chapters
    return env
  },
  exec: 'inproc',
})

const typoDetectorStub = defineTool<any, any>({
  name: 'typo-detector-stub',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    // STUB: TODO — detect typos, add to meta.warnings[]
    const warnings = (env.meta.warnings as string[] | undefined) ?? []
    return { ...env, meta: { ...env.meta, warnings } }
  },
  exec: 'inproc',
})

const forbiddenCharStub = defineTool<any, any>({
  name: 'forbidden-char-stub',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    // STUB: TODO — detect forbidden chars, add to meta.warnings[]
    const warnings = (env.meta.warnings as string[] | undefined) ?? []
    return { ...env, meta: { ...env.meta, warnings } }
  },
  exec: 'inproc',
})

const fixTyposStub = defineTool<any, any>({
  name: 'fix-typos-stub',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    // STUB: TODO — auto-fix common typos via spellcheck
    return env
  },
  exec: 'inproc',
})

const fixEntitiesStub = defineTool<any, any>({
  name: 'fix-entities-stub',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    // STUB: TODO — normalize entity names (e.g. "Jon"→"John")
    return env
  },
  exec: 'inproc',
})

const fixFormattingStub = defineTool<any, any>({
  name: 'fix-formatting-stub',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    // STUB: TODO — fix markdown formatting issues
    return env
  },
  exec: 'inproc',
})

const translateTitleStub = defineTool<any[], any[]>({
  name: 'translate-title-stub',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    // STUB: TODO — translate title only, preserve body
    return env
  },
  exec: 'inproc',
})

const translateParagraphStub = defineTool<any, any>({
  name: 'translate-paragraph-stub',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    // STUB: TODO — translate each paragraph
    return env
  },
  exec: 'inproc',
})

// Pipelines ------------------------------------------------------------------

/** Validates chapter is well-formed. */
export const smokeTestPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(validationTool)
  .tap(async (item: any) => console.log('[smoke] chapter valid'))

/** Splits chapters > 12000 tokens into 6000-token chunks. */
export const splitChaptersPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (item: any) => {
    // STUB: TODO — use tiktoken or similar to count tokens
    // STUB: TODO — if tokens > 12000, split into ~6000 token chunks
    // STUB: TODO — return array of sub-chapters
    return [item]
  })
  .to('jsonl://./jsonl/split-chapters.jsonl')

/** Collects warnings about chapter (typos, forbidden chars). */
export const collectWarningsPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(typoDetectorStub)
  .use(forbiddenCharStub)
  .tap(async (item: any) => console.log('[warnings]', item.meta?.warnings))
  .to('jsonl://./jsonl/chapter-warnings.jsonl')

/** Generates schema document describing the chapter.
 *  Re-exports the existing schemaPipeline from jsonl-to-md-multi.ts. */
export const schemaDocPipeline = schemaPipeline

/** Fixes chapter text (typos, entity names, formatting). */
export const fixChapterPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(fixTyposStub)
  .use(fixEntitiesStub)
  .use(fixFormattingStub)
  .to('jsonl://./jsonl/fixed-chapters.jsonl')

/** Translates chapter titles in batches of 5. */
export const translateTitlesPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .batch(5)
  .use(translateTitleStub)
  .flatMap(async (items: any[]) => {
    // STUB: TODO — unwrap batch, each item goes to separate file
    return items
  })
  .to('waypoint://./samples/sample1/chapters/ru')

/** Translates chapter content paragraph by paragraph. */
export const translateChapterPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (item: any) => {
    // STUB: TODO — split chapter body into paragraphs
    const paragraphs = (item.body as string).split('\n\n')
    return paragraphs.map(p => ({ ...item, body: p }))
  })
  .use(translateParagraphStub)
  // STUB: TODO — reassemble paragraphs back into chapter
  .to('md://./chapters/ru/translated.md')
