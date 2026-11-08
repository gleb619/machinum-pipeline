import type {
  AnnotationFactories,
  AnnotationKindFactory,
  AnnotationRecord,
  AnnotationSpec,
  CategoryAnnotation,
  CategoryFactory,
  IdAnnotation,
} from './types/annotation.js'
export type {
  AnnotationSpec,
  IdAnnotation,
  CategoryAnnotation,
  AnnotationKindFactory,
  CategoryFactory,
  AnnotationFactories,
  AnnotationRecord,
} from './types/annotation.js'
/**
 * Runtime annotations — one common mechanism, four sealed kinds.
 *
 * The engine works with plain values, not classes: a Tool is an object produced by
 * `defineTool()`, a waypoint is a factory function, a use case is a command or a DSL
 * entry point. ECMAScript decorators cannot target those values, so annotations are
 * ordinary frozen metadata records attached through `annotate()` (WeakMap + a
 * non-enumerable symbol, so the annotated value keeps its shape and never leaks into
 * serialization).
 *
 * Kinds are a closed set (`tool`, `waypoint`, `useCase`, `category`). `annotations` is
 * optional everywhere: user-defined tools need no annotation at all. Each ID kind is
 * produced by a frozen factory with its own namespace and pattern; `category` instead
 * carries a frozen list of lowercase category names. No third-party code can mint a new
 * kind or a free-form ID.
 */

/** Closed set of annotation kinds. Adding a kind is a deliberate core API change. */
export const ANNOTATION_KINDS = Object.freeze(['tool', 'waypoint', 'useCase', 'category'] as const)

export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

/** Kinds that carry an `id` from a fixed namespace. */
export type IdAnnotationKind = Exclude<AnnotationKind, 'category'>

/** Immutable annotation record attached to a runtime value. */
export type Annotation = IdAnnotation | CategoryAnnotation

/** Symbol used for the non-enumerable attachment. */
export const ANNOTATION_KEY: unique symbol = Symbol.for('mt.annotation')

const attached = new WeakMap<object, readonly Annotation[]>()
const registry: AnnotationRecord[] = []
const CATEGORY_PATTERN = Object.freeze(/^[a-z][a-z0-9-]*$/)

function freezeSpec(spec: AnnotationSpec | undefined): {
  name?: string
  description?: string
  refs: readonly string[]
  meta: Readonly<Record<string, unknown>>
} {
  const refs = Object.freeze([...(spec?.refs ?? [])])
  const meta = Object.freeze({ ...(spec?.meta ?? {}) })
  // exactOptionalPropertyTypes is off, but keep undefined out of the frozen shape.
  return {
    ...(spec?.name === undefined ? {} : { name: spec.name }),
    ...(spec?.description === undefined ? {} : { description: spec.description }),
    refs,
    meta,
  }
}

/**
 * Build one sealed ID kind. The returned function validates the namespace and returns a
 * frozen annotation; the function itself is frozen and its metadata is read-only.
 */
function createAnnotationKind(kind: IdAnnotationKind, prefix: string): AnnotationKindFactory {
  const pattern = new RegExp(`^${prefix}\\d{3,}$`)
  const factory = (id: string, spec?: AnnotationSpec): IdAnnotation => {
    if (!pattern.test(id)) {
      throw new Error(
        `Invalid ${kind} annotation id '${id}' — expected ${prefix} followed by at least 3 digits (e.g. ${prefix}001)`,
      )
    }
    return Object.freeze({ kind, id, ...freezeSpec(spec) })
  }
  return Object.freeze(
    Object.assign(factory, { kind, prefix, pattern: Object.freeze(pattern) }),
  ) as AnnotationKindFactory
}

function createCategoryFactory(): CategoryFactory {
  const factory = (categories: readonly string[], spec?: AnnotationSpec): CategoryAnnotation => {
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('Category annotation needs a non-empty array of category names')
    }
    const unique: string[] = []
    for (const name of categories) {
      if (typeof name !== 'string' || !CATEGORY_PATTERN.test(name)) {
        throw new Error(
          `Invalid category '${String(name)}' — expected lowercase kebab-case (e.g. 'validator')`,
        )
      }
      if (!unique.includes(name)) unique.push(name)
    }
    return Object.freeze({
      kind: 'category',
      categories: Object.freeze(unique),
      ...freezeSpec(spec),
    })
  }
  return Object.freeze(
    Object.assign(factory, { kind: 'category' as const, pattern: CATEGORY_PATTERN }),
  ) as CategoryFactory
}

/** Tool annotation — `TL###` (the tool index in docs/steering/tools.md). */
export const tool = createAnnotationKind('tool', 'TL')

/** Waypoint annotation — `WT###` (the URI-scheme index in docs/steering/waypoint.md). */
export const waypoint = createAnnotationKind('waypoint', 'WT')

/** Use-case annotation — `UC###` (the use-case index in docs/guiding/uc.md). */
export const useCase = createAnnotationKind('useCase', 'UC')

/** Category annotation — `category(['validator', 'markdown'])`. */
export const category = createCategoryFactory()

/** Every kind factory, keyed by kind. Sealed to the four kinds above. */
export const ANNOTATION_FACTORIES: Readonly<AnnotationFactories> = Object.freeze({
  tool,
  waypoint,
  useCase,
  category,
})

