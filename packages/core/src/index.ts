export {
  ANNOTATION_FACTORIES,
  ANNOTATION_KEY,
  ANNOTATION_KINDS,
  annotate,
  annotationOf,
  annotationsOf,
  category,
  decorate,
  findAnnotation,
  isAnnotated,
  listAnnotations,
  resetAnnotationRegistry,
  tool,
  useCase,
  waypoint,
} from './annotation.js'
export type {
  Annotation,
  AnnotationFactories,
  AnnotationKind,
  AnnotationKindFactory,
  AnnotationRecord,
  AnnotationSpec,
  CategoryAnnotation,
  CategoryFactory,
  IdAnnotation,
  IdAnnotationKind,
} from './annotation.js'
export {
  createConsoleLogger,
  escapeLogNewlines,
  escapeMarkdown,
  formatJsonLogLine,
  formatLogLine,
  log,
} from './logging.js'
export type { LogFormat, LogFunction, LogSeverity } from './logging.js'
export { acquireListener, hostsShareListener } from './http-listener.js'
export type { HttpRouteHandler, ListenerFactory, ListenerLease } from './http-listener.js'
export { Store } from './store.js'
export {
  atomicWriteFile,
  AtomicStreamWriter,
  type AtomicStreamWriterOptions,
  removeStaleTmpFiles,
  tmpPathFor,
  truncateFileToBytes,
} from './atomic.js'
export type {
  LifecycleScripts,
  MtConfig,
  RemoteConfig,
  RemoteSyncConfig,
  RemoteSyncMode,
} from './config.js'
export {
  DEFAULT_MT_CONFIG,
  DEFAULT_REMOTE_SYNC,
  loadGlobalContext,
  parseEnvFile,
  readMtConfig,
  readMtConfigSync,
  validateRemoteConfig,
} from './config.js'
export type {
  GlobalContext,
  RunContext,
  SplitterContext,
  ToolContext,
  SourceContext,
  TargetContext,
  CheckpointHandle,
  StepInfo,
  RetryPolicy,
  ErrorPolicy,
  RetryStrategy,
  BatchScope,
} from './contexts.js'
export type {
  Vault,
  VaultEntry,
  VaultProvider,
  VaultRef,
  ResolvedVaultRef,
} from './vault.js'
export {
  addEntry,
  emptyVault,
  isValidEntryName,
  findPlaintextKeys,
  isSecretRef,
  isVaultProvider,
  loadVault,
  maskSecret,
  maskVault,
  parseVaultRef,
  removeEntry,
  resolveVaultRef,
  saveVault,
  vaultPaths,
  VAULT_PROVIDERS,
} from './vault.js'
export type { LoadVaultOptions } from './vault.js'
export type {
  AddEmbedKeyOptions,
  CreateEmbedOptions,
  EmbedEntryInfo,
  EmbedKeyInfo,
  EmbedKeyringOptions,
  GenerateEmbedKeyOptions,
  RotateEmbedKeysOptions,
  EmbedSecret,
  MasterKeyPaths,
  MasterKeyResolution,
  MasterKeySource,
  RekeyEmbedOptions,
  WriteMasterKeyOptions,
  RotateEmbedSecretOptions,
  SetEmbedSecretInput,
  SetEmbedSecretOptions,
} from './embed.js'
export {
  DEFAULT_EMBED_PASSWORD,
  DEFAULT_EMBED_WARNING,
  EMBED_REF_PREFIX,
  addEmbedKey,
  createEmbedStore,
  defaultEmbedPath,
  embedCredentialsConfigured,
  embedDisabled,
  generateMasterKey,
  masterKeyFileTooOpen,
  masterKeyPaths,
  masterKeyStatus,
  resetMasterKeyWarnings,
  resolveMasterKey,
  writeMasterKeyFile,
  generateEmbedKey,
  getEmbedSecret,
  isEmbedRef,
  listEmbedEntries,
  listEmbedKeys,
  parseSuppliedEmbedKey,
  removeEmbedKey,
  resetEmbedCache,
  resetEmbedDefaultWarning,
  rekeyEmbedStore,
  resolveEmbedValue,
  retireEmbedKey,
  rotateEmbedKeys,
  rotateEmbedSecret,
  setEmbedSecret,
  useEmbedKey,
} from './embed.js'
export type {
  AddKeepassSecretInput,
  AddKeepassSecretOptions,
  CreateKeepassOptions,
  KeepassEntryInfo,
  KeepassSecret,
} from './keepass.js'
export {
  KEEPASS_REF_PREFIX,
  addKeepassSecret,
  createKeepassDatabase,
  defaultKeepassPath,
  getKeepassSecret,
  isKeepassRef,
  keepassCredentialsConfigured,
  keepassDisabled,
  listKeepassEntries,
  resetKeepassCache,
  resolveKeepassValue,
} from './keepass.js'
export type { Settings } from './settings.js'
export { VLT_REF_PREFIX, findVlt, getVltSecret, installVlt, resolveVltValue } from './vlt.js'
export { getSetting } from './settings.js'
export type {
  Source,
  Splitter,
  Tool,
  Target,
  BufferWriter,
  BufferWriterFactory,
  Envelope,
  Lifecycle,
  Logger,
  Pipeline,
  ForkStepConfig,
  PipelineStep,
  RunState,
  RunEvent,
  RunEventType,
  RunEventListener,
  RunEvents,
  CheckpointNode,
  RunStateData,
  RunnerOptions,
  MdOutputEntry,
} from './types.js'
export type {
  BatchMembers,
  Exchange,
  ExchangeInput,
  ExchangeMeta,
  PersistedExchange,
  Qualifier,
  Variable,
  VariableOptions,
} from './exchange.js'
export {
  BATCH_MEMBERS_VARIABLE,
  batchMembersOf,
  copyVariable,
  createExchange,
  findVariable,
  fromPersisted,
  getOldVariable,
  getVariable,
  hasVariable,
  hashableVariables,
  ITEM_VARIABLE,
  itemOf,
  itemsOf,
  oldItemOf,
  isEmptyValue,
  mergeVariables,
  newExchangeId,
  MD_OUTPUTS_VARIABLE,
  pushVariable,
  setVariables,
  replaceVariable,
  setVariable,
  toExchange,
  toPersisted,
  unbatchExchange,
  variable,
  withBatchMembers,
  withItem,
  withMeta,
  withVariable,
  withoutEmpty,
  withoutEphemeral,
  withoutOldAndEmpty,
  withoutVariable,
} from './exchange.js'
export type {
  Book,
  Chapter,
  ChapterLine,
  ChapterLineWord,
  Paragraph,
  Chunk,
  Token,
  ParagraphLine,
  LineWord,
} from './domain.js'
export {
  ChapterNode,
  ChunkNode,
  LineNode,
  ParagraphNode,
  TokenNode,
  WordNode,
  chapterBody,
  chapterBodyFromMarkdown,
  chapterTree,
  parseChapterTree,
} from './domain-tree.js'
export type {
  ChapterBody,
  ChapterTreeInput,
  ChunkBodySplitter,
  DomainTreeOptions,
  DomainTreeTokenizer,
  LineBodySplitter,
  LineWordSplitter,
  ParagraphBodySplitter,
  TokenPart,
  WordSpan,
} from './domain-tree.js'
export {
  BALANCE_ALLOWED_DEVIATION,
  CHARS_PER_TOKEN_HEURISTIC,
  DECORATIVE_LINE_RE,
  DEFAULT_CHUNK_SEPARATOR,
  DEFAULT_CHUNK_TARGET,
  DEFAULT_LINE_MAX_TOKENS,
  DEFAULT_OVERLAP_CHARS,
  DEFAULT_SENTENCE_MAX_CHARS,
  SENTENCE_END_RE,
  balanceText,
  balancedLineStrategy,
  balancedStrategy,
  hasSeparators,
  heuristicTokenCount,
  isSeparatorLine,
  joinChunks,
  lineStrategy,
  overlap,
  paragraphStrategy,
  parseChunks,
  rebalance,
  rebalanceLines,
  sentenceStrategy,
  singleStrategy,
  splitIntoChunks,
  splitLineUnits,
  splitLines,
  splitParagraphUnits,
  splitReadableParts,
  splitSentenceUnits,
  stripSeparators,
  whitespaceStrategy,
} from './text-split.js'
export * from './constants.js'

