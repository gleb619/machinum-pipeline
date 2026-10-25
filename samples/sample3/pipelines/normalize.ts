import { definePipeline, defineTool } from '@mt/core'
import {
  type FinderOutput,
  type LlmRequest,
  type MarkdownFormatterOutput,
  markdownFormatter,
  mdOutputEmitter,
  textNormalizer,
  typoFinder,
} from '@mt/tools'
import '@mt/waypoint'
import { pickLlmTool } from './llm-picker.js'

// === LLM backend (single config point, same pattern as sample2) ===
// `MT_LLM_TOOL` / `MT_LLM_MODEL` (or mt.json `settings.llm.*`) pick the backend; default is
// the offline `mock`, whose scripted answer echoes the text back unchanged.
// The LLM typo-fix step is OFF unless `MT_LLM_TYPO_FIX=1`: heuristics alone run offline.
const llm = pickLlmTool({
  mockSource: (req: LlmRequest) => req.messages.at(-1)?.content ?? '',
})

/** Raw input line: `key` is the source URL, `value` is `Chapter N: Title\n<body lines>`. */
export interface RawChapter {
  key: string
  value: string
}

/** Chapter record the normalization works on. */
export interface ChapterRecord {
  title: string
  body: string
  chapterNum: number
}

/** `{ key, value }` -> `{ title, body, chapterNum }` (first line is the title). */
export function toChapterRecord(raw: RawChapter): ChapterRecord {
  const [first = '', ...rest] = raw.value.split('\n')
  const title = first.trim()
  const num = title.match(/^Chapter\s+(\d+)/i)?.[1] ?? raw.key.match(/chapter-(\d+)/i)?.[1]
  if (!num) throw new Error(`cannot detect chapter number in '${title}' (${raw.key})`)
  return { title, body: rest.join('\n'), chapterNum: Number(num) }
}

const mapRecord = defineTool<RawChapter, string>({
  name: 'map-chapter-record',
  version: '1.0.0',
  mdDescription: 'Maps a raw {key,value} line to a chapter record; item becomes "title\\nbody".',
  async invoke(env) {
    const rec = toChapterRecord(env.item)
    return {
      item: `${rec.title}\n${rec.body}`,
      meta: { ...env.meta, chapterNum: rec.chapterNum },
    }
  },
})

const LLM_FIX_PROMPT =
  'Fix only obvious typos and punctuation mistakes. Keep the meaning, wording, [bracketed] ' +
  'system messages and the number of lines unchanged. Reply with the corrected text only.'

/** Optional LLM typo fix. A reply with a different line count is rejected (original kept). */
const llmTypoFix = defineTool<string, string>({
  name: 'llm-typo-fix',
  version: '1.0.0',
  mdDescription: 'Fixes typos through the picked LLM backend; keeps the line count.',
  async invoke(env, ctx) {
    const res = await llm.schemaCall(
      { systemPrompt: LLM_FIX_PROMPT, messages: [{ role: 'user', content: env.item }] },
      ctx,
    )
    const fixed = res.content.trim()
    const same = fixed.split('\n').length === env.item.split('\n').length
    return { item: same ? fixed : env.item, meta: { ...env.meta, llmFixed: same } }
  },
})

/** Text -> markdown: first line is the H1, every other line is its own paragraph. */
const textToMarkdown = defineTool<string, { text: string }>({
  name: 'text-to-markdown',
  version: '1.0.0',
  mdDescription: 'First line becomes "# title"; remaining lines become one paragraph each.',
  async invoke(env) {
    const [title = '', ...rest] = env.item.split('\n')
    const paragraphs = rest.filter((l) => l !== '')
    const text = `# ${title}\n\n${paragraphs.join('\n\n')}\n`
    return { item: { text }, meta: env.meta }
  },
})

const unwrapText = defineTool<MarkdownFormatterOutput | FinderOutput, string>({
  name: 'unwrap-text',
  version: '1.0.0',
  mdDescription:
    "Unwraps { text } to a markdown string; undoes remark's \\[ escaping so [system messages] stay literal.",
  async invoke(env) {
    return { item: env.item.text.replace(/\\([[\]])/g, '$1'), meta: env.meta }
  },
})

const normalizeFlow = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(mapRecord)
  .use(textNormalizer)
  .use(
    process.env.MT_LLM_TYPO_FIX === '1'
      ? llmTypoFix
      : defineTool<string, string>({
          name: 'llm-typo-fix-off',
          version: '1.0.0',
          mdDescription: 'Pass-through (set MT_LLM_TYPO_FIX=1 to enable the LLM typo fix).',
          async invoke(env) {
            return env
          },
        }),
  )
  .use(textToMarkdown)
  .use(typoFinder)
  .tap(async (env: unknown) => {
    const meta = (env as { meta?: { chapterNum?: number; warnings?: unknown[] } }).meta
    console.log(
      `[normalize] chapter ${meta?.chapterNum}: ${meta?.warnings?.length ?? 0} typo hints`,
    )
  })
  .use(markdownFormatter)
  .use(unwrapText)
  .use(
    mdOutputEmitter({
      name: 'normalized',
      filename: (meta) => `chapter${meta.chapterNum}.md`,
    }),
  )
  .to('@en')

export { normalizeFlow }
export default normalizeFlow
