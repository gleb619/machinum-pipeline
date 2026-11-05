import { registry } from '@mt/core'
import type {
  Chunk,
  Exchange,
  Line,
  Paragraph,
  Splitter,
  SplitterContext,
  Token,
  ToolContext,
  Word,
} from '@mt/core'
import { heuristicTokenCount, splitLineUnits, splitParagraphUnits } from '@mt/core'
import { readChapterDoc } from '../modification/chapter-doc.js'
import { tokenizeWords } from './stat-freq.js'
import { resolveChunkSize, splitIntoChunks, tokenizeChunkDetailed } from './token-splitter.js'

interface ParagraphSource {
  chapterId: string
  chunkId: string
  body: string
}

interface LineSource {
  paragraphId: string
  body: string
}

interface WordSource {
  paragraphId: string
  lineId: string
  text: string
}

function metaString(
  env: Exchange<unknown>,
  key: 'chapterId' | 'chunkId' | 'paragraphId' | 'lineId',
): string | undefined {
  const value = env.meta[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function paragraphSource(env: Exchange<unknown>): ParagraphSource {
  if (typeof env.item === 'string') {
    return {
      chapterId: metaString(env, 'chapterId') ?? env.id,
      chunkId: metaString(env, 'chunkId') ?? env.id,
      body: env.item,
    }
  }

  const item = asRecord(env.item)
  if (
    item !== undefined &&
    typeof item.chapterId === 'string' &&
    typeof item.id === 'string' &&
    typeof item.body === 'string'
  ) {
    return { chapterId: item.chapterId, chunkId: item.id, body: item.body }
  }

  throw new Error(
    'paragraphSplitter: item must be a string or a Chunk-like object with id, chapterId and body',
  )
}

function lineSource(env: Exchange<unknown>): LineSource {
  if (typeof env.item === 'string') {
    return {
      paragraphId: metaString(env, 'paragraphId') ?? env.id,
      body: env.item,
    }
  }

  const item = asRecord(env.item)
  if (item !== undefined && typeof item.id === 'string' && typeof item.body === 'string') {
    return { paragraphId: item.id, body: item.body }
  }

  throw new Error('lineSplitter: item must be a string or a Paragraph-like object with id and body')
}

function wordSource(env: Exchange<unknown>): WordSource {
  if (typeof env.item === 'string') {
    const lineId = metaString(env, 'lineId') ?? env.id
    return {
      paragraphId: metaString(env, 'paragraphId') ?? lineId,
      lineId,
      text: env.item,
    }
  }

  const item = asRecord(env.item)
  if (item !== undefined && typeof item.id === 'string' && typeof item.text === 'string') {
    return {
      paragraphId: typeof item.paragraphId === 'string' ? item.paragraphId : item.id,
      lineId: item.id,
      text: item.text,
    }
  }

  throw new Error('wordSplitter: item must be a string or a Line-like object with id, text')
}

/**
 * Chapter markdown → token-bounded Chunks splitter. Parses the markdown item with
 * `readChapterDoc`, joins its body paragraphs, resolves the token budget through
 * `resolveChunkSize` (honoring `meta.chunkSize`, `MT_CHUNK_SIZE`, settings and the
 * tunable chain), then splits with `splitIntoChunks`.
 */
export const chunkSplitter = {
  name: 'chunk-splitter',
  split(env: Exchange<unknown>, ctx?: SplitterContext): Chunk[] {
    if (typeof env.item !== 'string') {
      throw new Error('chunkSplitter: item must be a chapter markdown string')
    }
    const doc = readChapterDoc(env.item)
    const chapterId = metaString(env, 'chapterId') ?? `chapter-${doc.number ?? 0}`
    const text = doc.chapter.body
    const targetTokens = resolveChunkSize(env, ctx as ToolContext | undefined)
    return splitIntoChunks(text, { targetTokens }).map((body, index) => ({
      id: `${chapterId}/chunk-${index + 1}`,
      chapterId,
      index,
      body,
      tokens: heuristicTokenCount(body),
    }))
  },
} satisfies Splitter<Chunk>

/**
 * Chunk → Paragraph splitter. Accepts a chunk body string (ids from `meta.chunkId` /
 * `meta.chapterId`, falling back to the exchange id) or a `Chunk`-like object.
 */
export const paragraphSplitter: Splitter<Paragraph> = {
  name: 'paragraph-splitter',
  split(env) {
    const { chapterId, chunkId, body } = paragraphSource(env)
    return splitParagraphUnits(body).map((part, index) => ({
      id: `${chunkId}/paragraph-${index + 1}`,
      chapterId,
      chunkId,
      index,
      body: part,
    }))
  },
}

/**
 * Paragraph → Line splitter. Accepts a paragraph body string (id from `meta.paragraphId`,
 * falling back to the exchange id) or a `Paragraph`-like object.
 */
export const lineSplitter: Splitter<Line> = {
  name: 'line-splitter',
  split(env) {
    const { paragraphId, body } = lineSource(env)
    return splitLineUnits(body).map((text, index) => ({
      id: `${paragraphId}/line-${index + 1}`,
      paragraphId,
      index,
      text,
    }))
  },
}

/**
 * Line → Words splitter. Accepts a line text string (ids from `meta.lineId` /
 * `meta.paragraphId`, falling back to the exchange id) or a `Line`-like object.
 */
export const wordSplitter: Splitter<Word> = {
  name: 'word-splitter',
  split(env) {
    const { paragraphId, lineId, text } = wordSource(env)
    return tokenizeWords(text).map((word, index) => ({
      id: `${lineId}/word-${index + 1}`,
      paragraphId,
      lineId,
      word,
      index,
    }))
  },
}

/**
 * Chunk → Token splitter (the alternate descent, sibling of paragraphs). Accepts a
 * chunk body string or a `Chunk`-like object with `id` and `body`; ids are
 * `${chunkId}/token-N`.
 */
export const chunkTokenSplitter: Splitter<Token> = {
  name: 'token-splitter',
  async split(env) {
    const item = asRecord(env.item)
    const body =
      typeof env.item === 'string'
        ? env.item
        : item !== undefined && typeof item.body === 'string'
          ? item.body
          : undefined
    if (body === undefined) {
      throw new Error('tokenSplitter: item must be a string or a Chunk-like object with body')
    }
    const chunkId =
      item !== undefined && typeof item.id === 'string'
        ? item.id
        : (metaString(env, 'chunkId') ?? env.id)
    const { tokens } = await tokenizeChunkDetailed(body)
    return tokens.map((token, index) => ({
      id: `${chunkId}/token-${index + 1}`,
      chunkId,
      tokenId: token.tokenId,
      text: token.text,
      index,
    }))
  },
}

registry.registerSplitter('chunks', chunkSplitter)
registry.registerSplitter('paragraphs', paragraphSplitter)
registry.registerSplitter('lines', lineSplitter)
registry.registerSplitter('words', wordSplitter)
registry.registerSplitter('tokens', chunkTokenSplitter)
