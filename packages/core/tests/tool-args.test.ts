import { describe, expect, it } from 'vitest'
import { defineTool } from '../src/dsl.js'
import { itemArg, metaArg, variableArg } from '../src/tool-args.js'

describe('tool-args', () => {
  describe('itemArg', () => {
    it('defaults to the item target, name "item" and required true', () => {
      const arg = itemArg({ description: 'input text' })

      expect(arg).toMatchObject({
        name: 'item',
        target: 'item',
        required: true,
        description: 'input text',
      })
      expect(arg.type).toBeUndefined()
      expect(arg.default).toBeUndefined()
      expect(arg.direction).toBeUndefined()
    })

    it('applies explicit name, type, required and default', () => {
      const arg = itemArg({
        name: 'text',
        type: 'markdown',
        required: false,
        description: 'chapter markdown',
        default: '# Untitled',
      })

      expect(arg).toEqual({
        name: 'text',
        target: 'item',
        type: 'markdown',
        required: false,
        description: 'chapter markdown',
        default: '# Untitled',
      })
    })

    it.each([
      ['empty description', { description: '' }, /description must be a non-empty string/],
      ['blank description', { description: '   ' }, /description must be a non-empty string/],
      ['name starting with a digit', { name: '1bad', description: 'x' }, /invalid tool arg name/],
      ['name with spaces', { name: 'bad name', description: 'x' }, /invalid tool arg name/],
    ])('rejects an %s', (_label, config, message) => {
      expect(() => itemArg(config)).toThrow(message)
    })
  })

  describe('metaArg', () => {
    it('applies the meta target with required false by default', () => {
      const arg = metaArg({ name: 'lang', description: 'language code' })

      expect(arg).toMatchObject({
        name: 'lang',
        target: 'meta',
        required: false,
        description: 'language code',
      })
      expect(arg.direction).toBeUndefined()
    })

    it('rejects a name carrying the implied meta. prefix', () => {
      expect(() => metaArg({ name: 'meta.lang', description: 'language code' })).toThrow(
        /omit the 'meta\.' prefix/,
      )
    })
  })

  describe('variableArg', () => {
    it('defaults to required false and direction in', () => {
      const arg = variableArg({ name: 'wordCount', description: 'word count' })

      expect(arg).toMatchObject({
        name: 'wordCount',
        target: 'variable',
        required: false,
        direction: 'in',
        description: 'word count',
      })
    })

    it('keeps an explicit out direction', () => {
      const arg = variableArg({
        name: 'wordCount',
        type: 'number',
        required: true,
        direction: 'out',
        description: 'word count',
      })

      expect(arg).toMatchObject({ direction: 'out', required: true, type: 'number' })
    })

    it('rejects an invalid direction at runtime', () => {
      expect(() =>
        variableArg({
          name: 'wordCount',
          description: 'word count',
          direction: 'sideways' as unknown as 'in',
        }),
      ).toThrow(/expected 'in' or 'out'/)
    })
  })

  it('still accepts raw ToolArg objects in defineTool', () => {
    const tool = defineTool({
      name: 'raw-args-tool',
      version: '1.0.0',
      description: 'Tool with hand-written argument declarations.',
      args: [
        { name: 'item', target: 'item', required: true, description: 'input text' },
        { name: 'lang', target: 'meta', description: 'language code', default: 'en' },
      ],
      invoke: async (ex) => ex,
    })

    expect(tool.args).toEqual([
      { name: 'item', target: 'item', required: true, description: 'input text' },
      { name: 'lang', target: 'meta', description: 'language code', default: 'en' },
    ])
  })
})
