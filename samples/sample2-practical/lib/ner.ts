import { defineTool, getVariable, withItem } from '@mt/core'
import {
  type Glossary,
  type GlossaryTermType,
  appendMdOutput,
  chapterNumberOf,
  compileTermMatcher,
  countTerms,
} from '@mt/tools'

/**
 * Stage 3 of the book flow: main entities (characters, places, organisations, assets) from the
 * book-wide glossary extractor, projected back onto chapters with the tagger's own matching
 * rules. Projection is pure and LLM-free; only the glossary pass talks to a model.
 */

/** Kinds of the NER stage. `organisations` are derived: `GlossaryTermType` has no such type. */
export type EntityKind = 'character' | 'place' | 'organisation' | 'asset' | 'other'

/** Book-wide kind order of `entities.json` (then `-count`, then code-point name). */
const KIND_ORDER: readonly EntityKind[] = ['character', 'place', 'organisation', 'asset', 'other']

/** A glossary `term` is an organisation only when the model described it as one. */
const ORGANISATION = /organi[sz]ation|authority|company|agency|crew/i

const VERSION = 1

export interface NerEntity {
  id: string
  name: string
  kind: EntityKind
  aliases: string[]
  firstChapter: number
  count: number
  chapters: number[]
  description: string
}

export interface ChapterEntity {
  id: string
  name: string
  kind: EntityKind
  count: number
}

/** `chapters/schema/chapter<N>.entities.json` (one per chapter, empty list included). */
export interface ChapterEntities {
  n: number
  entities: ChapterEntity[]
}

/** `chapters/schema/entities.json` (stable key order, no timestamps). */
export interface EntitiesArtifact {
  version: number
  entities: NerEntity[]
}

/** One chapter of the analysed corpus. */
export interface NerChapter {
  n: number
  text: string
}

export interface NerProjection {
  entities: NerEntity[]
  chapters: ChapterEntities[]
  /** Terms the projection never found: the model's hallucinated entries (R3). */
  dropped: number
}

/**
 * Glossary type -> NER kind. `item` becomes `asset`; a `term` becomes `organisation` only when
 * its description names an organisation-like body, everything else is `other`.
 */
export function entityKind(type: GlossaryTermType, description?: string): EntityKind {
  switch (type) {
    case 'character':
      return 'character'
    case 'place':
      return 'place'
    case 'item':
      return 'asset'
    case 'term':
      return ORGANISATION.test(description ?? '') ? 'organisation' : 'other'
    default:
      return 'other'
  }
}

/** Code-point order (locale-independent, so a rerun is byte-identical everywhere). */
function byCodePoint(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * Projects the book-wide glossary onto chapters without an LLM: `compileTermMatcher` +
 * `countTerms` give every term its per-chapter counts, so an entity carries `chapters[]` and a
 * per-chapter list. A term the projection never finds (count 0) is dropped - a model-proposed
 * name that does not occur in the corpus never reaches `entities.json` (R3).
 */
export function projectEntities(glossary: Glossary, inputs: readonly NerChapter[]): NerProjection {
  const chapters = [...inputs].sort((left, right) => left.n - right.n)
  const matcher = compileTermMatcher(glossary)
  const perChapter = chapters.map(({ n, text }) => ({
    n,
    counts: countTerms(text, glossary, matcher),
  }))

  const totals = new Map<string, number>()
  for (const { counts } of perChapter) {
    for (const [id, count] of counts) totals.set(id, (totals.get(id) ?? 0) + count)
  }

  let dropped = 0
  const entities: NerEntity[] = []
  for (const term of glossary.terms) {
    const count = totals.get(term.id) ?? 0
    if (count === 0) {
      dropped++
      continue
    }
    const seen = perChapter.filter(({ counts }) => (counts.get(term.id) ?? 0) > 0).map(({ n }) => n)
    entities.push({
      id: term.id,
      name: term.term,
      kind: entityKind(term.type, term.description),
      aliases: [...term.aliases],
      firstChapter: seen[0] ?? term.firstChapter ?? 0,
      count,
      chapters: seen,
      description: term.description ?? '',
    })
  }
  entities.sort(
    (left, right) =>
      KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) ||
      right.count - left.count ||
      byCodePoint(left.name, right.name),
  )

  const chapterEntities: ChapterEntities[] = perChapter.map(({ n, counts }) => ({
    n,
    entities: entities
      .filter((entity) => (counts.get(entity.id) ?? 0) > 0)
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        count: counts.get(entity.id) ?? 0,
      })),
  }))

  return { entities, chapters: chapterEntities, dropped }
}

