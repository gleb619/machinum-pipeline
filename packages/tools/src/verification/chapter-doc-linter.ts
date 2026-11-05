import { category, defineTool, setVariable, tool, useCase } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import matter from 'gray-matter'
import { readChapterDoc } from '../modification/chapter-doc.js'
import { LineParityError, lintLineParity } from './line-parity-linter.js'
import type { LineParityInput, LineParityOptions } from './line-parity-linter.js'

export interface ChapterDocLintOptions extends LineParityOptions {
  /** Throw a retryable {@link LineParityError} on hard errors. Default true. */
  throwOnError?: boolean
}

/**
 * Normalize a chapter document to comparable text: frontmatter dropped, `# title`
 * kept, body via the chapter tree. Falls back to raw content (frontmatter
 * stripped) when the text is not a chapter doc.
 */
function chapterText(markdown: string): string {
  try {
    return readChapterDoc(markdown).chapterTree().toMarkdown()
  } catch {
    return matter(markdown).content.trim()
  }
}

/**
 * `lintLineParity` over parsed chapter documents: `{ en, ru }` markdown in, same
 * item out, `meta`-free `parity` variable = {@link LineParityReport}. On a hard
 * error it throws a retryable {@link LineParityError} (engine retry), unless
 * `throwOnError: false`.
 */
export function createChapterDocLinter(options: ChapterDocLintOptions = {}) {
  return defineTool<LineParityInput, LineParityInput>({
    name: 'chapter-doc-linter',
    version: '1.0.0',
    mdDescription:
      'Parses EN/RU chapter documents (YAML frontmatter + # title + body) and runs the line-parity lint on their content: line count, empty/bracket line positions, Cyrillic ratio, leftover <term> tags and think blocks. Report in the parity variable; throws a retryable error on hard errors.',
    annotations: [
      tool('TL253', {
        name: 'chapter-doc-linter',
        description: 'Line-parity lint over parsed EN/RU chapter documents.',
        refs: ['UC057'],
      }),
      useCase('UC057'),
      category(['validator']),
    ],
    async invoke(env: Exchange<LineParityInput>, _ctx: ToolContext) {
      const report = lintLineParity(chapterText(env.item.en), chapterText(env.item.ru), options)
      if (!report.ok && options.throwOnError !== false) throw new LineParityError(report)
      return setVariable(env, 'parity', report)
    },
  })
}

export const chapterDocLinter = createChapterDocLinter()
