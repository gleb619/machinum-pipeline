import { isAbsolute, resolve } from 'node:path'
import { type Settings, getSetting } from '@mt/core'
import type { ParsedUri } from '@mt/core'

/**
 * Resolve a file path for a waypoint source/target, applying any
 * project-level settings such as `waypoint.<scheme>.defaultFolder`.
 *
 * Relative paths anchor at `projectRoot` — the project root, never
 * `process.cwd()`; absolute paths are returned unchanged.
 *
 * Rules:
 * - If the raw path is absolute (starts with `/`), returns it unchanged.
 * - If no defaultFolder is configured, returns `<projectRoot>/<rawPath>`.
 * - If the raw path contains a directory separator, returns
 *   `<projectRoot>/<rawPath>` (defaultFolder not applied).
 * - If the raw path looks like a glob pattern, returns `<projectRoot>/<rawPath>`
 *   (glob anchoring preserved, re-anchored at the project root).
 * - Otherwise (bare filename), prepends defaultFolder:
 *   `<projectRoot>/<defaultFolder>/<rawPath>`.
 */
export function resolveWaypointPath(
  uri: ParsedUri,
  scheme: string,
  settings: Settings | undefined,
  projectRoot: string,
): string {
  const rawPath = uri.path || uri.host
  if (isAbsolute(rawPath)) return rawPath

  const defaultFolder = getWaypointSetting<string>(settings, scheme, 'defaultFolder')

  if (!defaultFolder) return resolve(projectRoot, rawPath)
  if (rawPath.includes('/') || rawPath.includes('\\')) return resolve(projectRoot, rawPath)
  if (rawPath.includes('*') || rawPath.includes('?') || rawPath.includes('[')) {
    return resolve(projectRoot, rawPath)
  }

  return resolve(projectRoot, defaultFolder, rawPath)
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
 * `md://` directory target and its `mdOutputs` variable intents).
 *
 * Thin wrapper over `resolveWaypointPath` — the bare-filename defaultFolder
 * rule is a no-op for directory-style URIs (they always contain a separator),
 * so both resolvers share one implementation.
 */
export function resolveWaypointRoot(
  uri: ParsedUri,
  scheme: string,
  settings: Settings | undefined,
  projectRoot: string,
): string {
  return resolveWaypointPath(uri, scheme, settings, projectRoot)
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
