import { describe, expect, it } from 'vitest'
import { DSL_DOCS, docsFor } from '../src/dsl-docs'

const BUILDER_OPS = [
  'from',
  'use',
  'useAll',
  'to',
  'flatMap',
  'fork',
  'forkSync',
  'subflow',
  'tap',
  'log',
]

describe('UC045 - VSCode hover DSL docs', () => {
  it('documents every builder op', () => {
    for (const op of BUILDER_OPS) {
      expect(docsFor(op, '.'), `missing docs for .${op}()`).toBeDefined()
    }
  })

  it('documents definePipeline', () => {
    expect(docsFor('definePipeline', '')).toBeDefined()
    expect(docsFor('definePipeline', '(')).toBeDefined()
  })

  it('does not document a builder op used as a plain identifier', () => {
    expect(docsFor('use', '')).toBeUndefined()
    expect(docsFor('from', '')).toBeUndefined()
  })

  it('does not document an unknown word', () => {
    expect(docsFor('item', '.')).toBeUndefined()
    expect(docsFor('tool', '.')).toBeUndefined()
  })

  it('does not document a word that is not a method call', () => {
    expect(docsFor('fork', 'x')).toBeUndefined()
    expect(docsFor('subflow', '/')).toBeUndefined()
  })

  it('has no docs for a .window() op — there is none', () => {
    expect(docsFor('window', '.')).toBeUndefined()
    expect(DSL_DOCS.window).toBeUndefined()
  })

  it('documents .fork() parallel branches', () => {
    const docs = docsFor('fork', '.')
    expect(docs).toContain('CONCURRENTLY')
    expect(docs).toContain('branches')
  })

  it('documents .forkSync() sequential fork', () => {
    const docs = docsFor('forkSync', '.')
    expect(docs).toContain('Sequential')
  })

  it('documents definePipeline with the real config shape', () => {
    const docs = docsFor('definePipeline', '')
    expect(docs).toContain('id?')
    expect(docs).toContain('retry?')
    expect(docs).toContain('onError?')
    expect(docs).not.toContain('description')
  })

  it('documents the .subflow() batch form', () => {
    const docs = docsFor('subflow', '.')
    expect(docs).toContain('batch://?size=5')
    expect(docs).toContain('positive integer')
    expect(docs).toContain('RangeError')
    expect(docs).toContain('batch://return')
  })

  it('has no .batch() op — the batch form lives on .subflow()', () => {
    expect(docsFor('batch', '.')).toBeUndefined()
    expect(DSL_DOCS.batch).toBeUndefined()
  })

  it('documents .subflow() splitter forms', () => {
    const docs = docsFor('subflow', '.')
    expect(docs).toContain('paragraphs://')
  })

  it('documents .log() levels', () => {
    const docs = docsFor('log', '.')
    expect(docs).toContain('truncate')
  })
})
