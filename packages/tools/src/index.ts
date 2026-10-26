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
} from './modification/schema-doc.js'

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
} from './core/openrouter-tool.js'

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
} from './normalization/schema/doc.js'

export {
  runPromptWithRetry,
  resolveLlmOptions,
  attemptMeta,
  DEFAULT_LLM_MODEL,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_ROUTER_URL,
  type SchemaDocLlmOptions,
  type SchemaDocLlmCall,
  type PromptValidation,
  type PromptRetryOptions,
  type PromptRetryResult,
  type LlmAttemptMeta,
} from './normalization/schema/llm.js'

export {
  summaryTool,
  createSummaryTool,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_USER_PROMPT,
  notesSummaryTool,
  createNotesSummaryTool,
  renderSummaryNotes,
  DEFAULT_NOTE_COUNT,
  type NotesSummaryOptions,
} from './normalization/schema/summary.js'

export {
  loadBundledPrompt,
  listBundledPrompts,
  type BundledPromptName,
} from './core/bundled-prompts.js'

export {
  entitiesTool,
  createEntitiesTool,
  ENTITIES_SYSTEM_PROMPT,
  ENTITIES_USER_PROMPT,
  type SchemaEntity,
} from './normalization/schema/entities.js'

export {
  schemaTool,
  createSchemaTool,
  SCHEMA_SYSTEM_PROMPT,
  SCHEMA_USER_PROMPT,
} from './normalization/schema/schema.js'

export {
  metadataTool,
  createMetadataTool,
  METADATA_SYSTEM_PROMPT,
  METADATA_USER_PROMPT,
} from './normalization/schema/metadata.js'

export {
  vocabularyTool,
  createVocabularyTool,
  VOCABULARY_SYSTEM_PROMPT,
  VOCABULARY_USER_PROMPT,
} from './normalization/schema/vocabulary.js'

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
  type TranslateTextOptions,
} from './core/translate-text.js'

export {
  OpenRouterPool,
  OpenRouterPoolSupplier,
  applyPoolError,
  sharedPoolFor,
  type OpenRouterClient,
  type OpenRouterPoolConfig,
} from './core/openrouter-pool.js'

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

export { wordCounter } from './normalization/word-counter.js'
export {
  textNormalizer,
  createTextNormalizer,
  normalizeText,
  type TextNormalizerOptions,
} from './normalization/text-normalizer.js'
export {
  tokenCounter,
  tokenCounterBatch,
  tokenCounterBatchCached,
  countTextTokens,
} from './normalization/token-counter.js'

