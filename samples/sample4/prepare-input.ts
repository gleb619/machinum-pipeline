import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Wraps raw `{ key, value }` lines into JSONL envelopes (`{ item: { key, value } }`)
// that the `jsonl://` source reads. Usage: tsx prepare-input.ts [raw.jsonl] [out.jsonl]
const ROOT = import.meta.dirname
const raw = resolve(process.argv[2] ?? join(ROOT, 'jsonl', 'kidnapped_dragons_en_0-10.jsonl'))
const out = resolve(process.argv[3] ?? join(ROOT, 'jsonl', 'input.jsonl'))

// Built-in raw fixture so the sample runs out of the box (the real raw dump is gitignored).
// One record per chapter: `value` = "Chapter N: Title\n<body>". Messy enough for the
// normalizer (curly quotes, ellipsis, zero-width, stray spacing, a decorative `* * *`),
// with names recurring across chapters so the glossary extractor has something to find.
const FIXTURE = [
  {
    key: 'fixture/chapter-1',
    value:
      'Chapter 1: First Light\n“Arin Vale” stepped into the Iron Keep… the hall was empty .\n[System: level up!]\n\nArin Vale smiled at Marta​.',
  },
  {
    key: 'fixture/chapter-2',
    value:
      'Chapter 2: Second Wind\nThe Iron Keep fell. Marta nodded at Arin Vale.\n* * *\nSilver River froze over ,cold.',
  },
]

let source: string
if (existsSync(raw)) {
  source = readFileSync(raw, 'utf-8')
} else if (process.argv[2]) {
  throw new Error(`raw input not found: ${raw}`)
} else {
  console.log(
    `default raw file ${raw} missing - using built-in fixture (${FIXTURE.length} chapters)`,
  )
  source = `${FIXTURE.map((item) => JSON.stringify(item)).join('\n')}\n`
}

const lines = source
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.stringify({ item: JSON.parse(line) }))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${lines.join('\n')}\n`, 'utf-8')
console.log(`prepared ${lines.length} chapters -> ${out}`)
