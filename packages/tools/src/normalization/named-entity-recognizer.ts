import { defineTool } from '@mt/core'
import type { Envelope } from '@mt/core'
import { ORG_WORDS, PLACE_WORDS, isCommonWord } from './glossary-lexicon.js'
import type { NerBackend as CandidateNerBackend, NerCandidate, NerKind } from './ner-candidates.js'

/**
 * Named-entity recognizer (port of the machinum-llm `NamedEntityRecognizer`, OpenNLP-style).
 *
 * Text-level and backend-pluggable, unlike {@link ./ner-candidates.js} which scans whole
 * corpora. Each backend recognises entities in one text; the recognizer merges the results
 * of all backends (sorted by text, optionally unique by text — the semantics of the Java
 * `recognizeEntities` / `recognizeUniqueEntities`).
 *
 * Backends:
 * - {@link heuristicEntityBackend}: always available, pure JS, no deps (default).
 * - {@link createCompromiseNerBackend}: pure-JS `compromise` NLP (lazy-loaded, bundle-safe).
 * - {@link createOpenNlpNerBackend}: OpenNLP `.bin` model adapter; only enabled when
 *   `MT_NER_MODELS` (JSON map name -> path) and `MT_NER_ENDPOINT` (HTTP endpoint running
 *   the models) are set. Never required: without the env vars it returns `null`.
 */

/** One recognised entity. `start` / `end` are char offsets into the input text (`end` exclusive). */
export interface NerEntity {
  /** Surface form as it appears in the text. */
  text: string
  /** Entity type: the model name that produced it (OpenNLP model name, or a kind like `person`). */
  type: string
  start: number
  end: number
}

/** Pluggable NER backend: recognises the entities of one text. */
export interface NerBackend {
  /** Backend name (diagnostics). */
  name: string
  /** Recognises the entities of `text`. */
  recognize(text: string): NerEntity[] | Promise<NerEntity[]>
}

const byText = (a: NerEntity, b: NerEntity): number => a.text.localeCompare(b.text)

export interface NamedEntityRecognizer {
  /** The merged backends (at least one). */
  backends: NerBackend[]
  /** All entity occurrences of every backend, sorted by text (Java `recognizeEntities`). */
  recognizeEntities(text: string): Promise<NerEntity[]>
  /** The unique entities by exact text, sorted by text (Java `recognizeUniqueEntities`). */
  recognizeUniqueEntities(text: string): Promise<NerEntity[]>
}

export interface NamedEntityRecognizerOptions {
  /**
   * Backends to merge. Default: the built-in heuristic backend (always available,
   * works with no env set, no model files needed at import time).
   */
  backends?: NerBackend[]
}

export function createNamedEntityRecognizer(
  options: NamedEntityRecognizerOptions = {},
): NamedEntityRecognizer {
  const backends = options.backends ?? [heuristicEntityBackend]
  if (backends.length === 0) throw new Error('namedEntityRecognizer: at least one backend required')
  return {
    backends,
    async recognizeEntities(text: string): Promise<NerEntity[]> {
      const all: NerEntity[] = []
      for (const backend of backends) all.push(...(await backend.recognize(text)))
      return all.sort(byText)
    },
    async recognizeUniqueEntities(text: string): Promise<NerEntity[]> {
      const seen = new Set<string>()
      const unique: NerEntity[] = []
      for (const entity of await this.recognizeEntities(text)) {
        if (seen.has(entity.text)) continue
        seen.add(entity.text)
        unique.push(entity)
      }
      return unique
    },
  }
}

// --- heuristic backend (always available, no deps) ------------------------------------------

/** Honorific + name: `Dr. Aris Thorne`, `Lady Mara`. */
const HONORIFIC =
  /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sir|Dame|Lady|Lord|King|Queen|Prince|Princess|Captain|Sergeant|Master)\.?\s+([A-Z][\p{Ll}]+(?:['’-][\p{Ll}]+)*(?:\s+[A-Z][\p{Ll}]+(?:['’-][\p{Ll}]+)*){0,2})/gu

/** Capitalised word sequence: `Arin Vale`, `Iron Keep`, `Marta`. */
const CAPITALIZED =
  /\b[A-Z][\p{Ll}]+(?:['’-][\p{Ll}]+)*(?:(?:\s+(?:of(?:\s+the)?|de|von|van|der|den|la|le)\s+|\s+)[A-Z][\p{Ll}]+(?:['’-][\p{Ll}]+)*){0,3}/gu

/** Quoted name: `"Arin"`, `'Marta'`, `“the Iron Keep”`. */
const QUOTED = /"([^"\n]{2,40})"|'([^'\n]{2,40})'|“([^”\n]{2,40})”/g

/** True when the match sits inside a `[bracketed]` system message. */
function insideBrackets(text: string, index: number): boolean {
  const open = text.lastIndexOf('[', index)
  const close = text.lastIndexOf(']', index)
  return open > close
}

