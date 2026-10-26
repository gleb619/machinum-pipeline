export { Store } from './store.js'
export { atomicWriteFile, AtomicStreamWriter, removeStaleTmpFiles, tmpPathFor } from './atomic.js'
export type { LifecycleScripts, MtConfig } from './config.js'
export { DEFAULT_MT_CONFIG, loadGlobalContext, parseEnvFile, readMtConfig } from './config.js'
export type {
  GlobalContext,
  RunContext,
  ToolContext,
  SourceContext,
  TargetContext,
  CheckpointHandle,
  StepInfo,
  RetryPolicy,
  ErrorPolicy,
  RetryStrategy,
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
  CreateEmbedOptions,
  EmbedEntryInfo,
  EmbedSecret,
  SetEmbedSecretInput,
  SetEmbedSecretOptions,
} from './embed.js'
export {
  EMBED_REF_PREFIX,
  createEmbedStore,
  defaultEmbedPath,
  embedCredentialsConfigured,
  embedDisabled,
  getEmbedSecret,
  isEmbedRef,
  listEmbedEntries,
  resetEmbedCache,
  resolveEmbedValue,
  setEmbedSecret,
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
  Tool,
  Target,
  Envelope,
  Lifecycle,
  Logger,
  Pipeline,
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
export type { Book, Chapter, Paragraph, Line } from './domain.js'
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
  PipelineBuilder,
} from './dsl.js'
export type { ComposableTool, ToolFn, WaypointSourceHooks, WaypointTargetHooks } from './dsl.js'
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
  resolveRetryPolicy,
  withRetry,
} from './engine/retry.js'
export type { PartialRetryPolicy, RetryableError } from './engine/retry.js'
export { Cache } from './engine/cache.js'
export type { CacheEntry, CacheOptions } from './engine/cache.js'
export { mapConcurrent } from './engine/stream.js'
// Built-in source/target registration moved to @mt/waypoint package.
// Import '@mt/waypoint' to register jsonl, md, http, hs, git+ schemes.
