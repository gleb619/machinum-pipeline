import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Wraps raw `{ key, value }` lines into JSONL envelopes (`{ item: { key, value } }`)
// that the `jsonl://` source reads. Usage: tsx prepare-input.ts [raw.jsonl] [out.jsonl]
const ROOT = import.meta.dirname
const raw = resolve(process.argv[2] ?? join(ROOT, 'jsonl', 'kidnapped_dragons_en_0-10.jsonl'))
const out = resolve(process.argv[3] ?? join(ROOT, 'jsonl', 'input.jsonl'))

const lines = readFileSync(raw, 'utf-8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.stringify({ item: JSON.parse(line) }))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${lines.join('\n')}\n`, 'utf-8')
console.log(`prepared ${lines.length} chapters -> ${out}`)