export type {
  BalancedLineStrategyOptions,
  BalancedStrategyOptions,
  LineStrategyOptions,
  ParagraphStrategyOptions,
  SentenceStrategyOptions,
  SplitIntoChunksOptions,
  TokenCountFn,
  TokenSplitStrategy,
  WhitespaceStrategyOptions,
} from './text-split.js'
export {
  definePipeline,
  defineTool,
  chain,
  defineComposableTool,
  defineSource,
  defineTarget,
  defineWaypoint,
  source,
  target,
  defineProcess,
  isPipeline,
  ProcessBuilder,
  PipelineBuilder,
  DEFAULT_BATCH_SIZE,
} from './dsl.js'
export type { BatchOptions } from './dsl.js'
export { createBatchScope } from './batch-scope.js'
export type {
  ComposableTool,
  LogLevel,
  LogOptions,
  ProcessConfig,
  ProcessInstall,
  ToolFn,
  WaypointSourceHooks,
  WaypointTargetHooks,
} from './dsl.js'
export { isProcess } from './process.js'
export type { Process, ProcessMode, ProcessRunOptions } from './process.js'
export type { ProcessOptions } from './dsl.js'
export { registry, UriRegistry, MAX_URI_ALIAS_DEPTH } from './uri.js'
export type {
  ParsedUri,
  SourceFactory,
  TargetFactory,
  CompositeResolver,
  UriAliases,
} from './uri.js'
export { discoverPipelines } from './discovery.js'
export type { DiscoveredPipeline } from './discovery.js'
export { derivePipelineId } from './dsl.js'
export {
  importPipelineModule,
  isNativeAddonError,
  isPackageResolutionError,
  nativeAddonHint,
  packageResolutionHint,
  setPipelineModuleLoader,
} from './module-loader.js'
export type { PipelineModuleLoader } from './module-loader.js'

