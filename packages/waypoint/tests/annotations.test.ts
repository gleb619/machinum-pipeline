import type { Annotation } from '@mt/core'
import { annotationsOf, listAnnotations, registry, resetAnnotationRegistry } from '@mt/core'
import { beforeEach, describe, expect, it } from 'vitest'
import * as wp from '../src/index.js'
import '@mt/waypoint'

const CREATE_FACTORY = /^create[A-Za-z0-9]*(?:Source|Target)$/

type Factory = (...args: never[]) => unknown

function exportedFactories(): Array<readonly [string, Factory]> {
  return Object.entries(wp)
    .filter(([name, value]) => CREATE_FACTORY.test(name) && typeof value === 'function')
    .map(([name, value]) => [name, value as Factory] as const)
}

function waypointAnnotation(target: object, name: string): Annotation {
  const annotations = annotationsOf(target).filter((annotation) => annotation.kind === 'waypoint')
  expect(annotations, `${name} should have exactly one waypoint annotation`).toHaveLength(1)
  const [annotation] = annotations
  if (!annotation) throw new Error(`${name} has no waypoint annotation`)
  return annotation
}

function schemesOf(annotation: Annotation, name: string): readonly string[] {
  const schemes = annotation.meta.schemes
  expect(Array.isArray(schemes), `${name} meta.schemes should be an array`).toBe(true)
  if (!Array.isArray(schemes)) return []
  const values: unknown[] = schemes
  const strings = values.filter((scheme): scheme is string => typeof scheme === 'string')
  expect(strings.length, `${name} meta.schemes should only contain strings`).toBe(values.length)
  expect(strings.length, `${name} meta.schemes should not be empty`).toBeGreaterThan(0)
  return strings
}

/** Role of the factory — `source`, `target` or `both`. */
function directionOf(annotation: Annotation, name: string): string {
  const direction = annotation.meta.direction
  expect(typeof direction, `${name} meta.direction should be a string`).toBe('string')
  expect(['source', 'target', 'both']).toContain(direction)
  return String(direction)
}

describe('waypoint annotations', () => {
  beforeEach(() => {
    resetAnnotationRegistry()
  })

  it('annotates every exported create*Source/create*Target factory', () => {
    const factories = exportedFactories()
    expect(factories.length).toBeGreaterThan(0)

    for (const [name, factory] of factories) {
      const annotation = waypointAnnotation(factory, name)
      expect(annotation.id, `${name} should carry a WT id`).toMatch(/^WT\d{3,}$/)
      expect(schemesOf(annotation, name).length).toBeGreaterThan(0)
    }
  })

  it('keeps each WT id and direction mapped to one scheme set', () => {
    const schemeSets = new Map<string, string>()

    for (const [name, factory] of exportedFactories()) {
      const annotation = waypointAnnotation(factory, name)
      const key = [...schemesOf(annotation, name)].sort().join(',')
      // One id may carry both roles (e.g. WT003: `hs://`/`http://` source, `http://`/`https://`
      // target), so the scheme set is pinned per id AND direction.
      const id = `${annotation.id}:${directionOf(annotation, name)}`
      const existing = schemeSets.get(id)
      if (existing !== undefined) {
        expect(existing, `${id} maps to two different scheme sets`).toBe(key)
      }
      schemeSets.set(id, key)
    }

    expect(schemeSets.size).toBeGreaterThan(0)
  })

  it('annotates WT003 with both a source and a target direction', () => {
    const directions = new Set(
      exportedFactories()
        .filter(([, factory]) => waypointAnnotation(factory, 'WT003').id === 'WT003')
        .map(([name, factory]) => directionOf(waypointAnnotation(factory, name), name)),
    )
    expect([...directions].sort()).toEqual(['source', 'target'])
  })

  it('covers every registered source and target scheme', () => {
    const covered = new Set<string>()

    for (const [name, factory] of exportedFactories()) {
      for (const scheme of schemesOf(waypointAnnotation(factory, name), name)) {
        covered.add(scheme)
      }
    }

    for (const scheme of registry.getSourceSchemes()) {
      expect(covered.has(scheme), `source scheme '${scheme}' has no waypoint annotation`).toBe(true)
    }
    for (const scheme of registry.getTargetSchemes()) {
      expect(covered.has(scheme), `target scheme '${scheme}' has no waypoint annotation`).toBe(true)
    }
  })

  it('resetAnnotationRegistry clears the process registry', () => {
    expect(listAnnotations('waypoint')).toEqual([])
  })
})
