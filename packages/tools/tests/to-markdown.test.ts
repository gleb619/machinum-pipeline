import { createExchange, getVariable, variable } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { recordToMarkdown, toMarkdown } from '../src/modification/to-markdown.js'

describe('recordToMarkdown', () => {
  it('renders title as h1 and body as paragraph', () => {
    const md = recordToMarkdown({ title: 'Hello', body: 'World' })
    expect(md).toContain('# Hello')
    expect(md).toContain('World')
  })

  it('splits body on blank lines into paragraphs', () => {
    const md = recordToMarkdown({ body: 'First paragraph.\n\nSecond paragraph.' })
    expect(md).toContain('First paragraph.')
    expect(md).toContain('Second paragraph.')
  })

  it('skips empty title', () => {
    const md = recordToMarkdown({ title: '', body: 'Body' })
    expect(md).not.toContain('#')
    expect(md).toContain('Body')
  })
})

describe('toMarkdown tool', () => {
  it('produces markdown and sets the toMarkdown variable', async () => {
    const env = await toMarkdown.invoke(
      createExchange(
        { title: 'T', body: 'B' },
        { id: 'e1', meta: { existing: true }, variables: [variable('keep', 1)] },
      ),
      // ToolContext is unused by the tool; cast minimal shape.
      {} as import('@mt/core').ToolContext,
    )
    expect(env.item).toContain('# T')
    expect(env.item).toContain('B')
    expect(env.meta).toEqual({ existing: true })
    expect(getVariable(env, 'toMarkdown')).toBe(true)
    expect(env.id).toBe('e1')
    expect(getVariable(env, 'keep')).toBe(1)
  })
})
