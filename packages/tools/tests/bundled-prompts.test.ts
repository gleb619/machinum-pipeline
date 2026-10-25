import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { listBundledPrompts, loadBundledPrompt } from '../src/core/bundled-prompts.js'
import { resolvePromptTemplate } from '../src/core/llm-prompts.js'
import { BUNDLED_PROMPTS } from '../src/generated/prompts.js'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const promptsDir = join(pkgRoot, 'prompts')
const generatedFile = join(pkgRoot, 'src', 'generated', 'prompts.ts')

/** md file name without the suffix -> the text the generator embeds (trailing whitespace trimmed). */
function promptFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(promptsDir)) {
    if (!name.endsWith('.md')) continue
    out[name.slice(0, -3)] = readFileSync(join(promptsDir, name), 'utf8').replace(/\s+$/, '')
  }
  return out
}

describe('generated prompt module', () => {
  it('is in sync with the prompts/*.md sources', () => {
    expect(Object.keys(BUNDLED_PROMPTS).sort()).toEqual(Object.keys(promptFiles()).sort())
    for (const [key, text] of Object.entries(promptFiles())) {
      expect(BUNDLED_PROMPTS[key as keyof typeof BUNDLED_PROMPTS]).toBe(text)
    }
  })

  it('regenerates byte-identical output from the md sources', () => {
    const work = mkdtempSync(join(tmpdir(), 'mt-gen-prompts-'))
    mkdirSync(join(work, 'scripts'), { recursive: true })
    mkdirSync(join(work, 'prompts'), { recursive: true })
    copyFileSync(
      join(pkgRoot, 'scripts', 'gen-prompts.mjs'),
      join(work, 'scripts', 'gen-prompts.mjs'),
    )
    for (const name of readdirSync(promptsDir)) {
      if (name.endsWith('.md')) copyFileSync(join(promptsDir, name), join(work, 'prompts', name))
    }

    execFileSync(process.execPath, [join(work, 'scripts', 'gen-prompts.mjs')], { cwd: work })

    expect(readFileSync(join(work, 'src', 'generated', 'prompts.ts'), 'utf8')).toBe(
      readFileSync(generatedFile, 'utf8'),
    )
  })

  it('carries the prompt text without any fs read of the md files', () => {
    for (const file of ['src/generated/prompts.ts', 'src/core/bundled-prompts.ts']) {
      expect(readFileSync(join(pkgRoot, file), 'utf8')).not.toMatch(/node:fs|readFileSync/)
    }
  })

  it('loads the prompts with the prompts/ directory absent', async () => {
    // Stand-alone copy of the two compiled modules: no prompts/ dir exists next to them.
    const work = mkdtempSync(join(tmpdir(), 'mt-prompt-bundle-'))
    writeFileSync(join(work, 'package.json'), '{ "type": "module" }\n')
    mkdirSync(join(work, 'core'), { recursive: true })
    mkdirSync(join(work, 'generated'), { recursive: true })
    const emit = (source: string, out: string): void => {
      const js = ts.transpileModule(readFileSync(join(pkgRoot, source), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText
      writeFileSync(join(work, out), js)
    }
    emit('src/generated/prompts.ts', 'generated/prompts.js')
    emit('src/core/bundled-prompts.ts', 'core/bundled-prompts.js')

    expect(existsSync(join(work, 'prompts'))).toBe(false)

    const mod = (await import(pathToFileURL(join(work, 'core', 'bundled-prompts.js')).href)) as {
      loadBundledPrompt: (name: string) => string
    }
    expect(mod.loadBundledPrompt('summary.user')).toContain('{{count}}')
    expect(mod.loadBundledPrompt('summary.system')).toContain('Web Novel Summary Notes Generator')
  })
})

describe('loadBundledPrompt', () => {
  it('returns the bundled templates and lists the names', () => {
    expect(listBundledPrompts()).toEqual(Object.keys(BUNDLED_PROMPTS))
    expect(loadBundledPrompt('summary.system')).toContain('Web Novel Summary Notes Generator')
    expect(loadBundledPrompt('summary.user')).toContain('{{text}}')
  })

  it('throws with the known names for an unknown prompt', () => {
    expect(() => loadBundledPrompt('nope')).toThrow(/Unknown bundled prompt 'nope'/)
    expect(() => loadBundledPrompt('nope')).toThrow(/summary\.system/)
  })
})

describe('prompt registry integration', () => {
  it('resolves the bundled prompts as defaults', () => {
    expect(resolvePromptTemplate('summary.user').source).toBe('default')
    expect(resolvePromptTemplate('summary.user').template).toBe(loadBundledPrompt('summary.user'))
  })

  it('lets env / meta override a bundled prompt', () => {
    const fromEnv = resolvePromptTemplate(
      'summary.user',
      {},
      { MT_PROMPT_SUMMARY_USER: 'env {{count}}' },
    )
    expect(fromEnv.template).toBe('env {{count}}')
    expect(fromEnv.source).toBe('env')

    const fromMeta = resolvePromptTemplate(
      'summary.user',
      { meta: { prompts: { 'summary.user': 'meta' } } },
      {},
    )
    expect(fromMeta.template).toBe('meta')
  })
})
