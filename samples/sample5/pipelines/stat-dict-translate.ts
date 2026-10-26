import { definePipeline, defineTool, getVariable, withItem } from '@mt/core'
import {
  type Glossary,
  createStatDict,
  createStatTranslateDict,
  mockLlmCall,
  statFreq,
} from '@mt/tools'
import '@mt/waypoint'
import { gateLayer, pickFor } from '../lib/llm.js'
import { keepInput, report } from '../lib/report.js'

// === stat-dict-translate: LLM translation of the ranked dictionary (createStatTranslateDict) ===
// statFreq -> statDict (offline, as in `statdata`) -> the model fills `ru` for every candidate in
// batches; the reply must return exactly the batched ids (a mismatch is retried).
// Judge: every term has a sensible RU form, names transliterated, genders / declension hints OK.
const llm = pickFor('stat-dict-translate')
const layer = gateLayer(llm)

// Mock: answer with the ids the gate asked for (parsed from the prompt) so the offline run passes.
const mock = mockLlmCall((req) => {
  // the system prompt carries an example id; only the user message lists the batched entries
  const text = req.messages.at(-1)?.content ?? ''
  const ids = [...text.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
  return JSON.stringify({ translations: ids.map((id) => ({ id, ru: `ру-${id}` })) })
})
const gate = createStatTranslateDict({ ...(layer ? { llm: layer } : {}), batchSize: 10 })

/** The dictionary built by `statDict` becomes the item the translate gate works on. */
const dictAsItem = defineTool<string, Glossary>({
  name: 'dict-as-item',
  version: '1.0.0',
  mdDescription: 'Moves meta.statDict into the item.',
  async invoke(env) {
    // withItem drops `items`: the gate must see one glossary, not a batch
    return withItem(env, getVariable(env, 'statDict') as Glossary)
  },
})

export default definePipeline({ id: 'stat-dict-translate' })
  .from('md://./input/en')
  .batch(100)
  .use(keepInput)
  .use(statFreq)
  .use(createStatDict({ minCount: 3, topK: 10 }))
  .use(dictAsItem)
  .use(layer ? gate : gate.with({ call: mock }))
  .use(
    report({
      tool: 'stat-dict-translate',
      llm,
      filename: 'stat-dict-translate.md',
      render: (env) => {
        const glossary = env.item as Glossary
        return {
          output: glossary.terms
            .map((t) => `${t.term}\t${t.type}\t${t.ru ?? '(empty)'}`)
            .join('\n'),
        }
      },
    }),
  )
  .to('md://./out/stat-dict-translate')
