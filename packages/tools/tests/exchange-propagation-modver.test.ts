import { createExchange, getVariable, variable } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { mdFormatter } from '../src/modification/md-formatter.js'
import { toMarkdown } from '../src/modification/to-markdown.js'
import { chapterValidator, forbiddenCharDetector } from '../src/verification/chapter-validator.js'
import { createLineParityLinter } from '../src/verification/line-parity-linter.js'
import { statProofread } from '../src/verification/stat-proofread.js'

const ctx = {} as ToolContext

const cases: Array<{
  name: string
  run: (ex: Exchange<never>) => Promise<Exchange<unknown>>
  item: unknown
  produces: string
}> = [
  {
    name: 'md-formatter',
    item: '# T\n\nBody.',
    produces: 'mdFormatted',
    run: (ex) => mdFormatter.invoke(ex as never, ctx),
  },
  {
    name: 'to-markdown',
    item: { title: 'T', body: 'B' },
    produces: 'toMarkdown',
    run: (ex) => toMarkdown.invoke(ex as never, ctx),
  },
  {
    name: 'stat-proofread',
    item: 'Привет',
    produces: 'proofread',
    run: (ex) => statProofread.invoke(ex as never, ctx),
  },
  {
    name: 'line-parity-linter',
    item: { en: 'a', ru: 'б' },
    produces: 'parity',
    run: (ex) => createLineParityLinter({ throwOnError: false }).invoke(ex as never, ctx),
  },
  {
    name: 'forbidden-char-finder',
    item: 'clean',
    produces: 'forbidden',
    run: (ex) => forbiddenCharDetector.invoke(ex as never, ctx),
  },
  {
    name: 'md-linter',
    item: '# T\n\nBody.',
    produces: 'valid',
    run: (ex) => chapterValidator.invoke(ex as never, ctx),
  },
]

describe('modification/verification tools propagate the exchange', () => {
  for (const c of cases) {
    it(`${c.name}: keeps id, meta, variables and publishes '${c.produces}'`, async () => {
      const ex = createExchange(c.item, {
        id: 'ex-keep',
        meta: { chapterId: 'c1' },
        variables: [variable('pre', 'existing')],
      })
      const out = await c.run(ex as never)
      expect(out.id).toBe('ex-keep')
      expect(out.meta.chapterId).toBe('c1')
      expect(getVariable(out, 'pre')).toBe('existing')
      expect(getVariable(out, c.produces)).toBeDefined()
    })
  }
})
