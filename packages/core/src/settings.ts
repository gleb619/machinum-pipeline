import type { Settings } from 'types.js'

/**
 * Read a typed setting using dot-path lookup.
 *
 * @param settings — the settings bag
 * @param type — top-level namespace, e.g. 'waypoint', 'tool', 'runner'
 * @param name — second-level qualifier, e.g. 'jsonl', 'translator'
 * @param key — the specific setting name
 */
export function getSetting<T>(
  settings: Settings | undefined,
  type: string,
  name: string,
  key: string,
): T | undefined {
  if (!settings) return undefined
  return settings[`${type}.${name}.${key}`] as T | undefined
}