export {
  glossaryExtractor,
  createGlossaryExtractor,
  buildGlossary,
  extractCandidates,
  guessType,
  slugify,
  parseGlossary,
  serializeGlossary,
  mergeReportedTerms,
  chapterNumberOf,
  seedCandidates,
  mergeExtractedEntries,
  applyRelations,
  coOccurrenceRelations,
  recountGlossary,
  sortGlossary,
  uniqueId,
  type GlossaryChapter,
  type GlossaryCandidate,
  type GlossaryExtractOptions,
  type GlossaryExtractorToolOptions,
  type GlossaryRelations,
  type GlossaryRelationsOptions,
  type GlossaryEnrichOptions,
} from './normalization/glossary-extractor.js'
export {
  buildGlossaryGraph,
  findReferences,
  serializeGlossaryGraph,
  parseGlossaryGraph,
  type GlossaryGraph,
  type GlossaryGraphNode,
  type GlossaryGraphEdge,
  type GlossaryEdgeKind,
} from './normalization/glossary-graph.js'
export {
  createHeuristicNerBackend,
  heuristicNerBackend,
  type NerBackend,
  type NerCandidate,
  type NerKind,
} from './normalization/ner-candidates.js'
export {
  createNamedEntityRecognizer,
  createHeuristicEntityBackend,
  heuristicEntityBackend,
  createCompromiseNerBackend,
  createOpenNlpNerBackend,
  openNlpModelsFromEnv,
  createCandidateNerBackend,
  createNamedEntityTool,
  namedEntityTool,
  type NerBackend as EntityNerBackend,
  type NerEntity,
  type NamedEntityRecognizer,
  type NamedEntityRecognizerOptions,
  type NamedEntityToolOptions,
  type OpenNlpNerBackendOptions,
} from './normalization/named-entity-recognizer.js'
export {
  GLOSSARY_PROMPTS,
  extractGlossaryWithLlm,
  relateTermWithLlm,
  enrichTermWithLlm,
  mapCategory,
  parseGlossaryEntries,
  parseNameRelations,
  type LlmGlossaryEntry,
  type LlmNameRelation,
  type GlossaryLlmOptions,
} from './normalization/glossary-llm.js'
export {
  statFreq,
  defineStatFreq,
  createStatFreq,
  buildStatFreqReport,
  splitStatSentences,
  tokenizeWords,
  cmpTerm,
  type StatFreqOptions,
  type StatFreqReport,
  type StatFreqWord,
  type StatFreqSentence,
  type StatFreqNgram,
  type StatFreqTopEntry,
  type StatFreqKind,
} from './normalization/stat-freq.js'
export {
  statDict,
  defineStatDict,
  createStatDict,
  buildStatDict,
  selectStatDictCandidates,
  isStatFreqReport,
  type StatDictOptions,
  type StatDictCandidate,
  type StatDictSelectOptions,
} from './normalization/stat-dict.js'
export {
  createStatTranslateDict,
  statTranslateDict,
  type StatTranslateDictOptions,
} from './modification/stat-translate-dict.js'
export {
  termTagger,
  tagTerms,
  stripTerms,
  countTerms,
  compileTermMatcher,
  mapProse,
  type Glossary,
  type GlossaryTerm,
  type GlossaryTermType,
  type TermMatcher,
} from './normalization/term-tagger.js'
export {
  buildTranslationPrompt,
  cleanTranslation,
  joinReplyLines,
  termIdsIn,
  parseReportedTerms,
  wrapTranslationInput,
  TRANSLATE_TEMPLATE_VARS,
  TRANSLATE_ALLOWED_TEMPLATE_VARS,
  TRANSLATE_WORK_MODES,
  type ReportedTerm,
  type TranslateWorkMode,
  type TranslationPrompt,
  type TranslationPromptInput,
} from './normalization/translation-prompt.js'
export {
  parseTranslationReply,
  TranslationReplyParseError,
  type ParsedTranslation,
} from './normalization/translation-reply.js'
export {
  lineParityLinter,
  createLineParityLinter,
  lintLineParity,
  LineParityError,
  parityFeedback,
  type LineParityInput,
  type ParityIssue,
  type ParityIssueCode,
  type ParitySeverity,
  type LineParityOptions,
  type LineParityLinterOptions,
  type LineParityReport,
} from './verification/line-parity-linter.js'
export {
  lintPromptTemplate,
  lintTranslatePromptSet,
  type PromptIssue,
  type PromptLintOptions,
} from './verification/prompt-linter.js'
export {
  statProofread,
  createStatProofread,
  checkTermConsistency,
  checkTranslatedShare,
  buildProofreadReport,
  proofreadFeedback,
  StatProofreadError,
  type ProofreadIssue,
  type ProofreadIssueKind,
  type ProofreadReport,
  type StatProofreadOptions,
} from './verification/stat-proofread.js'
export {
  heuristicSummaryTool,
  createHeuristicSummaryTool,
  summarizeHeuristic,
  splitSentences,
  chapterTitle,
  type HeuristicSummaryOptions,
} from './normalization/heuristic-summary.js'

export { chapterIndexer } from './normalization/chapter-indexer.js'

export { tokenSplitter } from './normalization/token-splitter.js'

export {
  createTokenSplitter,
  withStrategy,
  paragraphStrategy,
  lineStrategy,
  whitespaceStrategy,
  sentenceStrategy,
  singleStrategy,
  balancedStrategy,
  balancedLineStrategy,
  balanceText,
  overlap,
  rebalance,
  countTokens,
  heuristicTokenCount,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CHUNK_TARGET,
  type TokenSplitter,
  type TokenSplitterOptions,
  type TokenSplitStrategy,
  type TokenCountFn,
  type ParagraphStrategyOptions,
  type LineStrategyOptions,
  type WhitespaceStrategyOptions,
  type SentenceStrategyOptions,
  type BalancedStrategyOptions,
  type BalancedLineStrategyOptions,
} from './normalization/token-splitter.js'

export {
  titleTranslator,
  paragraphTranslator,
  createTitleTranslator,
  createParagraphTranslator,
  type TitleTranslatorInput,
  type TitleTranslatorOutput,
  type ParagraphTranslatorInput,
  type ParagraphTranslatorOutput,
  type TitleTranslatorOptions,
  type ParagraphTranslatorOptions,
  type TitleTranslatorSlot,
  type ParagraphTranslatorSlot,
  type TitleTranslatorState,
  type ParagraphTranslatorState,
} from './modification/chapter-translator.js'

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
} from './modification/md-formatter.js'

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
} from './core/fs-read.js'

export { atomicWriteFile, ensureParentDir } from './core/fs-write.js'

export {
  VAR_DOCKER_COMPOSE,
  dockerComposeEmitter,
  type DockerComposeEmitterOptions,
  type DockerComposeOutput,
  type DockerComposeService,
} from './core/docker-compose.js'

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
} from './normalization/markdown-tool.js'

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
} from './modification/chapter-doc.js'

export {
  VAR_MD_OUTPUTS,
  appendMdOutput,
  mdOutputEmitter,
  type MdOutputEmitterConfig,
} from './core/md-outputs.js'

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
} from './core/llm-client.js'

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
} from './core/llm-sdk-transports.js'

