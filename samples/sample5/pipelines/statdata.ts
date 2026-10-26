import { definePipeline, getVariable } from '@mt/core'
import { type Glossary, type StatFreqReport, createStatDict, statFreq } from '@mt/tools'
import '@mt/waypoint'
import { keepInput, report } from '../lib/report.js'

// === statdata: OFFLINE corpus statistics - frequency report + ranked dictionary candidates ===
// No LLM. `statFreq` counts words / n-grams / repeated sentences, `createStatDict` turns the
// frequent ones into glossary-shaped candidates (type guessed, `ru` empty). This is the input of
// `pnpm run stat-dict-translate` (the LLM step) and of the glossary workflow.
// Judge: top terms are real story terms (not stopwords), candidate types make sense.
export default definePipeline({ id: 'statdata' })
  .from('md://./input/en')
  .batch(100)
  .use(keepInput)
  .use(statFreq)
  .use(createStatDict({ minCount: 2, topK: 30 }))
  .use(
    report({
      tool: 'statdata',
      llm: { tool: 'offline', model: 'stat' },
      filename: 'statdata.md',
      render: (env) => {
        const freq = getVariable(env, 'statFreq') as StatFreqReport
        const dict = getVariable(env, 'statDict') as Glossary
        const top = freq.top.slice(0, 15).map((t) => `${t.count}\t${t.kind}\t${t.term}`)
        const cands = dict.terms.map((t) => `${t.type}\t${t.term}\tx${t.count}`)
        return {
          output: [
            `words: ${freq.totalWords} (unique ${freq.uniqueWords})`,
            '',
            'top terms (count, kind, term):',
            ...top,
            '',
            'dictionary candidates (type, term, count):',
            ...cands,
          ].join('\n'),
        }
      },
    }),
  )
  .to('md://./out/statdata')