/** The repo formatter (Biome) wraps JSON at 100 columns. */
const JSON_WIDTH = 100

/**
 * Numeric array in the repo formatter's shape: `JSON.stringify` always breaks it one value per
 * line, Biome keeps it on the attribute line while it fits and fills otherwise. Emitting the
 * formatter's own shape keeps `pnpm lint` green after a pipeline run.
 */
function numberArray(values: readonly number[], indent: number): string {
  const inline = `[${values.join(', ')}]`
  if (indent + '"chapters": '.length + inline.length <= JSON_WIDTH) return inline
  const pad = ' '.repeat(indent + 2)
  const lines: string[] = []
  let line = ''
  for (const value of values) {
    const piece = String(value)
    if (line === '') {
      line = piece
    } else if (pad.length + line.length + 2 + piece.length <= JSON_WIDTH) {
      line += `, ${piece}`
    } else {
      lines.push(line)
      line = piece
    }
  }
  if (line !== '') lines.push(line)
  return `[\n${lines.map((text) => pad + text).join(',\n')}\n${' '.repeat(indent)}]`
}

export function serializeEntities(entities: readonly NerEntity[]): string {
  const artifact: EntitiesArtifact = { version: VERSION, entities: [...entities] }
  const json = JSON.stringify(artifact, null, 2).replace(
    /^( *)"chapters": \[\n([\s\S]*?)\n\1\](,?)/gm,
    (_match, indent: string, body: string, comma: string) => {
      const values = body.split(/,\n/).map((line) => Number(line.trim()))
      return `${indent}"chapters": ${numberArray(values, indent.length)}${comma}`
    },
  )
  return `${json}\n`
}

export function serializeChapterEntities(chapter: ChapterEntities): string {
  return `${JSON.stringify(chapter, null, 2)}\n`
}

/** Names the offline mock proposes; the hallucination never occurs in book2 (R3 fixture). */
export const MOCK_NER_NAMES = ['Nadia Okonkwo', 'Emeka Okonkwo', 'Marrow Bay']
export const MOCK_NER_HALLUCINATION = 'Zephyr Quillon'

export const MOCK_NER_ANSWER = JSON.stringify([
  {
    name: 'Nadia Okonkwo',
    category: 'Character',
    description: 'An audio archivist searching for her missing brother.',
    references: [],
  },
  {
    name: 'Emeka Okonkwo',
    category: 'Character',
    description: 'Nadia’s brother, missing since the Pelargic sank.',
    references: [],
  },
  {
    name: 'Marrow Bay',
    category: 'Location',
    description: 'The coastal town where the archive sits.',
    references: [],
  },
  {
    name: MOCK_NER_HALLUCINATION,
    category: 'Character',
    description: 'An invented archivist who never appears in the book.',
    references: [],
  },
])

/**
 * Emits `chapters/schema/entities.json` (book-wide, ordered kind -> `-count` -> name) and one
 * `chapters/schema/chapter<N>.entities.json` for every batched chapter, even when the chapter
 * has no mention (the translator's slot loader never misses a file).
 */
export const writeEntities = defineTool<unknown, string>({
  name: 'write-entities',
  version: '1.0.0',
  description:
    'Projects the `glossary` variable onto the batched chapters and emits schema/entities.json plus schema/chapter<N>.entities.json.',
  async invoke(env, ctx) {
    const glossary = getVariable<Glossary>(env, 'glossary')
    if (!glossary) {
      throw new Error(
        'write-entities: the `glossary` variable is missing (run the glossary extractor first)',
      )
    }
    const inputs = (env.items ?? [env.item]).flat().map((item) => String(item))
    const chapters = inputs.map((text, index) => ({
      n: chapterNumberOf(text, index + 1),
      text,
    }))
    const projection = projectEntities(glossary, chapters)
    const calls = getVariable<{ attempts?: number }>(env, 'glossaryLlm')?.attempts ?? 0
    ctx.run.logger.info(
      `ner entities=${projection.entities.length} dropped=${projection.dropped} calls=${calls}`,
    )

    let out = appendMdOutput(withItem(env, ''), {
      name: 'entities',
      subdir: '',
      filename: 'entities.json',
      content: serializeEntities(projection.entities),
    })
    for (const chapter of projection.chapters) {
      out = appendMdOutput(out, {
        name: 'chapter-entities',
        subdir: '',
        filename: `chapter${chapter.n}.entities.json`,
        content: serializeChapterEntities(chapter),
      })
    }
    return out
  },
})
