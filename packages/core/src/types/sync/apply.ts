export interface SyncApplyOptions {
  /** Allow `.mt/runs/<id>/...` (pull/output direction). Secrets are still rejected. */
  allowRunState?: boolean
}
