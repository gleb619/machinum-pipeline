import { annotationOf, annotationsOf, resetAnnotationRegistry } from '@mt/core'
import { beforeEach, describe, expect, it } from 'vitest'
import * as tools from '../src/index.js'
import { TOOL_CATEGORIES } from '../src/index.js'

interface ToolShape {
  readonly invoke: (...args: unknown[]) => unknown
  readonly name: string
  readonly version: string
}

function isToolShape(value: unknown): value is ToolShape {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.invoke === 'function' &&
    typeof record.name === 'string' &&
    typeof record.version === 'string'
  )
}

function collectToolExports(): Array<[string, ToolShape]> {
  const found: Array<[string, ToolShape]> = []
  for (const [exportName, value] of Object.entries(tools)) {
    if (isToolShape(value)) {
      found.push([exportName, value])
    }
  }
  return found
}

describe('tool annotations', () => {
  beforeEach(() => {
    resetAnnotationRegistry()
  })

  it('exports exactly 75 tool-shaped values', () => {
    const toolExports = collectToolExports()
    const names = toolExports.map(([exportName]) => exportName).sort()
    expect(
      toolExports.length,
      `expected 75 tool-shaped exports, got ${toolExports.length}: ${names.join(', ')}`,
    ).toBe(75)
  })

  it('annotates every tool-shaped export with a valid TL annotation', () => {
    for (const [exportName, value] of collectToolExports()) {
      const annotation = annotationOf(value, 'tool')
      expect(
        annotation,
        `${exportName}: missing @mt/core 'tool' annotation (expected tool('TL###', ...) on the exported value)`,
      ).toBeDefined()
      if (!annotation) {
        continue
      }

      expect(
        annotation.id,
        `${exportName}: tool annotation id '${annotation.id}' does not match /^TL\\d{3,}$/`,
      ).toMatch(/^TL\d{3,}$/)

      for (const ref of annotation.refs) {
        expect(
          ref,
          `${exportName}: tool annotation '${annotation.id}' ref '${ref}' does not match /^UC\\d{3}$/`,
        ).toMatch(/^UC\d{3}$/)
      }

      if (annotation.name !== undefined) {
        expect(
          annotation.name,
          `${exportName}: tool annotation name '${annotation.name}' does not equal tool name '${value.name}'`,
        ).toBe(value.name)
      }

      const useCaseAnnotation = annotationOf(value, 'useCase')
      if (useCaseAnnotation) {
        expect(
          annotation.refs,
          `${exportName}: useCase annotation '${useCaseAnnotation.id}' is not included in tool annotation '${annotation.id}' refs [${annotation.refs.join(', ')}]`,
        ).toContain(useCaseAnnotation.id)
      }
    }
  })

  it('annotates every tool-shaped export with exactly one valid category', () => {
    const categorySet = new Set<string>(TOOL_CATEGORIES)
    for (const [exportName, value] of collectToolExports()) {
      const categories = annotationsOf(value).filter((annotation) => annotation.kind === 'category')
      expect(
        categories.length,
        `${exportName}: expected exactly one 'category' annotation, got ${categories.length}`,
      ).toBe(1)

      const annotation = annotationOf(value, 'category')
      if (!annotation) {
        continue
      }

      expect(
        annotation.categories.length,
        `${exportName}: category annotation must list at least one category`,
      ).toBeGreaterThan(0)

      for (const name of annotation.categories) {
        expect(
          name,
          `${exportName}: category '${name}' does not match /^[a-z][a-z0-9-]*$/`,
        ).toMatch(/^[a-z][a-z0-9-]*$/)
        expect(
          categorySet.has(name),
          `${exportName}: category '${name}' is not in TOOL_CATEGORIES (${TOOL_CATEGORIES.join(', ')})`,
        ).toBe(true)
      }
    }
  })

  it('uses TL ids uniquely across distinct tool objects (aliases share one object/id)', () => {
    const byId = new Map<string, Array<{ exportName: string; value: ToolShape }>>()
    for (const [exportName, value] of collectToolExports()) {
      const annotation = annotationOf(value, 'tool')
      if (!annotation) {
        // reported by the annotation test above
        continue
      }
      const group = byId.get(annotation.id) ?? []
      group.push({ exportName, value })
      byId.set(annotation.id, group)
    }

    const duplicates: string[] = []
    for (const [id, group] of byId) {
      const distinctObjects = new Set(group.map((entry) => entry.value))
      if (distinctObjects.size > 1) {
        const names = group.map((entry) => entry.exportName).join(', ')
        duplicates.push(`${id} (${names})`)
      }
    }

    expect(duplicates, `TL ids shared by distinct tool objects: ${duplicates.join('; ')}`).toEqual(
      [],
    )
  })
})