/** Drops the leading/trailing common words of a phrase (`The Iron Keep` -> `Iron Keep`). */
function trimCommon(phrase: string): string {
  const words = phrase.split(/\s+/)
  let lo = 0
  let hi = words.length - 1
  while (lo <= hi && isCommonWord(words[lo] ?? '')) lo++
  while (hi >= lo && isCommonWord(words[hi] ?? '')) hi--
  return words.slice(lo, hi + 1).join(' ')
}

/** Kind of a proper-name phrase, guessed from its last word. */
function kindOfPhrase(phrase: string): NerKind {
  const words = phrase.split(/\s+/)
  const last = words[words.length - 1] ?? ''
  if (PLACE_WORDS.test(last)) return 'place'
  if (ORG_WORDS.test(last)) return 'organization'
  if (words.length >= 2) return 'person'
  return isCommonWord(last) ? 'other' : 'person'
}

/** Start offset of the captured group (a suffix of the full match). */
function capAt(match: RegExpMatchArray): number {
  return (match.index ?? 0) + match[0].length - (match[1] ?? '').length
}

/**
 * Built-in NER backend: a pure-JS heuristic over honorifics, capitalised sequences and
 * quoted names. No dependencies, no model files, safe to import anywhere.
 */
export function createHeuristicEntityBackend(): NerBackend {
  return {
    name: 'heuristic',
    recognize(text: string): NerEntity[] {
      const entities: NerEntity[] = []
      const push = (surface: string, start: number, type: NerKind): void => {
        const phrase = trimCommon(surface)
        if (phrase === '' || isCommonWord(phrase)) return
        const shift = surface.indexOf(phrase)
        entities.push({
          text: phrase,
          type,
          start: start + shift,
          end: start + shift + phrase.length,
        })
      }

      for (const match of text.matchAll(HONORIFIC)) {
        if (insideBrackets(text, match.index ?? 0)) continue
        const name = match[1] ?? ''
        push(name, capAt(match), 'person')
      }
      for (const match of text.matchAll(CAPITALIZED)) {
        if (insideBrackets(text, match.index ?? 0)) continue
        const at = match.index ?? 0
        push(match[0], at, kindOfPhrase(trimCommon(match[0])))
      }
      for (const match of text.matchAll(QUOTED)) {
        if (insideBrackets(text, match.index ?? 0)) continue
        const raw = match[1] ?? match[2] ?? match[3] ?? ''
        const surface = raw.replace(/[,.!?;:]+$/u, '')
        if (surface === '') continue
        if (!/^[A-Z]/.test(surface) && !/\s[A-Z]/.test(surface)) continue
        // Quoted speech is kept verbatim (no common-word trimming).
        const at = (match.index ?? 0) + match[0].indexOf(raw)
        entities.push({ text: surface, type: 'person', start: at, end: at + surface.length })
      }
      return entities
    },
  }
}

/** The default backend: the built-in heuristic one. */
export const heuristicEntityBackend: NerBackend = createHeuristicEntityBackend()

// --- compromise backend (pure-JS NLP, lazy-loaded) ------------------------------------------

/** Minimal surface of the `compromise` doc we use (kept local so the lazy import stays typed). */
interface CompromiseMatchJson {
  terms?: Array<{ offset?: { start?: number; length?: number } }>
}
interface CompromiseDoc {
  match(selector: string): {
    json(options: { offset: true; terms: { offset: true } }): CompromiseMatchJson[]
  }
}

const COMPROMISE_SELECTORS: Array<[selector: string, type: string]> = [
  ['#Person+', 'person'],
  ['#Place+', 'place'],
  ['#Organization+', 'organization'],
]

/**
 * `compromise` NLP backend (pure JS, no model files). The library is imported lazily on the
 * first `recognize` call, so bundles that only use the heuristic backend never load it.
 */
export function createCompromiseNerBackend(): NerBackend {
  return {
    name: 'compromise',
    async recognize(text: string): Promise<NerEntity[]> {
      const mod: unknown = await import('compromise')
      const nlp =
        (mod as { default?: (input: string) => CompromiseDoc }).default ??
        (mod as (input: string) => CompromiseDoc)
      const doc = nlp(text)
      const entities: NerEntity[] = []
      for (const [selector, type] of COMPROMISE_SELECTORS) {
        for (const item of doc.match(selector).json({ offset: true, terms: { offset: true } })) {
          const first = item.terms?.[0]?.offset
          const last = item.terms?.[item.terms.length - 1]?.offset
          if (first?.start === undefined || last?.start === undefined || last.length === undefined)
            continue
          const start = first.start
          const end = last.start + last.length
          entities.push({ text: text.slice(start, end), type, start, end })
        }
      }
      return entities
    },
  }
}

// --- OpenNLP-model adapter (only enabled when configured) -----------------------------------

