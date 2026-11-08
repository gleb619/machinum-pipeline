/**
 * Parsed URI components.
 */
export interface ParsedUri {
  scheme: string
  host: string
  path: string
  query: Record<string, string>
  fragment: string
  raw: string
}

/**
 * Named URI shortcuts (aliases) — configured per-project in mt.json:
 * { "uris": { "en": "md://./chapters/en" } }
 */
export interface UriAliases {
  [alias: string]: string
}
