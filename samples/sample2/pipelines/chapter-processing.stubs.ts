import { definePipeline } from '@mt/core'
import {
  chapterValidator,
  entitiesTool,
  entityNormalizer,
  forbiddenCharDetector,
  grammarWarnings,
  markdownFormatter,
  paragraphTranslator,
  schemaTool,
  summaryTool,
  titleTranslator,
  tokenSplitter,
  typoDetector,
  typoFixer,
} from '@mt/tools'
import '@mt/waypoint'
import { schemaPipeline } from './jsonl-to-md-multi.js'

// Pipelines ------------------------------------------------------------------

/** Validates chapter is well-formed. */
export const smokeTestPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterValidator)
  .tap(async (_item: any) => console.log('[smoke] chapter valid'))

/** Splits chapters > 12000 tokens into 6000-token chunks. */
export const splitChaptersPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(tokenSplitter)
  .to('jsonl://./jsonl/split-chapters.jsonl')

/** Collects warnings about chapter (typos, forbidden chars, grammar). */
export const collectWarningsPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(typoDetector)
  .use(forbiddenCharDetector)
  .use(grammarWarnings)
  .tap(async (item: any) => console.log('[warnings]', item.meta?.warnings))
  .to('jsonl://./jsonl/chapter-warnings.jsonl')

/** Generates schema document describing the chapter.
 *  Re-exports the existing schemaPipeline from jsonl-to-md-multi.ts. */
export const schemaDocPipeline = schemaPipeline

/** Fixes chapter text (typos, entity names, formatting). */
export const fixChapterPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(typoFixer)
  .use(entityNormalizer)
  .use(markdownFormatter)
  .to('jsonl://./jsonl/fixed-chapters.jsonl')

/** Translates chapter titles in batches of 5. */
export const translateTitlesPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .batch(5)
  .use(titleTranslator)
  .flatMap(async (items: any[]) => {
    // unwrap batch, each item goes to separate file
    return items
  })
  .to('waypoint://./samples/sample1/chapters/ru')

/** Translates chapter content paragraph by paragraph. */
export const translateChapterPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (item: any) => {
    const paragraphs = (item.body as string).split('\n\n')
    return paragraphs.map((p) => ({ ...item, body: p }))
  })
  .use(paragraphTranslator)
  .to('md://./chapters/ru/translated.md')