function assertAnnotation(value: unknown): asserts value is Annotation {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      'Annotation must be an object created by tool(), waypoint(), useCase() or category()',
    )
  }
  const kind = (value as { kind?: unknown }).kind
  if (!ANNOTATION_KINDS.includes(kind as AnnotationKind)) {
    throw new Error(
      `Unknown annotation kind '${String(kind)}' — allowed: ${ANNOTATION_KINDS.join(', ')}`,
    )
  }
  if (!Object.isFrozen(value)) {
    throw new Error(
      'Annotation must be frozen — create it with tool(), waypoint(), useCase() or category()',
    )
  }
  if (kind === 'category') {
    const categories = (value as { categories?: unknown }).categories
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('Category annotation needs a non-empty categories array')
    }
  }
}

function labelOf(annotation: Annotation): string {
  return 'id' in annotation ? annotation.id : annotation.categories.join(',')
}

function targetNameOf(target: object): string {
  if ('name' in target && typeof (target as { name?: unknown }).name === 'string') {
    return (target as { name: string }).name
  }
  if ('uri' in target && typeof (target as { uri?: unknown }).uri === 'string') {
    return (target as { uri: string }).uri
  }
  const ctor = (target as { constructor?: { name?: string } }).constructor
  return ctor?.name ?? 'anonymous'
}

function mergeAnnotations(
  target: object,
  existing: readonly Annotation[],
  incoming: readonly Annotation[],
): readonly Annotation[] {
  const byKind = new Map<AnnotationKind, Annotation>(existing.map((a) => [a.kind, a]))
  for (const annotation of incoming) {
    assertAnnotation(annotation)
    const previous = byKind.get(annotation.kind)
    if (previous && labelOf(previous) !== labelOf(annotation)) {
      throw new Error(
        `${annotation.kind} '${targetNameOf(target)}' already annotated with ${labelOf(previous)}; ` +
          `refusing to replace it with ${labelOf(annotation)}`,
      )
    }
    byKind.set(annotation.kind, annotation)
  }
  return Object.freeze([...byKind.values()])
}

/**
 * Attach one or more annotations to a runtime value (tool instance, waypoint factory,
 * command function, class constructor, ...) and return the same value. At most one
 * annotation per kind; re-attaching the same kind/label is idempotent. Every attachment
 * is also recorded in the process-wide registry.
 */
export function annotate<T extends object>(target: T, ...annotations: Annotation[]): T {
  if (annotations.length === 0) return target
  const existing = attached.get(target) ?? []
  const merged = mergeAnnotations(target, existing, annotations)
  attached.set(target, merged)
  Object.defineProperty(target, ANNOTATION_KEY, {
    value: merged,
    configurable: true,
    enumerable: false,
    writable: false,
  })
  for (const annotation of merged) {
    const record: AnnotationRecord = {
      annotation,
      targetName: targetNameOf(target),
      target,
    }
    const index = registry.findIndex(
      (r) => r.target === target && r.annotation.kind === annotation.kind,
    )
    if (index >= 0) registry[index] = record
    else registry.push(record)
  }
  return target
}

/** Annotations attached to one value (empty when unannotated). */
export function annotationsOf(target: object): readonly Annotation[] {
  return attached.get(target) ?? []
}

/** One annotation of the requested kind, if present. */
export function annotationOf(target: object, kind: 'category'): CategoryAnnotation | undefined
export function annotationOf(target: object, kind: IdAnnotationKind): IdAnnotation | undefined
export function annotationOf(target: object, kind: AnnotationKind): Annotation | undefined
export function annotationOf(target: object, kind: AnnotationKind): Annotation | undefined {
  return annotationsOf(target).find((annotation) => annotation.kind === kind)
}

/** True when the value carries at least one annotation. */
export function isAnnotated(target: object): boolean {
  return annotationsOf(target).length > 0
}

/** Every annotation registered in this process, in attachment order. */
export function listAnnotations(kind?: AnnotationKind): readonly AnnotationRecord[] {
  return kind ? registry.filter((r) => r.annotation.kind === kind) : Object.freeze([...registry])
}

/**
 * Look up ID annotations by ID. Use-case IDs intentionally repeat across implementations,
 * so this returns every match; tool/waypoint IDs are expected to be unique.
 */
export function findAnnotation(id: string): readonly AnnotationRecord[] {
  return registry.filter((record) => 'id' in record.annotation && record.annotation.id === id)
}

/** Drop the registry. Test/scanning helper — attached metadata on values stays intact. */
export function resetAnnotationRegistry(): void {
  registry.length = 0
}

/**
 * Standard ECMAScript decorator adapter for class declarations and methods.
 *
 * ```ts
 * @decorate(useCase('UC006', { name: 'Resume a run' }))
 * class ResumeFlow {}
 * ```
 *
 * It stores the annotation in the same WeakMap/symbol as `annotate()`; it deliberately
 * does not use `context.metadata`, so the project does not need the `ESNext` lib.
 */
export function decorate(annotation: Annotation) {
  assertAnnotation(annotation)
  return <T extends object>(target: T, _context?: unknown): T => annotate(target, annotation)
}
