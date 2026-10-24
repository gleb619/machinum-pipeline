export {
  readDoc,
  writeDoc,
  parseCsvRows,
  formatCsv,
  schemaDocWriter,
  schemaDocBuild,
  schemaDocEmit,
  type SchemaDocEnvelope,
  type SchemaDocMetadata,
} from './normalization/schema-doc.js'

export {
  chatCompletion,
  runPrompt,
  chatCompletionSingle,
  resolveRouterUrl,
  type ChatCompletionOptions,
  type ChatMessage,
  type ChatCompletionInput,
  type ChatCompletionOutput,
  type PromptInput,
  type PromptOutput,
} from './modification/openrouter-tool.js'

export {
  readChapter,
  chapterVars,
  renderPrompt,
  stripCodeFence,
  parseEntityRows,
  parseWordList,
  parseMetadataRow,
  roundTripIssue,
  metadataGroundTruth,
  type ChapterSource,
} from './schema/doc.js'

export {
  runPromptWithRetry,
  resolveLlmOptions,
  attemptMeta,
  DEFAULT_LLM_MODEL,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_ROUTER_URL,
  type SchemaDocLlmOptions,
  type PromptValidation,
  type PromptRetryOptions,
  type PromptRetryResult,
  type LlmAttemptMeta,
} from './schema/llm.js'

export {
  summaryTool,
  createSummaryTool,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_USER_PROMPT,
} from './schema/summary.js'

export {
  entitiesTool,
  createEntitiesTool,
  ENTITIES_SYSTEM_PROMPT,
  ENTITIES_USER_PROMPT,
  type SchemaEntity,
} from './schema/entities.js'

export {
  schemaTool,
  createSchemaTool,
  SCHEMA_SYSTEM_PROMPT,
  SCHEMA_USER_PROMPT,
} from './schema/schema.js'

export {
  metadataTool,
  createMetadataTool,
  METADATA_SYSTEM_PROMPT,
  METADATA_USER_PROMPT,
} from './schema/metadata.js'

export {
  vocabularyTool,
  createVocabularyTool,
  VOCABULARY_SYSTEM_PROMPT,
  VOCABULARY_USER_PROMPT,
} from './schema/vocabulary.js'

export {
  translateText,
  createTranslateText,
  createTranslateGate,
  translateNormalize,
  translateToOutput,
  routerTranslateCall,
  type TranslateInput,
  type TranslateOutput,
  type TranslateToolConfig,
<<<<<<< HEAD
  type TranslateTextOptions,
} from './translate-text.js'
=======
} from './modification/translate-text.js'
>>>>>>> 228da03 (refactor(tools): group source into normalization, modification, verification)

export {
  OpenRouterPool,
  OpenRouterPoolSupplier,
  applyPoolError,
  sharedPoolFor,
  type OpenRouterClient,
  type OpenRouterPoolConfig,
} from './modification/openrouter-pool.js'

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
} from './verification/chapter-validator.js'

import type { FinderInput as FI, FinderOutput as FO } from './verification/chapter-validator.js'
/** @deprecated use FinderInput */
export type FixerInput = FI
/** @deprecated use FinderOutput */
export type FixerOutput = FO

export { wordCounter } from './verification/word-counter.js'
export {
  tokenCounter,
  tokenCounterBatch,
  tokenCounterBatchCached,
  countTextTokens,
} from './verification/token-counter.js'

export { chapterIndexer } from './normalization/chapter-indexer.js'

export { tokenSplitter } from './normalization/token-splitter.js'

export {
  titleTranslator,
  paragraphTranslator,
  createTitleTranslator,
  createParagraphTranslator,
  type TitleTranslatorInput,
  type TitleTranslatorOutput,
  type ParagraphTranslatorInput,
  type ParagraphTranslatorOutput,
<<<<<<< HEAD
  type TitleTranslatorOptions,
  type ParagraphTranslatorOptions,
  type TitleTranslatorSlot,
  type ParagraphTranslatorSlot,
  type TitleTranslatorState,
  type ParagraphTranslatorState,
} from './chapter-translator.js'
=======
} from './modification/chapter-translator.js'
>>>>>>> 228da03 (refactor(tools): group source into normalization, modification, verification)

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
} from './normalization/md-formatter.js'

export {
  buildProcessor,
  collectMarkdownFiles,
  parseMarkdown,
  readMarkdownFile,
  DEFAULT_EXCLUDES,
  type OrderedListStyle,
  type WrapMode,
} from './normalization/remark-processor.js'

export {
  isDirectory,
  readDirectory,
  readTextFile,
  readTextFileSync,
} from './normalization/fs-read.js'

