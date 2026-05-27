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
  type MdFormatterInput,
  type MdFormatterOutput,
} from './md-formatter.js'

export {
  readChapterDoc,
  writeChapterDoc,
  chapterDoc,
  type ChapterDoc,
  type ChapterDocWarning,
  type ChapterDocParagraph,
} from './chapter-doc.js'
