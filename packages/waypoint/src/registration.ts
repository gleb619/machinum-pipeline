import type { ParsedUri, Source, Target } from '@mt/core'
import { annotate, registry, waypoint } from '@mt/core'

/** One side (source or target) of a waypoint registration. */
export interface WaypointSide<T> {
  /** The factory that is annotated and registered in the URI registry. */
  factory: (uri: ParsedUri) => T
  /** Annotation display name. */
  name: string
  /** What the waypoint does. */
  description: string
  /** URI schemes the annotation lists. */
  schemes: readonly string[]
  /** URI schemes the factory is registered under (defaults to `schemes`). */
  registerSchemes?: readonly string[]
}

/** Seal the runtime `waypoint` annotation on a factory. */
export function annotateWaypoint(
  factory: object,
  options: {
    /** Annotation id — one id may cover several schemes and directions. */
    id: string
    name: string
    description: string
    schemes: readonly string[]
    direction: 'source' | 'target'
  },
): void {
  annotate(
    factory,
    waypoint(options.id, {
      name: options.name,
      description: options.description,
      meta: { schemes: [...options.schemes], direction: options.direction },
    }),
  )
}

/**
 * Register a waypoint source/target pair and seal the runtime annotations.
 *
 * Every scheme module repeats the same `annotate(factory, waypoint(id, …))` +
 * `registry.registerSource/Target` pair; this helper seals it once. A side may
 * be omitted — a target-only scheme passes just `target`.
 */
export function registerWaypointPair(options: {
  /** Annotation id — one id may cover several schemes and directions. */
  id: string
  /** The source side of the pair. */
  source?: WaypointSide<Source<unknown>>
  /** The target side of the pair. */
  target?: WaypointSide<Target<unknown>>
}): void {
  const { id, source, target } = options

  if (source) {
    annotateWaypoint(source.factory, {
      id,
      name: source.name,
      description: source.description,
      schemes: source.schemes,
      direction: 'source',
    })
    for (const scheme of source.registerSchemes ?? source.schemes) {
      registry.registerSource(scheme, source.factory)
    }
  }

  if (target) {
    annotateWaypoint(target.factory, {
      id,
      name: target.name,
      description: target.description,
      schemes: target.schemes,
      direction: 'target',
    })
    for (const scheme of target.registerSchemes ?? target.schemes) {
      registry.registerTarget(scheme, target.factory)
    }
  }
}
