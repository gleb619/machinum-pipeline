import type { Settings } from './settings.js'
import type { BufferWriter, BufferWriterFactory, Source, Splitter, Target } from './types.ts'

/**
 * URI registry — maps URI schemes to Source/Target factories.
 * Supports composite schemes (e.g. git+http://) via registered combinators.
 *
 * Also resolves named URI shortcuts (aliases): strings starting with '@'
 * (e.g. '@en') are looked up in the project's "uris" table from mt.json
 * settings. Everything else is treated as a plain URI.
 */

/**
 * Factory function that creates a Source from a parsed URI.
 */
export type SourceFactory<T> = (uri: ParsedUri) => Source<T>

/**
 * Factory function that creates a Target from a parsed URI.
 */
export type TargetFactory<T> = (uri: ParsedUri) => Target<T>

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
 * Composite resolver — combines two or more schemes.
 */
export type CompositeResolver = (schemes: string[], rest: string) => ParsedUri

/**
 * Named URI shortcuts (aliases) — configured per-project in mt.json:
 * { "uris": { "en": "md://./chapters/en" } }
 */
export interface UriAliases {
  [alias: string]: string
}

/**
 * Maximum number of alias-to-alias hops before expansion fails.
 */
export const MAX_URI_ALIAS_DEPTH = 10

const ALIAS_PREFIX = '@'
const EVENT_SHORTCUT_PREFIX = '#'
const EVENT_DEFAULT_NAME = 'default'

/**
 * URI registry singleton.
 */
class UriRegistry {
  private sources = new Map<string, SourceFactory<unknown>>()
  private targets = new Map<string, TargetFactory<unknown>>()
  private compositeResolvers = new Map<string, CompositeResolver>()
  private splitters = new Map<string, Splitter<unknown>>()
  private bufferWriters = new Map<string, BufferWriterFactory>()

  /**
   * Register a source factory for a URI scheme.
   */
  registerSource<T>(scheme: string, factory: SourceFactory<T>): void {
    this.sources.set(scheme, factory as SourceFactory<unknown>)
  }

  /**
   * Register a target factory for a URI scheme.
   */
  registerTarget<T>(scheme: string, factory: TargetFactory<T>): void {
    this.targets.set(scheme, factory as TargetFactory<unknown>)
  }

  /**
   * Register a composite resolver for a combined scheme prefix.
   * E.g., 'git+http' for 'git+http://...'
   */
  registerComposite(prefix: string, resolver: CompositeResolver): void {
    this.compositeResolvers.set(prefix, resolver)
  }

  /**
   * Register a splitter for an entity/buffer URI scheme (e.g. `paragraphs`, `lines`, `series`).
   * The scheme is the buffer type a pipeline names in `.subflow('<scheme>')`.
   */
  registerSplitter<O>(scheme: string, splitter: Splitter<O>): void {
    this.splitters.set(scheme, splitter as Splitter<unknown>)
  }

  /**
   * Check if a scheme has a registered splitter.
   */
  hasSplitter(scheme: string): boolean {
    return this.splitters.has(scheme)
  }

  /**
   * Resolve the scheme named by a splitter reference (`'#paragraphs'`,
   * `'paragraphs://'` or `'paragraphs://ladder'`). Bare `'paragraphs'` is rejected.
   */
  splitterScheme(schemeOrUri: string): string {
    const shortcut = schemeOrUri.trim().startsWith('#')
    const reference = shortcut ? schemeOrUri.trim().slice(1) : schemeOrUri.trim()
    if (!shortcut && !reference.includes('://')) {
      const known = this.getSplitterSchemes()
      throw new Error(
        `Splitter reference '${schemeOrUri}' must be a buffer URI ('${schemeOrUri}://') or a ` +
          `'#${schemeOrUri}' shortcut. Known splitter schemes: ` +
          `${known.length > 0 ? known.join(', ') : '(none)'}`,
      )
    }
    return reference.includes('://') ? this.parse(reference).scheme : reference
  }

  /**
   * Resolve a splitter from a buffer URI or the `#scheme` shortcut.
   *
   * `'paragraphs://'` / `'paragraphs://ladder'` and `'#paragraphs'` resolve the same
   * registered splitter. Bare `'paragraphs'` is deliberately rejected: the URI form keeps
   * buffer/type references visibly distinct from pipeline ids and tool names.
   */
  resolveSplitter<O>(schemeOrUri: string): Splitter<O> {
    const scheme = this.splitterScheme(schemeOrUri)
    const splitter = this.splitters.get(scheme)
    if (!splitter) {
      const known = this.getSplitterSchemes()
      throw new Error(
        `No splitter registered for scheme: ${scheme}` +
          `${schemeOrUri === scheme ? '' : ` (from '${schemeOrUri}')`}. ` +
          `Known splitter schemes: ${known.length > 0 ? known.join(', ') : '(none)'}`,
      )
    }
    return splitter as Splitter<O>
  }