export {
  withTimeout,
  withLlmRetry,
  withCache,
  cacheableRequest,
  type LlmRetryOptions,
  type LlmCacheOptions,
} from './core/llm-decorators.js'

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
} from './core/llm-errors.js'

export {
  LLM_PROVIDERS,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  resolveLlmConfig,
  resolveLlmConfigFromCtx,
  exchangeConfigBag,
  VAR_CONTEXT,
  VAR_CONTEXT_WINDOW,
  VAR_LLM,
  VAR_PROMPTS,
  redactLlmConfig,
  readCtx,
  type LlmProvider,
  type LlmConfigLayer,
  type LlmTransportKind,
  type ResolvedLlmConfig,
  type ResolveLlmConfigArgs,
  type CtxView,
} from './core/llm-config.js'

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
} from './core/llm-prompts.js'

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
} from './core/llm-context.js'

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
  VAR_LLM_USAGE,
} from './core/llm-gate.js'

export {
  llmTranslate,
  type LlmTranslateInput,
  type LlmTranslateOutput,
} from './core/llm-translate.js'

export { openrouterFree, OPENROUTER_FREE_LLM } from './core/openrouter-free.js'

export {
  openrouterPool,
  VAR_OPENROUTER_POOL,
  createOpenrouterPool,
  resetOpenrouterPoolPins,
  getOpenrouterPoolPin,
  OPENROUTER_POOL_DEFAULT_MODELS,
  type OpenrouterPoolOptions,
  type OpenrouterPoolMeta,
  type PinStrategy,
} from './core/openrouter-pool-tool.js'

export {
  listRouterModels,
  ROUTER_FREE_MODEL,
  type RouterModelInfo,
  type RouterModelsOptions,
} from './core/router-models.js'

export {
  ollamaTool,
  ollamaApiRoot,
  ollamaHealth,
  listOllamaModels,
  OLLAMA_LLM,
  OLLAMA_DEFAULTS,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  type OllamaHealth,
  type OllamaModelInfo,
  type OllamaRequestOptions,
} from './core/ollama-tool.js'

export {
  LLM_TOOLS,
  readLlmConfig,
  pickLlmTool,
  type LlmTool,
  type LlmConfig,
  type LlmChoice,
  type PickLlmToolOptions,
} from './core/llm-picker.js'

export {
  toChapterRecord,
  chapterRecordMapper,
  lineTextToMarkdown,
  unwrapMarkdownText,
  type RawChapter,
  type ChapterRecord,
} from './normalization/chapter-record.js'
export {
  createLlmTypoFix,
  LLM_TYPO_FIX_PROMPT,
  type LlmTypoFixOptions,
} from './normalization/llm-typo-fix.js'
export {
  createLlmSummaryWithFallback,
  type LlmSummaryToolOptions,
} from './normalization/llm-summary.js'
export { readGlossaryFile } from './normalization/glossary-extractor.js'
export {
  analyzeOutputs,
  createAnalyzeOutputs,
  type AnalyzeOutputsOptions,
} from './modification/analyze-outputs.js'
export {
  onlyChapters,
  translateConcurrency,
  loadGlossaryOrEmpty,
  loadChapterSummary,
  createGlossaryTitleTranslator,
  chaptersToTitleInputs,
  createChapterBodyTranslator,
  translateTaggedChapter,
  titleOf,
  TITLE_RULES,
  type GlossaryTitleTranslatorOptions,
  type ChapterBodyTranslatorOptions,
  type TranslateLinesOptions,
} from './normalization/translation-stage.js'
export { chapterPairsLinter } from './verification/chapter-pairs-linter.js'
export {
  createTranslateOutputs,
  type TranslateOutputsOptions,
} from './modification/translate-outputs.js'
export {
  ruGrammarTool,
  createRuGrammarTool,
  inferRuGrammar,
  declineRu,
  declineAllRu,
  validateRuInflection,
  inferRuGrammarForGlossary,
  RU_CASES,
  type RuGender,
  type RuDeclension,
  type RuCase,
  type RuNumber,
  type RuEndings,
  type RuGrammar,
  type RuDeclensionTable,
  type RuGrammarIssue,
  type RuGrammarReport,
  type RuGrammarToolOptions,
} from './normalization/ru-grammar.js'

export {
  proofreadTool,
  createProofreadTool,
  proofreadXmlTool,
  createProofreadXmlTool,
  proofreadPropertiesTool,
  createProofreadPropertiesTool,
  PROOFREAD_SYSTEM_PROMPT,
  PROOFREAD_USER_PROMPT,
  PROOFREAD_PROPERTIES_SYSTEM_PROMPT,
  PROOFREAD_PROPERTIES_USER_PROMPT,
  type ProofreadOptions,
  type ProofreadXmlOptions,
  type ProofreadMeta,
} from './modification/proofread.js'

export {
  installStubs,
  stubTranslator,
  stubSchemaEmit,
  stubTitleTranslateSlot,
  stubParagraphTranslateSlot,
} from './stubs/index.js'
