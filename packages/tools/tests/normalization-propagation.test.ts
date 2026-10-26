import { createExchange, getVariable, setVariable } from '@mt/core'
import type { Exchange, Tool, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { chapterIndexer } from '../src/normalization/chapter-indexer.js'
import { heuristicSummaryTool } from '../src/normalization/heuristic-summary.js'
import {
  markdownOutlineTool,
  markdownStatsTool,
  markdownStripFrontmatter,
} from '../src/normalization/markdown-tool.js'
import { namedEntityTool } from '../src/normalization/named-entity-recognizer.js'
import { statFreq } from '../src/normalization/stat-freq.js'
import { termTagger } from '../src/normalization/term-tagger.js'
import { textNormalizer } from '../src/normalization/text-normalizer.js'
import { tokenCounter, tokenCounterBatch } from '../src/normalization/token-counter.js'
import { tokenSplitter } from '../src/normalization/token-splitter.js'
import { wordCounter } from '../src/normalization/word-counter.js'

const ctx = { run: { global: {} } } as unknown as ToolContext
const TEXT = '# Chapter 1\n\nSir Aldric rode to Thornhaven with the grey mare today.\n'

const tools: Array<[string, Tool<never, unknown>]> = [
  ['wordCounter', wordCounter as never],
  ['tokenCounter', tokenCounter as never],
  ['tokenCounterBatch', tokenCounterBatch as never],
  ['textNormalizer', textNormalizer as never],
  ['chapterIndexer', chapterIndexer as never],
  ['heuristicSummaryTool', heuristicSummaryTool as never],
  ['markdownStatsTool', markdownStatsTool as never],
  ['markdownOutlineTool', markdownOutlineTool as never],
  ['markdownStripFrontmatter', markdownStripFrontmatter as never],
  ['namedEntityTool', namedEntityTool as never],
  ['statFreq', statFreq as never],
  ['termTagger', termTagger as never],
  ['tokenSplitter', tokenSplitter as never],
]

describe('normalization tools keep the exchange family', () => {
  it.each(tools)('%s propagates id, meta and pre-existing variables', async (_name, tool) => {
    const input: Exchange<string> = setVariable(
      createExchange(TEXT, { id: 'fam-1', meta: { chapterId: 'c1' } }),
      'carried',
      'yes',
    )
    const out = await (tool as unknown as Tool<string, unknown>).invoke(input, ctx)
    expect(out.id).toBe('fam-1')
    expect(out.meta.chapterId).toBe('c1')
    expect(getVariable(out, 'carried')).toBe('yes')
  })
})
