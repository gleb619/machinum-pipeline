import type { Source, Target } from './types.ts'

/**
 * URI registry — maps URI schemes to Source/Target factories.
 * Supports composite schemes (e.g. git+http://) via registered combinators.
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
 * URI registry singleton.
 */
class UriRegistry {
  private sources = new Map<string, SourceFactory<unknown>>()
  private targets = new Map<string, TargetFactory<unknown>>()
  private compositeResolvers = new Map<string, CompositeResolver>()

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
   * Resolve a URI string to a Source.
   */
  resolveSource<T>(uri: string): Source<T> {
    const parsed = this.parse(uri)
    const factory = this.sources.get(parsed.scheme)
    if (!factory) {
      throw new Error(`No source registered for scheme: ${parsed.scheme} (URI: ${uri})`)
    }
    return factory(parsed) as Source<T>
  }

  /**
   * Resolve a URI string to a Target.
   */
  resolveTarget<T>(uri: string): Target<T> {
    const parsed = this.parse(uri)
    const factory = this.targets.get(parsed.scheme)
    if (!factory) {
      throw new Error(`No target registered for scheme: ${parsed.scheme} (URI: ${uri})`)
    }
    return factory(parsed) as Target<T>
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
    const match = uri.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/)
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
        query: parseQueryString(simpleMatch[3]),
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
      query: parseQueryString(match[4]),
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
 * Parse a query string into key-value pairs.
 */
function parseQueryString(query?: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!query) return result
  for (const part of query.split('&')) {
    const [key, value] = part.split('=')
    if (key) {
      result[decodeURIComponent(key)] = value ? decodeURIComponent(value) : ''
    }
  }
  return result
}

/**
 * Global URI registry instance.
 */
export const registry = new UriRegistry()

export { UriRegistry }