export { atomicWriteFile } from './modification/fs-write.js'

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
} from './verification/markdown-tool.js'

export {
  toMarkdown,
  toMarkdownTool,
  recordToMarkdown,
  type ToMarkdownInput,
} from './modification/to-markdown.js'

export {
  readChapterDoc,
  writeChapterDoc,
  chapterDoc,
  chapterDocBuild,
  chapterDocEmit,
  type ChapterDoc,
  type ChapterDocWarning,
  type ChapterDocParagraph,
} from './normalization/chapter-doc.js'

export {
  appendMdOutput,
  mdOutputEmitter,
  type MdOutputEmitterConfig,
} from './modification/md-outputs.js'

// --- LLM toolkit (client, config, prompts, context window, gate) ---
export {
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
  type LlmClient,
  type LlmResponseFormat,
  type LlmTransport,
  type LlmHttpRequest,
  type LlmHttpResponse,
  type OpenAiCompatOptions,
  type AnthropicOptions,
  type CacheLike,
  type CreateLlmClientDeps,
  OpenAiCompatClient,
  AnthropicClient,
  fetchTransport,
  createAdapter,
  createLlmClient,
} from './modification/llm-client.js'

export {
  createOpenAiSdkClient,
  createAnthropicSdkClient,
  createSdkAdapter,
  defaultTransportKind,
  isSdkPackageAvailable,
  mapSdkError,
  setSdkPackageAvailableForTests,
  type OpenAiSdkClientOptions,
  type AnthropicSdkClientOptions,
} from './llm-sdk-transports.js'

export {
  withTimeout,
  withLlmRetry,
  withCache,
  cacheableRequest,
  type LlmRetryOptions,
  type LlmCacheOptions,
} from './modification/llm-decorators.js'

export {
  LlmError,
  LlmRateLimitError,
  LlmAuthError,
  LlmQuotaError,
  LlmContextLengthError,
  LlmServerError,
  LlmNetworkError,
  LlmTimeoutError,
  LlmAbortError,
  LlmRequestError,
  LlmParseError,
  classifyHttpError,
  isRetryableLlmError,
} from './modification/llm-errors.js'

export {
  LLM_PROVIDERS,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  resolveLlmConfig,
  resolveLlmConfigFromCtx,
  redactLlmConfig,
  readCtx,
  type LlmProvider,
  type LlmConfigLayer,
  type LlmTransportKind,
  type ResolvedLlmConfig,
  type ResolveLlmConfigArgs,
  type CtxView,
} from './modification/llm-config.js'

export {
  PromptVariableError,
  PromptNotFoundError,
  renderTemplate,
  templateVars,
  registerPrompt,
  getDefaultPrompt,
  listPrompts,
  resolvePrompt,
  resolvePromptTemplate,
  promptEnvName,
  promptSourcesFromCtx,
  type PromptTemplate,
  type PromptSources,
  type PromptSource,
} from './modification/llm-prompts.js'

export {
  contextWindow,
  contextShrink,
  createContextWindow,
  createFitter,
  fitMessages,
  resolveContextConfig,
  resolveStrategy,
  registerShrinkStrategy,
  shrinkStrategies,
  modelContextLimit,
  MODEL_CONTEXT_LIMITS,
  parseContextLimits,
  type ModelContextLimitEntry,
  type LastMessageStrategy,
  truncateLines,
  truncateTail,
  truncateHead,
  dropOldest,
  dropMiddle,
  slidingWindow,
  summarize,
  DEFAULT_STRATEGIES,
  type ShrinkStrategy,
  type ShrinkBudget,
  type ShrinkHelpers,
  type StrategySpec,
  type StrategyFactory,
  type ContextWindowRecord,
  type ContextWindowOptions,
  type ContextWindowItem,
  type ContextConfigLayer,
  type ResolvedContextConfig,
  type FitOptions,
  type Fitter,
} from './modification/llm-context.js'

export {
  createLlmGate,
  llmGate,
  llmPrepare,
  llmFit,
  llmCall,
  llmParse,
  llmEmit,
  runLlmCall,
  extractJson,
  mockLlmCall,
  mockLlmClient,
  type GateInput,
  type GateState,
  type GateSlot,
  type GateOutput,
  type LlmGateOptions,
  type MockSource,
  type MockAnswer,
  type MockLlmClient,
  type MockLlmCall,
} from './modification/llm-gate.js'

export {
  llmTranslate,
  type LlmTranslateInput,
  type LlmTranslateOutput,
} from './modification/llm-translate.js'
