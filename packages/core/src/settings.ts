/**
 * Project-level settings from mt.json.
 * Keys follow the convention: <type>.<name>.<setting>
 * Example: "waypoint.jsonl.defaultFolder"
 */
export interface Settings {
  [key: string]: unknown
}

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
