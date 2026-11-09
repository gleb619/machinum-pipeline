/**
 * Fill the Russian forms of the glossary terms, so the prompt builder can pin names.
 *
 * `glossary.ts` extracts terms and leaves `ru: null` — the pipeline expects a human to write
 * the target forms. Without them `tagWithGlossary` has nothing to anchor on and the model drifts
 * («Файона Доул» / «Фиона Доули» / «Кормaк Доул» inside one page, measured on chapter 1).
 *
 *   tsx scripts/fill-glossary-ru.ts                  # fill what is empty, keep every human edit
 *   tsx scripts/fill-glossary-ru.ts --dry-run        # print the proposals only
 *   tsx scripts/fill-glossary-ru.ts --model qwen3.8:latest
 *
 * The model's proposals are a first draft, not authority: it renders each term in isolation, so
 * the same person arrives in several spellings and possessives arrive as fragments. When the book
 * has a `chapters/names.json` (the editorial table of proper nouns), run
 * `python3 scripts/apply_names.py --glossary chapters/glossary.json --names chapters/names.json`
 * afterwards — it rewrites every name to the table, drops the extractor's non-names, and adds the
 * names it missed. Measured on book2: the fill alone gave «Кормак До» / «Дойл» / «Файон», and the
 * table fixed all three.
 *
 * Idempotent: a term that already has `ru` is never touched, so a hand-corrected name survives
 * a re-run. Writes atomically (tmp + rename) because a half-written glossary breaks every later
 * pipeline run.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const GLOSSARY = join(ROOT, 'chapters/glossary.json')
const BASE_URL = (process.env.MT_OLLAMA_URL ?? 'http://localhost:11434/v1').replace(/\/+$/, '')
const MODEL = process.env.MT_GLOSSARY_MODEL ?? process.env.MT_LLM_MODEL ?? 'machinum:4b'
const CONCURRENCY = Number(process.env.MT_GLOSSARY_CONCURRENCY ?? 4)
const DRY_RUN = process.argv.includes('--dry-run')
/**
 * The extractor's heuristic also proposes verbs and date fragments ("Bring", "March 3, 2014").
 * Only names and named things belong in the glossary — a translated verb pinned in the prompt
 * constrains the prose for the wrong reason.
 */
const TYPES = new Set(['character', 'place', 'item'])
const CYRILLIC = /[Ѐ-ӿ]/

/**
 * A short reply is not automatically a usable Russian form: `max_tokens` can truncate it, an
 * echo comes back in English, and an explanation arrives on several lines. Pin nothing rather
 * than a fragment — the `ru` of a glossary entry constrains the whole book.
 */
function rejectReason(term: string, ru: string): string | undefined {
  if (ru.includes('\n')) return 'multi-line reply'
  if (!CYRILLIC.test(ru)) return 'no Cyrillic'
  if (ru.toLowerCase() === term.trim().toLowerCase()) return 'identical to the English term'
  return undefined
}

interface Term {
  id?: string
  term: string
  type?: string
  description?: string
  ru?: string | null
  aliases?: string[]
  [key: string]: unknown
}

const SYSTEM = [
  'You are a Russian literary translator preparing a glossary for a novel.',
  'Render the given English name or term exactly as it should appear in the Russian text:',
  'transliterate personal names (Файона, Кормак) and keep the transliterated name of ships,',
  'boats and brands as a noun (the ship Pelargic is «Пеларгик», never «Пеларгический»),',
  'translate telling place names and epithets,',
  'keep established Russian forms where they exist. Reply with the Russian form only —',
  'no quotes, no explanation, no alternatives.',
].join(' ')

async function ask(term: Term): Promise<string> {
  const context = term.description ? `\nContext: ${term.description}` : ''
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 60,
      reasoning_effort: 'none',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Term (${term.type ?? 'term'}): ${term.term}${context}` },
      ],
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return (data.choices?.[0]?.message?.content ?? '').trim().replace(/^["«]|["».]+$/g, '')
}

const glossary = JSON.parse(readFileSync(GLOSSARY, 'utf8')) as { terms?: Term[] }
const terms = glossary.terms ?? []
const pending = terms.filter(
  (t) => (!t.ru || t.ru.trim() === '') && TYPES.has(String(t.type ?? '')),
)
console.log(
  `glossary: ${terms.length} terms, ${pending.length} without a Russian form (model ${MODEL})`,
)

let cursor = 0
let filled = 0
async function worker(): Promise<void> {
  while (cursor < pending.length) {
    const term = pending[cursor++] as Term
    try {
      const ru = await ask(term)
      if (!ru) {
        console.warn(`  skip ${term.term}: empty reply`)
        continue
      }
      const reason = rejectReason(term.term, ru)
      if (reason) {
        console.warn(`  reject ${term.term}: ${reason} (${JSON.stringify(ru)})`)
        continue
      }
      console.log(`  ${term.term} → ${ru}`)
      if (!DRY_RUN) {
        term.ru = ru
        filled += 1
      }
    } catch (err) {
      console.warn(`  fail ${term.term}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker))

if (!DRY_RUN && filled > 0) {
  const tmp = `${GLOSSARY}.tmp`
  writeFileSync(tmp, `${JSON.stringify(glossary, null, 2)}\n`)
  renameSync(tmp, GLOSSARY)
}
console.log(
  DRY_RUN ? `dry run: ${pending.length} proposals` : `filled ${filled} term(s) in ${GLOSSARY}`,
)
