export {
  readDoc,
  writeDoc,
  summaryTool,
  entitiesTool,
  schemaTool,
  metadataTool,
  vocabularyTool,
  schemaDocWriter,
  type SchemaDocEnvelope,
  type SchemaDocMetadata,
} from './schema-doc.js'

export {
  chatCompletion,
  runPrompt,
  type ChatMessage,
  type ChatCompletionInput,
  type ChatCompletionOutput,
  type PromptInput,
  type PromptOutput,
} from './openrouter-tool.js'

export {
  translateText,
  type TranslateInput,
  type TranslateOutput,
  type TranslateToolConfig,
} from './translate-text.js'

export {
  OpenRouterPool,
  OpenRouterPoolSupplier,
  type OpenRouterClient,
  type OpenRouterPoolConfig,
} from './openrouter-pool.js'

export {
  chapterValidator,
  forbiddenCharDetector,
  typoFinder,
  markdownFormatter,
  type FinderInput,
  type FinderOutput,
  type EntityNormalizerInput,
  type EntityNormalizerOutput,
  type MarkdownFormatterInput,
  type MarkdownFormatterOutput,
} from './chapter-validator.js'

import type { FinderInput as FI, FinderOutput as FO } from './chapter-validator.js'
/** @deprecated use FinderInput */
export type FixerInput = FI
/** @deprecated use FinderOutput */
export type FixerOutput = FO

export { wordCounter } from './word-counter.js'
export { tokenCounter, tokenCounterBatch, tokenCounterBatchCached } from './token-counter.js'

export { chapterIndexer } from './chapter-indexer.js'

export { tokenSplitter } from './token-splitter.js'

export {
  titleTranslator,
  paragraphTranslator,
  type TitleTranslatorInput,
  type TitleTranslatorOutput,
  type ParagraphTranslatorInput,
  type ParagraphTranslatorOutput,
} from './chapter-translator.js'

export {
  formatMarkdown,
  formatString,
  mdFormatter,
  mdFormatterTool,
  type FormatOptions,
  type FormatResult,
  type FormattedFile,
  type MdFormatterInput,
  type MdFormatterOutput,
} from './md-formatter.js'

export {
  atomicWriteFile,
  buildProcessor,
  collectMarkdownFiles,
  parseMarkdown,
  readMarkdownFile,
  DEFAULT_EXCLUDES,
  type OrderedListStyle,
  type WrapMode,
} from './remark-processor.js'

export {
  markdownStats,
  markdownOutline,
  stripFrontmatter,
  markdownStatsTool,
  markdownOutlineTool,
  markdownStripFrontmatter,
  type MarkdownStats,
  type MarkdownStatsOutput,
  type MarkdownStripOutput,
  type MarkdownToolInput,
  type MarkdownOutlineOutput,
  type OutlineEntry,
} from './markdown-tool.js'

export {
  toMarkdown,
  toMarkdownTool,
  recordToMarkdown,
  type ToMarkdownInput,
} from './to-markdown.js'

export {
  readChapterDoc,
  writeChapterDoc,
  chapterDoc,
  type ChapterDoc,
  type ChapterDocWarning,
  type ChapterDocParagraph,
} from './chapter-doc.js'
