import type { ChapterDocNode, ChapterDocWarning } from './chapter-doc.js'

const KNOWN_KEYS = new Set(['number', 'series', 'warnings'])

/**
 * Fluent frontmatter accessor/mutator for a {@link ChapterDocNode}.
 *
 * Typed accessors (`number` / `series` / `warnings`) mirror the `ChapterDoc` fields.
 * Generic `get`/`set`/`add`/`has`/`remove` cover arbitrary YAML keys. `add` refuses
 * overwrite (throws); use `set` to replace. `undefined` removes a key.
 */
export class ChapterMetadata {
  constructor(private readonly doc: ChapterDocNode) {}

  get number(): number | undefined {
    return this.doc.number
  }

  set number(value: number | undefined) {
    this.set('number', value)
  }

  get series(): string | undefined {
    return this.doc.series
  }

  set series(value: string | undefined) {
    this.set('series', value)
  }

  get warnings(): ChapterDocWarning[] {
    return this.doc.warnings
  }

  set warnings(value: ChapterDocWarning[] | undefined) {
    this.set('warnings', value)
  }

  get<T = unknown>(key: string): T | undefined {
    if (KNOWN_KEYS.has(key)) {
      if (key === 'number') return this.doc.number as T | undefined
      if (key === 'series') return this.doc.series as T | undefined
      return this.doc.warnings as T
    }
    return this.doc.meta?.[key] as T | undefined
  }

  has(key: string): boolean {
    if (key === 'number') return this.doc.number !== undefined
    if (key === 'series') return this.doc.series !== undefined && this.doc.series !== ''
    if (key === 'warnings') return this.doc.warnings.length > 0
    return this.doc.meta !== undefined && Object.hasOwn(this.doc.meta, key)
  }

  keys(): string[] {
    const result: string[] = []
    if (this.doc.number !== undefined) result.push('number')
    if (this.doc.series !== undefined && this.doc.series !== '') result.push('series')
    if (this.doc.warnings.length > 0) result.push('warnings')
    if (this.doc.meta) {
      for (const key of Object.keys(this.doc.meta).sort()) {
        result.push(key)
      }
    }
    return result
  }

  /** Snapshot of every frontmatter key (known + extras). */
  toObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (this.doc.number !== undefined) out.number = this.doc.number
    if (this.doc.series !== undefined && this.doc.series !== '') out.series = this.doc.series
    if (this.doc.warnings.length > 0) out.warnings = this.doc.warnings
    if (this.doc.meta) {
      for (const key of Object.keys(this.doc.meta).sort()) {
        out[key] = this.doc.meta[key]
      }
    }
    return out
  }

  /** Overwrite or insert. `undefined` removes the key. Returns `this` for chaining. */
  set(key: string, value: unknown): this {
    if (value === undefined) {
      return this.remove(key)
    }
    if (key === 'number') {
      const n = typeof value === 'number' ? value : Number(value)
      this.doc.number = Number.isFinite(n) ? n : undefined
      return this
    }
    if (key === 'series') {
      this.doc.series = value === '' ? undefined : String(value)
      return this
    }
    if (key === 'warnings') {
      this.doc.warnings = Array.isArray(value) ? (value as ChapterDocWarning[]) : []
      return this
    }
    if (!this.doc.meta) this.doc.meta = {}
    this.doc.meta[key] = value
    return this
  }

  /**
   * Insert a new key. Throws when the key already exists — use {@link set} to overwrite.
   * Returns `this` for chaining.
   */
  add(key: string, value: unknown): this {
    if (this.has(key)) {
      throw new Error(`Metadata key already exists: ${key}`)
    }
    return this.set(key, value)
  }

  remove(key: string): this {
    if (key === 'number') {
      this.doc.number = undefined
      return this
    }
    if (key === 'series') {
      this.doc.series = undefined
      return this
    }
    if (key === 'warnings') {
      this.doc.warnings = []
      return this
    }
    if (this.doc.meta && Object.hasOwn(this.doc.meta, key)) {
      delete this.doc.meta[key]
      if (Object.keys(this.doc.meta).length === 0) {
        this.doc.meta = undefined
      }
    }
    return this
  }
}
