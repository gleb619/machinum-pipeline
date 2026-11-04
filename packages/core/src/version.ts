/** Version of the `mt` product, shared by the CLI and the admin API. */
export const MT_VERSION = '0.1.0'

/** Wire protocol version of the sync endpoints. */
export const SYNC_PROTOCOL_VERSION = 1

/** Extract `major.minor` from a version string, ignoring a leading `v` and any patch suffix. */
export function majorMinorVersion(version: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(version.trim())
  return match ? `${match[1]}.${match[2]}` : undefined
}

/**
 * Sync compatibility rule: exact `major.minor` match. A patch difference is fine; a
 * missing/unparseable version is never considered compatible.
 */
export function versionsCompatible(local: string, remote: string): boolean {
  const localPart = majorMinorVersion(local)
  const remotePart = majorMinorVersion(remote)
  return localPart !== undefined && localPart === remotePart
}
