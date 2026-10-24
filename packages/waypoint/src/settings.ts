import { isAbsolute, join, resolve } from 'node:path'
import { type Settings, getSetting } from '@mt/core'
import type { ParsedUri } from '@mt/core'

/**
 * Resolve a file path for a waypoint source/target, applying any
 * project-level settings such as `waypoint.<scheme>.defaultFolder`.
 *
 * Rules:
 * - If no defaultFolder is configured, returns the raw path unchanged.
 * - If the raw path contains a directory separator, returns it unchanged.
 * - If the raw path looks like a glob pattern, returns it unchanged.
 * - If the raw path is absolute (starts with `/`), returns it unchanged.
 * - Otherwise, prepends defaultFolder to the bare filename.
 */
export function resolveWaypointPath(
  uri: ParsedUri,
  scheme: string,
  settings: Settings | undefined,
): string {
  const rawPath = uri.path || uri.host
  const defaultFolder = getWaypointSetting<string>(settings, scheme, 'defaultFolder')

  if (!defaultFolder) return rawPath
  if (rawPath.includes('/') || rawPath.includes('\\')) return rawPath
  if (rawPath.includes('*') || rawPath.includes('?') || rawPath.includes('[')) return rawPath
  if (rawPath.length > 0 && rawPath[0] === '/') return rawPath

  return join(defaultFolder, rawPath)
}

/**
 * Resolve a waypoint's base directory to an absolute path, independent of
 * `process.cwd()`.
 *
 * Rules (in order):
 * - absolute URI path → returned unchanged
 * - `waypoint.<scheme>.defaultFolder` set → `<projectRoot>/<defaultFolder>/<rawPath>`
 * - otherwise → `<projectRoot>/<rawPath>`
 *
 * Use this where a waypoint needs a *root* it composes paths under (e.g. the
 * `md://` directory target and its `meta.mdOutputs` intents).
 */
export function resolveWaypointRoot(
  uri: ParsedUri,
  scheme: string,
  settings: Settings | undefined,
  projectRoot: string,
): string {
  const rawPath = uri.path || uri.host
  if (isAbsolute(rawPath)) return rawPath
  const defaultFolder = getWaypointSetting<string>(settings, scheme, 'defaultFolder')
  return defaultFolder
    ? resolve(projectRoot, defaultFolder, rawPath)
    : resolve(projectRoot, rawPath)
}

/**
 * Shorthand to read a waypoint-scoped setting.
 */
export function getWaypointSetting<T>(
  settings: Settings | undefined,
  scheme: string,
  key: string,
): T | undefined {
  return getSetting<T>(settings, 'waypoint', scheme, key)
}
