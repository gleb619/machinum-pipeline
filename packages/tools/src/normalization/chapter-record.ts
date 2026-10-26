import { defineTool, withItem, withMeta } from '@mt/core'
import type { FinderOutput, MarkdownFormatterOutput } from '../verification/chapter-validator.js'

/** Raw JSONL line: `key` is the source URL, `value` is `Chapter N: Title\n<body lines>`. */
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

/**
 * `{ key, value }` -> `{ title, body, chapterNum }` (first line is the title). The number comes
 * from `Chapter N` in the title, else from `chapter-N` in the key; throws when neither has one.
 */
export function toChapterRecord(raw: RawChapter): ChapterRecord {
  const [first = '', ...rest] = raw.value.split('\n')
  const title = first.trim()
  const num = title.match(/^Chapter\s+(\d+)/i)?.[1] ?? raw.key.match(/chapter-(\d+)/i)?.[1]
  if (!num) throw new Error(`cannot detect chapter number in '${title}' (${raw.key})`)
  return { title, body: rest.join('\n'), chapterNum: Number(num) }
}

/** Maps a raw `{key,value}` line to `"title\nbody"` text and stores `meta.chapterNum`. */
export const chapterRecordMapper = defineTool<RawChapter, string>({
  name: 'chapter-record-mapper',
  version: '1.0.0',
  mdDescription: 'Maps a raw {key,value} line to a chapter record; item becomes "title\\nbody".',
  async invoke(env) {
    const rec = toChapterRecord(env.item)
    return withMeta(withItem(env, `${rec.title}\n${rec.body}`), { chapterNum: rec.chapterNum })
  },
})

/** First line becomes `# title`; every other non-empty line becomes one paragraph. Returns `{ text }`. */
export const lineTextToMarkdown = defineTool<string, { text: string }>({
  name: 'line-text-to-markdown',
  version: '1.0.0',
  mdDescription: 'First line becomes "# title"; remaining lines become one paragraph each.',
  async invoke(env) {
    const [title = '', ...rest] = env.item.split('\n')
    const paragraphs = rest.filter((l) => l !== '')
    return withItem(env, { text: `# ${title}\n\n${paragraphs.join('\n\n')}\n` })
  },
})

/** Unwraps `{ text }` to a markdown string; undoes remark's `\[` escaping so `[system messages]` stay literal. */
export const unwrapMarkdownText = defineTool<MarkdownFormatterOutput | FinderOutput, string>({
  name: 'unwrap-markdown-text',
  version: '1.0.0',
  mdDescription:
    "Unwraps { text } to a markdown string; undoes remark's \\[ escaping so [system messages] stay literal.",
  async invoke(env) {
    return withItem(env, env.item.text.replace(/\\([[\]])/g, '$1'))
  },
})