// Engine exports
export { RunStateMachine } from './engine/state-machine.js'
export { Runner } from './engine/runner.js'
export {
  createRootCheckpoint,
  findNode,
  findFirstNonDone,
  addChild,
  markDone,
  markFailed,
  markInProgress,
  isAllDone,
  countByState,
  serializeTree,
  deserializeTree,
  walkTree,
} from './engine/checkpoint.js'
export {
  DEFAULT_MAX_BACKOFF_MS,
  getBackoff,
  isFatalError,
  parseRetryAfterMs,
  resolveRetryPolicy,
  wait,
  withRetry,
} from './engine/retry.js'
export type { PartialRetryPolicy, RetryableError } from './engine/retry.js'
export { Cache } from './engine/cache.js'
export type { CacheEntry, CacheOptions } from './engine/cache.js'
export type { DeadLetterEntry } from './engine/dead-letter.js'
export { mapConcurrent } from './engine/stream.js'
// Built-in source/target registration moved to @mt/waypoint package.
// Import '@mt/waypoint' to register jsonl, md, http, hs, git+ schemes.

export {
  MT_VERSION,
  SYNC_PROTOCOL_VERSION,
  majorMinorVersion,
  versionsCompatible,
} from './version.js'
export {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SYNC_EXCLUDE,
  DEFAULT_SYNC_INCLUDE,
  MAX_PROJECT_BYTES,
  MAX_REQUEST_BYTES,
  collectOutputScope,
  collectPipelineFiles,
  collectSyncScope,
  isProtectedSyncPath,
  isSafeSyncPath,
  isValidProjectId,
  matchesAnyGlob,
  matchesGlob,
  normalizeSyncPath,
  projectIdFor,
  resolveProjectId,
  walkSyncFiles,
} from './sync/scope.js'
export type { SyncOutputScopeOptions, SyncScopeOptions } from './sync/scope.js'
export {
  buildManifest,
  createSyncHashCache,
  hashFile,
  manifestTotalBytes,
} from './sync/manifest.js'
export type { BuildManifestOptions, SyncHashCache, SyncManifestEntry } from './sync/manifest.js'
export {
  diffManifest,
  diffManifests,
  hasSyncChanges,
  manifestHashMap,
} from './sync/diff.js'
export type { SyncDiff } from './sync/diff.js'
export {
  SyncFileTooLargeError,
  SyncPathError,
  SyncProtectedPathError,
  SyncSymlinkError,
  deleteSyncFile,
  pruneSyncFiles,
  readSyncFile,
  resolveSyncPath,
  writeSyncFile,
} from './sync/apply.js'
export type { SyncApplyOptions } from './sync/apply.js'