  /**
   * Get all registered splitter schemes.
   */
  getSplitterSchemes(): string[] {
    return Array.from(this.splitters.keys())
  }

  /**
   * Register the write side of an entity buffer. `.subflow('<splitter>', '<namespace>')`
   * publishes into the writer registered for the splitter's scheme.
   */
  registerBufferWriter(scheme: string, factory: BufferWriterFactory): void {
    this.bufferWriters.set(scheme, factory)
  }

  /** True when `scheme` has an entity buffer writer (a ladder/package rung). */
  hasBufferWriter(scheme: string): boolean {
    return this.bufferWriters.has(scheme)
  }

  /** Resolve the namespace-scoped writer for an entity buffer scheme. */
  resolveBufferWriter(scheme: string, namespace: string): BufferWriter {
    const factory = this.bufferWriters.get(scheme)
    if (!factory) {
      throw new Error(
        `No buffer writer registered for scheme: ${scheme}. Import '@mt/waypoint' (which registers the entity buffers).`,
      )
    }
    return factory(namespace)
  }

  /** Get all registered buffer-writer schemes. */
  getBufferWriterSchemes(): string[] {
    return Array.from(this.bufferWriters.keys())
  }

  /**
   * Resolve a URI string to a Source.
   * Alias strings (starting with '@', e.g. '@en') are expanded via the
   * project's "uris" table in settings before lookup.
   */
  resolveSource<T>(uri: string, settings?: Settings): Source<T> {
    return this.resolveEndpoint(uri, this.sources, 'source', settings) as Source<T>
  }

  /**
   * Resolve a URI string to a Target.
   * Alias strings (starting with '@', e.g. '@en') are expanded via the
   * project's "uris" table in settings before lookup.
   */
  resolveTarget<T>(uri: string, settings?: Settings): Target<T> {
    return this.resolveEndpoint(uri, this.targets, 'target', settings) as Target<T>
  }

  /**
   * Expand aliases, parse the URI and look the scheme up in the given factory
   * map. Shared by {@link resolveSource} and {@link resolveTarget}.
   */
  private resolveEndpoint<T>(
    uri: string,
    factories: Map<string, (parsed: ParsedUri) => T>,
    kind: 'source' | 'target',
    settings?: Settings,
  ): T {
    const resolvedUri = this.expandAliases(uri, settings)
    const parsed = this.parse(resolvedUri)
    const factory = factories.get(parsed.scheme)
    if (!factory) {
      throw new Error(`No ${kind} registered for scheme: ${parsed.scheme} (URI: ${resolvedUri})`)
    }
    return factory(parsed)
  }

  /**
   * Read the "uris" alias table from project settings (mt.json).
   * Non-string values are ignored.
   */
  getAliases(settings: Settings | undefined): UriAliases {
    const uris = settings?.uris
    if (!uris || typeof uris !== 'object' || Array.isArray(uris)) return {}
    const aliases: UriAliases = {}
    for (const [key, value] of Object.entries(uris)) {
      if (typeof value === 'string') aliases[key] = value
    }
    return aliases
  }

  /**
   * True when a URI string is an alias reference: it starts with '@'.
   * Everything else — real URIs with a scheme — is never an alias.
   */
  isAliasCandidate(uri: string): boolean {
    return uri.startsWith(ALIAS_PREFIX) || uri.startsWith(EVENT_SHORTCUT_PREFIX)
  }