export interface OpenNlpNerBackendOptions {
  /** Model map (model name -> `.bin` model path). Default: parsed from `MT_NER_MODELS`. */
  models?: Record<string, string>
  /** HTTP endpoint that runs the OpenNLP models. Default: `MT_NER_ENDPOINT`. */
  endpoint?: string
  fetchFn?: typeof fetch
}

/** Parses the `MT_NER_MODELS` JSON map (name -> path); `{}` when unset or malformed. */
export function openNlpModelsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.MT_NER_MODELS
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const models: Record<string, string> = {}
    for (const [name, path] of Object.entries(parsed))
      if (typeof path === 'string') models[name] = path
    return models
  } catch {
    return {}
  }
}

function isNerEntityRow(row: unknown): row is NerEntity {
  if (row === null || typeof row !== 'object') return false
  const e = row as Record<string, unknown>
  return (
    typeof e.text === 'string' &&
    typeof e.type === 'string' &&
    typeof e.start === 'number' &&
    typeof e.end === 'number'
  )
}

/**
 * OpenNLP-model backend: delegates the `.bin` model work to an external HTTP endpoint
 * (`POST {text, models}` -> `{entities: [{text, type, start, end}]}`, `type` = model name).
 *
 * Enabled only when both a model map and an endpoint are configured; otherwise returns
 * `null` and the recognizer falls back to the other backends. Model files are never read
 * in this process and never at import time.
 */
export function createOpenNlpNerBackend(options: OpenNlpNerBackendOptions = {}): NerBackend | null {
  const models = options.models ?? openNlpModelsFromEnv()
  const endpoint = options.endpoint ?? process.env.MT_NER_ENDPOINT
  if (Object.keys(models).length === 0 || !endpoint) return null
  const fetchFn = options.fetchFn ?? fetch
  return {
    name: 'opennlp',
    async recognize(text: string): Promise<NerEntity[]> {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, models }),
      })
      if (!response.ok)
        throw new Error(
          `opennlp NER endpoint failed: HTTP ${response.status} ${await response.text()}`,
        )
      const payload: unknown = await response.json()
      const rows: unknown = (payload as { entities?: unknown }).entities
      return Array.isArray(rows) ? rows.filter(isNerEntityRow) : []
    },
  }
}

// --- adapter to the corpus-level candidate backend ------------------------------------------

function kindOfType(type: string): NerKind {
  if (type === 'person' || type === 'place' || type === 'organization') return type
  return 'other'
}

/**
 * Adapts a recognizer to the corpus-level {@link CandidateNerBackend} of `ner-candidates.ts`,
 * so it can seed the glossary extractor (`options.nerBackend`) — counts occurrences and
 * tracks the first chapter per entity text.
 */
export function createCandidateNerBackend(recognizer: NamedEntityRecognizer): CandidateNerBackend {
  return {
    name: `candidates:${recognizer.backends.map((b) => b.name).join('+')}`,
    async extract(chapters): Promise<NerCandidate[]> {
      const found = new Map<string, NerCandidate>()
      for (const { chapter, text } of chapters) {
        for (const entity of await recognizer.recognizeEntities(text)) {
          const key = entity.text.toLowerCase()
          const current = found.get(key)
          if (current) {
            current.count = (current.count ?? 1) + 1
            current.firstChapter = Math.min(current.firstChapter ?? chapter, chapter)
          } else {
            found.set(key, {
              text: entity.text,
              kind: kindOfType(entity.type),
              count: 1,
              firstChapter: chapter,
            })
          }
        }
      }
      return [...found.values()]
    },
  }
}

// --- tool -----------------------------------------------------------------------------------

export interface NamedEntityToolOptions extends NamedEntityRecognizerOptions {}

/**
 * Tool: named-entity recognition on `env.item` / `env.items`. The item is left untouched;
 * the unique entities (merged across inputs, sorted by text) land in `meta.entities`.
 */
export function createNamedEntityTool(options: NamedEntityToolOptions = {}) {
  const recognizer = createNamedEntityRecognizer(options)
  return defineTool<string | string[], string | string[]>({
    name: 'named-entity-recognizer',
    version: '1.0.0',
    mdDescription:
      'Named-entity recognition (pluggable backends: built-in heuristic, `compromise` NLP, ' +
      'optional OpenNLP models via MT_NER_MODELS + MT_NER_ENDPOINT). The item is untouched; ' +
      'the unique entities (by text, sorted) land in `meta.entities`.',
    async invoke(env: Envelope<string | string[]>): Promise<Envelope<string | string[]>> {
      const inputs = (env.items ?? [env.item]).flat()
      const byText = new Map<string, NerEntity>()
      for (const input of inputs) {
        for (const entity of await recognizer.recognizeUniqueEntities(input)) {
          if (!byText.has(entity.text)) byText.set(entity.text, entity)
        }
      }
      const entities = [...byText.values()].sort((a, b) => a.text.localeCompare(b.text))
      return { ...env, meta: { ...env.meta, entities } }
    },
  })
}

export const namedEntityTool = createNamedEntityTool()
