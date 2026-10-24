import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PromptNotFoundError,
  PromptVariableError,
  promptEnvName,
  registerPrompt,
  renderTemplate,
  resolvePrompt,
  resolvePromptTemplate,
} from '../src/core/llm-prompts.js'

const vars = { text: 'hello', targetLang: 'ru', sourceLang: 'en' }

describe('renderTemplate', () => {
  it('interpolates {{var}} with whitespace tolerance and objects', () => {
    expect(renderTemplate('a {{x}} b {{ y }}', { x: 1, y: { k: 2 } })).toBe('a 1 b {"k":2}')
  })
  it('missing var -> clear error naming prompt and vars', () => {
    expect(() => renderTemplate('{{a}} {{b}}', { a: 1 }, 'demo')).toThrow(PromptVariableError)
    expect(() => renderTemplate('{{a}} {{b}}', { a: 1 }, 'demo')).toThrow(/'demo'.*b/)
  })
})

describe('resolvePrompt override chain', () => {
  registerPrompt({ name: 'test.p', template: 'default {{text}}' })

  it('default', () => {
    expect(resolvePrompt('test.p', vars, {}, {})).toBe('default hello')
  })
  it('env MT_PROMPT_<NAME>', () => {
    expect(promptEnvName('translate.system')).toBe('MT_PROMPT_TRANSLATE_SYSTEM')
    expect(resolvePrompt('test.p', vars, {}, { MT_PROMPT_TEST_P: 'env {{text}}' })).toBe(
      'env hello',
    )
  })
  it('settings > env', () => {
    const out = resolvePrompt(
      'test.p',
      vars,
      { settings: { 'prompts.test.p': 'settings {{text}}' } },
      { MT_PROMPT_TEST_P: 'env' },
    )
    expect(out).toBe('settings hello')
  })
  it('meta.prompts > settings', () => {
    const out = resolvePrompt(
      'test.p',
      vars,
      { meta: { prompts: { 'test.p': 'meta {{text}}' } }, settings: { 'prompts.test.p': 's' } },
      {},
    )
    expect(out).toBe('meta hello')
  })
  it('tool option > meta', () => {
    const r = resolvePromptTemplate(
      'test.p',
      { tool: { 'test.p': 'tool' }, meta: { prompts: { 'test.p': 'meta' } } },
      {},
    )
    expect(r).toEqual({ template: 'tool', source: 'tool' })
  })
  it('@file loads from baseDir (env) and from absolute path (tool)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-'))
    writeFileSync(join(dir, 'p.md'), 'file {{text}}')
    expect(resolvePrompt('test.p', vars, { baseDir: dir }, { MT_PROMPT_TEST_P: '@p.md' })).toBe(
      'file hello',
    )
    expect(resolvePrompt('test.p', vars, { tool: { 'test.p': `@${join(dir, 'p.md')}` } }, {})).toBe(
      'file hello',
    )
  })
  it('missing file -> clear error', () => {
    expect(() =>
      resolvePrompt('test.p', vars, { tool: { 'test.p': '@/no/such/file.md' } }, {}),
    ).toThrow(/could not read file/)
  })
  it('unknown prompt', () => {
    expect(() => resolvePrompt('nope.nope', {}, {}, {})).toThrow(PromptNotFoundError)
  })
  it('built-in translate defaults render', () => {
    expect(resolvePrompt('translate.system', vars, {}, {})).toContain('from en to ru')
  })
})
