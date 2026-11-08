import type { ANNOTATION_KINDS } from '../annotation.js'

/** Closed-set annotation kinds: `tool`, `waypoint`, `useCase`, `category`. */
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

/** Kinds that carry an `id` from a fixed namespace. */
export type IdAnnotationKind = Exclude<AnnotationKind, 'category'>

/** Optional human context carried by every annotation. */
export interface AnnotationSpec {
  /** Short display name. Falls back to the annotated value's own name. */
  name?: string
  /** What the annotated unit does. */
  description?: string
  /** Related IDs, e.g. a tool's use cases (`['UC055', 'UC057']`). */
  refs?: readonly string[]
  /** Kind-specific extra data (e.g. URI schemes for a waypoint). */
  meta?: Readonly<Record<string, unknown>>
}

interface AnnotationBase {
  readonly name?: string
  readonly description?: string
  readonly refs: readonly string[]
  readonly meta: Readonly<Record<string, unknown>>
}

/** Annotation with a namespace ID (`TL001`, `WT001`, `UC005`). */
export interface IdAnnotation extends AnnotationBase {
  readonly kind: IdAnnotationKind
  readonly id: string
}

/** Category annotation — a frozen, non-empty list of category names. */
export interface CategoryAnnotation extends AnnotationBase {
  readonly kind: 'category'
  readonly categories: readonly string[]
}

/** Immutable annotation record attached to a runtime value. */
export type Annotation = IdAnnotation | CategoryAnnotation

/** A sealed ID kind: callable factory plus its namespace metadata. */
export interface AnnotationKindFactory {
  readonly kind: IdAnnotationKind
  /** ID namespace, e.g. `TL` for `TL001`. */
  readonly prefix: string
  /** Validation pattern every ID of this kind must match. */
  readonly pattern: RegExp
  (id: string, spec?: AnnotationSpec): IdAnnotation
}

/** The sealed `category` kind: accepts a list of lowercase names instead of an ID. */
export interface CategoryFactory {
  readonly kind: 'category'
  /** Validation pattern every category name must match. */
  readonly pattern: RegExp
  (categories: readonly string[], spec?: AnnotationSpec): CategoryAnnotation
}

/** Every kind factory, keyed by kind. */
export interface AnnotationFactories {
  readonly tool: AnnotationKindFactory
  readonly waypoint: AnnotationKindFactory
  readonly useCase: AnnotationKindFactory
  readonly category: CategoryFactory
}

/** Record kept by the process-wide registry for every annotated value. */
export interface AnnotationRecord {
  readonly annotation: Annotation
  /** Display name derived from the annotated value (`tool.name`, `uri`, function name). */
  readonly targetName: string
  readonly target: object
}
