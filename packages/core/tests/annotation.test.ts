import { beforeEach, describe, expect, it } from 'vitest'
import {
  ANNOTATION_FACTORIES,
  ANNOTATION_KINDS,
  annotate,
  annotationOf,
  annotationsOf,
  decorate,
  findAnnotation,
  isAnnotated,
  listAnnotations,
  resetAnnotationRegistry,
  tool,
  useCase,
  waypoint,
} from '../src/annotation.js'
import { defineTool } from '../src/dsl.js'

describe('annotations', () => {
  beforeEach(() => {
    resetAnnotationRegistry()
  })

  it('exposes exactly three sealed kinds', () => {
    expect(ANNOTATION_KINDS).toEqual(['tool', 'waypoint', 'useCase'])
    expect(Object.isFrozen(ANNOTATION_KINDS)).toBe(true)
    expect(Object.isFrozen(ANNOTATION_FACTORIES)).toBe(true)
    expect(Object.keys(ANNOTATION_FACTORIES)).toEqual(['tool', 'waypoint', 'useCase'])
  })

  it('validates the ID namespace per kind', () => {
    expect(tool('TL001').kind).toBe('tool')
    expect(waypoint('WT014').kind).toBe('waypoint')
    expect(useCase('UC055').kind).toBe('useCase')
    expect(() => tool('WT001')).toThrow(/Invalid tool annotation id 'WT001'/)
    expect(() => waypoint('TL001')).toThrow(/Invalid waypoint annotation id 'TL001'/)
    expect(() => useCase('UC55')).toThrow(/Invalid useCase annotation id 'UC55'/)
  })

  it('returns frozen metadata records', () => {
    const refs = ['UC055', 'UC057']
    const annotation = tool('TL200', {
      name: 'chapter-validator',
      description: 'Validates markdown structure',
      refs,
      meta: { file: 'chapter-validator.ts' },
    })
    refs.push('UC058')

    expect(Object.isFrozen(annotation)).toBe(true)
    expect(Object.isFrozen(annotation.refs)).toBe(true)
    expect(Object.isFrozen(annotation.meta)).toBe(true)
    expect(annotation.refs).toEqual(['UC055', 'UC057'])
    expect(Object.isFrozen(tool)).toBe(true)
  })

  it('attaches without changing enumerable shape', () => {
    const target = { name: 'target' }
    const same = annotate(target, tool('TL001'), useCase('UC058'))

    expect(same).toBe(target)
    expect(Object.keys(target)).toEqual(['name'])
    expect(isAnnotated(target)).toBe(true)
    expect(annotationsOf(target).map((a) => a.id)).toEqual(['TL001', 'UC058'])
    expect(annotationOf(target, 'tool')?.id).toBe('TL001')
    expect(annotationOf(target, 'waypoint')).toBeUndefined()
  })

  it('keeps one annotation per kind and is idempotent', () => {
    const target = {}
    annotate(target, tool('TL001'))
    annotate(target, tool('TL001'))

    expect(annotationsOf(target)).toHaveLength(1)
    expect(() => annotate(target, tool('TL002'))).toThrow(/already annotated with TL001/)
  })

  it('rejects foreign objects as annotations', () => {
    expect(() => annotate({}, { kind: 'tool', id: 'TL001' } as never)).toThrow(/must be frozen/)
    expect(() => annotate({}, { kind: 'other', id: 'X001' } as never)).toThrow(
      /Unknown annotation kind 'other'/,
    )
  })

  it('records annotations in the process registry', () => {
    const toolTarget = annotate({ name: 'my-tool' }, tool('TL001'))
    const waypointTarget = annotate({ name: 'jsonl' }, waypoint('WT001'))
    annotate({ name: 'second-tool' }, useCase('UC055'))

    expect(listAnnotations()).toHaveLength(3)
    expect(listAnnotations('tool')).toHaveLength(1)
    expect(findAnnotation('TL001')[0]?.target).toBe(toolTarget)
    expect(findAnnotation('WT001')[0]?.target).toBe(waypointTarget)
    expect(findAnnotation('UC055')).toHaveLength(1)
  })

  it('supports the decorator adapter without context.metadata', () => {
    class ResumeFlow {}
    class RunFlow {
      resume() {}
    }

    const decorated = decorate(useCase('UC006', { name: 'Resume a run' }))(ResumeFlow)
    decorate(useCase('UC005'))(RunFlow.prototype.resume)

    expect(decorated).toBe(ResumeFlow)
    expect(annotationOf(ResumeFlow, 'useCase')?.id).toBe('UC006')
    expect(annotationOf(RunFlow.prototype.resume, 'useCase')?.id).toBe('UC005')
  })

  it('defineTool attaches annotations from its config', () => {
    const created = defineTool<string, string>({
      name: 'annotated-tool',
      version: '1.0.0',
      mdDescription: 'test',
      annotations: [tool('TL900', { refs: ['UC001'] }), useCase('UC001')],
      async invoke(ex) {
        return ex
      },
    })

    expect(annotationsOf(created).map((a) => a.id)).toEqual(['TL900', 'UC001'])
    expect(created.name).toBe('annotated-tool')
  })
})
