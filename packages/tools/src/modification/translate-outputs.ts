import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@mt/core'
import { appendMdOutput } from '../core/md-outputs.js'
import type { LineParityInput } from '../verification/line-parity-linter.js'

export interface TranslateOutputsOptions {
  /** Directory holding the existing `titles.json` (merged, never overwritten wholesale). */
  chaptersDir: string
  /** Subfolder of the RU chapters. Default: `ru`. */
  ruDir?: string
  /** Titles file name (target root). Default: `titles.json`. */
  titlesFile?: string
  /** Log a one-line message. Default: true. */
  log?: boolean
}

/** Existing titles file (`{ "<n>": { en, ru } }`); empty when absent or malformed. */
function readTitles(path: string): Record<string, { en: string; ru: string }> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { en: string; ru: string }>
  } catch {
    return {}
  }
}

/**
 * Write intents for translated `{ en, ru }` pairs: `<ruDir>/chapter<N>.md` per chapter and the
 * merged `<titlesFile>`. Needs `meta.chapterNums` and `meta.titlesRu` (from
 * `createChapterBodyTranslator`). Item becomes `''`.
 */
export function createTranslateOutputs(options: TranslateOutputsOptions) {
  const ruDir = options.ruDir ?? 'ru'
  const titlesFile = options.titlesFile ?? 'titles.json'
  return defineTool<LineParityInput, string>({
    name: 'translate-outputs',
    version: '1.0.0',
    mdDescription: `Emits ${ruDir}/chapter<N>.md and ${titlesFile}.`,
    async invoke(env) {
      const pairs = env.items ?? [env.item]
      const nums = env.meta.chapterNums as number[]
      const titlesRu = env.meta.titlesRu as string[]
      const titles = readTitles(join(options.chaptersDir, titlesFile))
      let meta: Record<string, unknown> = { ...env.meta }
      pairs.forEach((pair, i) => {
        const n = nums[i]
        meta = appendMdOutput(meta, {
          name: ruDir,
          subdir: ruDir,
          filename: `chapter${n}.md`,
          content: pair.ru,
        })
        titles[String(n)] = {
          en: /^#\s+(.+)$/m.exec(pair.en)?.[1]?.trim() ?? '',
          ru: titlesRu[i] ?? '',
        }
      })
      meta = appendMdOutput(meta, {
        name: 'titles',
        subdir: '',
        filename: titlesFile,
        content: `${JSON.stringify(titles, null, 2)}\n`,
      })
      if (options.log !== false) {
        console.log(`[translate] wrote ${pairs.length} chapter(s) [${nums.join(', ')}]`)
      }
      return { item: '', meta }
    },
  })
}
