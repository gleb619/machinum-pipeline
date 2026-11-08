export interface SyncScopeOptions {
  /** When present these replace {@link DEFAULT_SYNC_INCLUDE}; hard exclusions still apply. */
  include?: readonly string[]
  /** Additional excludes on top of {@link DEFAULT_SYNC_EXCLUDE}. */
  exclude?: readonly string[]
  /** Include `.mt/runs/**` (only safe for read-only output manifests). */
  allowRunState?: boolean
}

export interface SyncOutputScopeOptions {
  runId?: string
}