  /**
   * Expand a '@name' URI alias through the project's "uris" table (mt.json).
   * Alias values may themselves be aliases (chained, up to MAX_URI_ALIAS_DEPTH).
   * Returns the input unchanged when it is not an alias candidate.
   */
  expandAliases(uri: string, settings: Settings | undefined): string {
    if (!this.isAliasCandidate(uri)) return uri
    const aliases = this.getAliases(settings)
    const chain: string[] = []
    let current = uri
    while (this.isAliasCandidate(current)) {
      if (chain.includes(current)) {
        throw new Error(`Circular URI alias: ${[...chain, current].join(' → ')}`)
      }
      if (chain.length >= MAX_URI_ALIAS_DEPTH) {
        throw new Error(
          `URI alias chain exceeds ${MAX_URI_ALIAS_DEPTH} hops: ${[...chain, current].join(' → ')}`,
        )
      }
      if (current.startsWith(EVENT_SHORTCUT_PREFIX)) {
        const rest = current.slice(1)
        let qualifier = rest ? rest : ''
        if (qualifier && !qualifier.includes('=')) {
          qualifier = `only=${qualifier}`
        }
        const expanded = `events://${EVENT_DEFAULT_NAME}${qualifier ? `?${qualifier}` : ''}`
        chain.push(current)
        current = expanded
        continue
      }
      const next = aliases[current.slice(ALIAS_PREFIX.length)]
      if (typeof next !== 'string') {
        throw new Error(
          `Unknown URI alias '${current}'${chain.length > 0 ? ` (chained from '${uri}')` : ''}. ` +
            `Define it in mt.json: "uris": { "${current.slice(ALIAS_PREFIX.length)}": "<scheme>://..." }`,
        )
      }
      chain.push(current)
      current = next
    }
    return current
  }

  /**
   * Parse a URI string into components.
   * Supports composite schemes like 'jsonl://path?key=val'.
   */
  parse(uri: string): ParsedUri {
    // Try composite resolvers first
    for (const [prefix, resolver] of this.compositeResolvers) {
      if (uri.startsWith(prefix)) {
        const schemes = prefix.split('+')
        const rest = uri.slice(prefix.length)
        return resolver(schemes, rest)
      }
    }

    // Standard parsing: scheme://host/path?query#fragment
    const match = uri.match(
      /^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/,
    )
    if (!match) {
      // Support scheme:path (without //)
      const simpleMatch = uri.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/)
      if (!simpleMatch) {
        throw new Error(`Invalid URI: ${uri}`)
      }
      return {
        scheme: simpleMatch[1] ?? '',
        host: '',
        path: simpleMatch[2] ?? '',
        query: parseQueryString(simpleMatch[3], uri),
        fragment: simpleMatch[4] ?? '',
        raw: uri,
      }
    }

    let host = match[2] ?? ''
    let path = match[3] ?? ''

    // If host is . or .. (relative path indicators), prepend to path and clear host
    if (host === '.' || host === '..') {
      path = host + path
      host = ''
    }

    return {
      scheme: match[1] ?? '',
      host,
      path,
      query: parseQueryString(match[4], uri),
      fragment: match[5] ?? '',
      raw: uri,
    }
  }

  /**
   * Check if a scheme has a registered source.
   */
  hasSource(scheme: string): boolean {
    return this.sources.has(scheme)
  }

  /**
   * Check if a scheme has a registered target.
   */
  hasTarget(scheme: string): boolean {
    return this.targets.has(scheme)
  }

  /**
   * Get the registered Source factory for a scheme (for composite wrapping).
   */
  getSourceFactory<T = unknown>(scheme: string): SourceFactory<T> | undefined {
    return this.sources.get(scheme) as SourceFactory<T> | undefined
  }

  /**
   * Get the registered Target factory for a scheme (for composite wrapping).
   */
  getTargetFactory<T = unknown>(scheme: string): TargetFactory<T> | undefined {
    return this.targets.get(scheme) as TargetFactory<T> | undefined
  }

  /**
   * Get all registered source schemes.
   */
  getSourceSchemes(): string[] {
    return Array.from(this.sources.keys())
  }

  /**
   * Get all registered target schemes.
   */
  getTargetSchemes(): string[] {
    return Array.from(this.targets.keys())
  }
}

/**
 * Decode a URI component, returning the raw text if decoding fails.
 */
function safeDecode(text: string, rawUri: string): string {
  try {
    return decodeURIComponent(text)
  } catch (err) {
    if (err instanceof URIError) return text
    throw new Error(
      `Malformed query in URI ${rawUri}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Parse a query string into key-value pairs.
 * Splits each part on the first '=' only and includes the URI in any error.
 */
function parseQueryString(query: string | undefined, rawUri: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!query) return result
  for (const part of query.split('&')) {
    if (!part) continue
    const eqIndex = part.indexOf('=')
    let rawKey: string
    let rawValue: string
    if (eqIndex === -1) {
      rawKey = part
      rawValue = ''
    } else {
      rawKey = part.slice(0, eqIndex)
      rawValue = part.slice(eqIndex + 1)
    }
    const key = safeDecode(rawKey, rawUri)
    if (key) {
      result[key] = safeDecode(rawValue, rawUri)
    }
  }
  return result
}

/**
 * Global URI registry instance.
 */
export const registry = new UriRegistry()

export { UriRegistry }
