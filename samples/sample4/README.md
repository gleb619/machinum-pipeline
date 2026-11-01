# Sample 4 — Normalize raw chapters, analyze (summary, glossary, term tags), translate EN->RU

Reads raw web-novel chapters (`{ key, value }` JSONL lines, `value` = `Chapter N: Title\n<body lines>`),
normalizes the text offline and writes one markdown file per chapter to `chapters/en/chapter<N>.md`.

Three stages run one after another, each reading the files the previous one wrote in `chapters/`:

| # | Stage | Reads | Writes |
|---|---|---|---|
| 1 | `pipelines/normalize.ts` | `jsonl/input.jsonl` | `chapters/en/chapter<N>.md` |
| 2 | `pipelines/analyze.ts` | `chapters/en/` | `chapters/schema/`, `chapters/glossary.json`, `chapters/glossary.graph.json`, `chapters/en-tagged/` |
| 3 | `pipelines/translate.ts` | `chapters/en-tagged/` + glossary + summaries | `chapters/ru/chapter<N>.md`, `chapters/titles.json` |
| – | `pipelines/waypoint-log.ts` | `jsonl/input.jsonl` (same as stage 1) | `chapters/en/chapter<N>.md` + `chapters/waypoint-log.jsonl` audit log |

Every stage is offline by default (mock LLM backend, optional LLM steps switched off).

## What you will learn

- How to map a raw record to a chapter record with `chapterRecordMapper` (no bespoke tools: every step comes from `@mt/tools`).
- How to use the `textNormalizer` tool (quotes, dashes, ellipsis, invisible/stray symbols, blank
  lines, punctuation spacing; one paragraph per line, `[system messages]` kept).
- How to chain `typoFinder` and `markdownFormatter`, then emit with `mdOutputEmitter` into `@en`.
- How to plug an optional LLM typo-fix step via `pickLlmTool` + `createLlmTypoFix` from `@mt/tools`.
- How to build a cross-chapter glossary with `.batch()` + `createGlossaryExtractor` and keep the
  hand edits (`ru`, `type`, `aliases`) on re-run, then tag the text with `termTagger` so the next
  stage knows which term is which.
- How the glossary v2 extractor works: NER candidates seed the pool, the terms of the previous
  `glossary.json` are reused (an LLM only extracts the new ones), and every term gets its related
  terms (`references`) in `chapters/glossary.graph.json`.
- How to translate a chapter one line per LLM call, injecting only that line's glossary entries plus
  the chapter summary as context, and gate every reply with the line-parity linter.
- How to chain separate pipelines through the shared `chapters/` dir (`@en` -> `@chapters` -> `@chapters`).
- How to compose a new waypoint from a stock one with `defineWaypoint` lifecycle hooks
  (`onStart`/`filter`/`onItem`, `onOpen`/`onWrite`/`onClose`) and write a custom audit log — see
  `pipelines/waypoint-log.ts`, which reruns the normalize chain through wrapped `jsonl`/`md` endpoints.

## Directory layout

```
sample4/
├── pipelines/normalize.ts    # default + named export `normalizeFlow`
├── pipelines/analyze.ts      # stage 2: summaries + glossary + <term> tagging
├── pipelines/translate.ts    # stage 3: titles + line-by-line EN->RU with parity linter
├── pipelines/waypoint-log.ts # normalize chain via defineWaypoint-wrapped endpoints + audit log
├── lint-parity.ts            # standalone EN/RU parity check (no mt needed)
├── prepare-input.ts          # wraps raw {key,value} lines into {item} exchanges
├── jsonl/                    # raw input; generated input.jsonl is gitignored
├── chapters/{en,ru}/         # outputs (gitignored *.md)
├── chapters/schema/          # analyze: chapter<N>.summary.md
├── chapters/en-tagged/       # analyze: EN with <term id="..."> tags
├── chapters/glossary.json    # analyze: editable glossary
├── chapters/glossary.graph.json  # analyze: relation graph of the terms
├── chapters/titles.json      # translate: { "<n>": { en, ru } }
└── tests/
    ├── full-flow.test.ts     # all three stages chained end to end
    └── {normalize,analyze,translate}.test.ts   # one stage each
```

## How to run

The three stages in order (all offline, no API key):

```bash
pnpm install && pnpm build          # once, from the repo root: links mt + builds dist
pnpm run normalize                  # prepare-input + stage 1 -> chapters/en
pnpm run analyze                    # stage 2 -> schema/ + glossary.json + en-tagged/
$EDITOR chapters/glossary.json      # fill `ru` for the terms you care about, by hand
pnpm run translate                  # stage 3 -> chapters/ru + titles.json (mock RU text)
pnpm run lint-parity                # check chapters/en vs chapters/ru, exit 1 on mismatch
```

## Stage 1: normalize

```bash
pnpm run normalize                                # prepare-input + run (heuristics only, offline)
MT_LLM_TYPO_FIX=1 MT_LLM_TOOL=ollama pnpm run runner   # + LLM typo fix
```

`prepare-input.ts [raw.jsonl] [out.jsonl]` defaults to `jsonl/kidnapped_dragons_en_0-10.jsonl`
(your own data; not committed). When that file is absent (fresh clone) it falls back to a small
built-in two-chapter fixture and prints a notice, so the sample runs out of the box; pass an
explicit path to use your own raw JSONL. The LLM step is off unless `MT_LLM_TYPO_FIX=1`; with the default
`mock` backend it echoes the text back. A reply whose line count differs is discarded.

Decorative-only lines (`***`, `~~~`) are dropped; all other lines are preserved one to one.

## Stage 2: analyze

```bash
pnpm run analyze                  # reads chapters/en/*.md (run normalize first), offline
MT_LLM_SUMMARY=1 MT_LLM_TOOL=ollama pnpm run analyze   # optional LLM summary
MT_LLM_GLOSSARY=1 MT_LLM_TOOL=ollama pnpm run analyze  # optional LLM glossary
```

Writes, with no LLM needed:

- `chapters/schema/chapter<N>.summary.md` — heuristic summary (lead + most informative sentences).
  `MT_LLM_SUMMARY=1` asks the picked backend instead and falls back to the heuristic one.
- `chapters/glossary.json` — `{ terms: [{ id, term, type, count, firstChapter, ru, aliases, references? }] }`
  (capitalised names, `[Bracketed]` terms, repeated capitalised nouns, plus the NER candidates: proper names
  and locative phrases, whose kind fixes a guessed type — a place read as a character becomes a place).
  `references` holds the related terms. Edit it by hand: fill `ru`,
  fix `type`, add `aliases`, drop noise by moving a term string into `ignored`. Re-running keeps `ru`,
  `aliases`, `type`, manual terms; only `count` / `firstChapter` are recomputed. Delete the file to
  start over.
- `chapters/glossary.graph.json` — `{ nodes: [...], edges: [...] }`, the relation graph of the terms
  (`references` edges plus the co-occurrence ones: two terms that share a sentence of the corpus).
- `chapters/en-tagged/chapter<N>.md` — EN text with `<term id="ID">text</term>` around every glossary
  term (longest match first, no nesting, code skipped, idempotent, same line count). `stripTerms()`
  from `@mt/tools` restores the original text exactly.

With `MT_LLM_GLOSSARY=1` the glossary is analysed by the picked LLM backend with the bundled
`glossary.*` prompts: the terms of the previous `glossary.json` are reused (their `ru` and `type` win),
only the new candidates are extracted, the related terms of the answer become the `references`, and a
rejected or unparsable reply falls back to the heuristic glossary (`meta.glossaryLlm.fallbackUsed`).

Tools: `heuristicSummaryTool`, `glossaryExtractor`, `termTagger` (see `docs/steering/tools.md`).

## Stage 3: translate

```bash
pnpm run translate                         # offline mock LLM (echo-style fake RU), needs normalize + analyze first
MT_LLM_TOOL=ollama MT_ONLY_CHAPTERS=1 pnpm run translate   # real: remote ollama (gemma4:latest), chapter 1 only
pnpm run lint-parity                       # post-run check chapters/en vs chapters/ru, exit 1 on mismatch
```

Reads `chapters/en-tagged/*.md`, `chapters/schema/*.summary.md` and `chapters/glossary.json` (fill `ru` there
first!). Writes `chapters/ru/chapter<N>.md` and `chapters/titles.json`.

- Titles: `titleTranslator` over `.batch(5)`, glossary-aware, then the body.
- Body: every non-empty line is translated on its own (blank lines and fenced code are kept; the `# ` heading
  becomes the translated title). Slow by design: `MT_TRANSLATE_CONCURRENCY` (default 1).
- Prompt per line: chapter summary (context only) + glossary entries (`term = ru`) only for terms whose
  `<term id>` is in that line; terms with `ru: null` are sent as "transliterate consistently". Replies are
  stripped of `<think>` blocks and `<term>` tags.
- Each reply is checked with `lintLineParity`; a bad reply throws a retryable `LineParityError`, the engine retries
  (lines that already passed are memoised), and the run finally fails with the lint message. The finished chapter
  goes through `lineParityLinter` once more before it is written.
- Env: `MT_LLM_TOOL`, `MT_LLM_MODEL` (`pickLlmTool` from `@mt/tools`), `MT_ONLY_CHAPTERS` (e.g. `1,3`), `MT_TRANSLATE_CONCURRENCY`,
  `MT_TRANSLATE_PROMPT_LOG` (mock backend only: jsonl dump of every prompt, used by the test).

## How to clean up

```bash
pnpm run cleanup
```

Wipes every generated file (`chapters/{en,ru}/*.md`, `chapters/schema/`, `chapters/en-tagged/`,
`chapters/glossary.json`, `chapters/glossary.graph.json`, `chapters/titles.json`,
`chapters/waypoint-log.jsonl`, `jsonl/input.jsonl`)
and the `.mt` checkpoint tree. Keep `chapters/glossary.json` if you have hand edits worth keeping.

## How to run manually

One stage per `mt run`; the TS modules are the pipelines, so no build step is needed (`tsx` loads them):

```bash
cd samples/sample4
NODE_OPTIONS='--import tsx' ./node_modules/.bin/mt run ./pipelines/normalize.ts
NODE_OPTIONS='--import tsx' ./node_modules/.bin/mt run ./pipelines/analyze.ts
NODE_OPTIONS='--import tsx' ./node_modules/.bin/mt run ./pipelines/translate.ts
```

`node_modules/.bin/mt` comes from `pnpm install` at the repo root; `mt` resolves `@en`, `@chapters`,
`@ru` from `mt.json` → `"uris"`. A stage that failed is resumable — the checkpoint tree in `.mt/`
holds the completed items, so re-running the same command continues where it stopped.

## How the test works

`tests/full-flow.test.ts` is the integration test of the chain: one tiny raw JSONL fixture goes
through all three stages with the mock LLM, each stage reading the files the previous one wrote —
`chapters/en` -> glossary + `<term>`-tagged text -> `chapters/ru`. It asserts the tagged copy equals
the stage-1 text once the tags are stripped, that a hand-edited `ru` in `chapters/glossary.json` and
the stage-2 summary both reach the captured stage-3 prompts, that the RU heading equals
`chapters/titles.json`, and finally that `lint-parity.ts` exits 0 on the generated EN/RU pair.
No network, no LLM, no credentials.

`tests/analyze.test.ts` writes tiny synthetic chapters and checks summaries, glossary types/counts, the
relation graph (`glossary.graph.json`), tag round trip (`stripTerms(tagged) === original`, same line count) and
that manual `ru` edits survive a re-run.

`tests/translate.test.ts` writes synthetic tagged chapters + glossary + summaries, runs the pipeline with the mock
LLM and asserts RU/EN line parity, stripped tags, glossary `ru` / summary in the captured prompts (only for the terms
present in the line), `titles.json`, `lint-parity.ts` pass/fail, `MT_ONLY_CHAPTERS` and the engine retry of a bad reply.

`tests/normalize.test.ts` writes a tiny synthetic fixture to `jsonl/input.jsonl`, runs the pipeline
through `mt`, and asserts file count, preserved paragraph lines, no curly quotes / zero-width chars,
and literal `[bracketed]` text. No network, no LLM.

## Secret backends

Vault `apiKey` values are never plaintext: they are refs (`embed:<name>`, `keepass:<title>`,
`vlt:<name>`) resolved in memory when `mt run` loads the vault. This sample shows each backend
resolving a ref with no LLM call: `pipelines/secrets-demo.ts` looks the entry up and prints entry
name, provider and key **length** only. All keys are fake (`sk-demo-FAKE-...`); everything generated
lives in `.demo/` (gitignored).

`mt run` has no flag to pick a config file, so a variant is selected with existing mechanisms:

| Variant | Vault file (via `MT_VAULT`) | Backend env | Config layer |
|---|---|---|---|
| embed (default password) | `vault.embed.json` | `MT_EMBED_PATH` | `mt-embed.json` |
| embed (own password) | `vault.embed-custom.json` | `MT_EMBED_PATH`, `MT_EMBED_PASSWORD_FILE` | `mt-embed-custom.json` |
| keepass | `vault.keepass.json` | `MT_KEEPASS_PATH`, `MT_KEEPASS_PASSWORD_FILE` | `mt-keepass.json` |
| vlt | `vault.vlt.json` | vlt session (`vlt login`) | `mt-vlt.json` |

`mt.json` (embed, `demo.vaultRef = vault://demo-embed`) imports an optional gitignored
`mt.local.json`. The `mt-*.json` files are layers that only set `demo.vaultRef`; to use one by hand:
`cp mt-keepass.json mt.local.json`. The demo scripts set `MT_DEMO_VAULT_REF` instead (it wins).

```bash
pnpm --filter sample4 run demo:embed         # zero config: built-in default password
pnpm --filter sample4 run demo:embed-custom  # MT_EMBED_PASSWORD_FILE
pnpm --filter sample4 run demo:keepass       # creates .demo/demo.kdbx (pure JS, no binary)
pnpm --filter sample4 run demo:vlt           # needs vlt + unlocked session + secret demo_key
```

Expected tail (key length 23 for embed, 24 custom, 25 keepass, entry name varies):

```
[secrets-demo] entry=demo-embed provider=openrouter keyLength=23
[demo] OK, result written to .demo/result.jsonl (entry + key length only)
```

Manual equivalent of `demo:embed`:

```bash
export MT_EMBED_PATH=$PWD/.demo/secrets.embed.json MT_VAULT=./vault.embed.json
mt vault embed-add demo-embed --secret sk-demo-FAKE-embed-0000
MT_DEMO_VAULT_REF=vault://demo-embed NODE_OPTIONS='--import tsx' mt run ./pipelines/secrets-demo.ts
```

- **Rotating encryption keys.** The master password unlocks a keyring of named 256-bit encryption
  keys; each secret is sealed under one key (`kid`). `demo:embed` shows a second key and a secret under it:

  ```bash
  mt vault embed-keyring generate --kid k2          # new active key
  mt vault embed-add other --kid k2 --secret ...    # secret under k2
  mt vault embed-keyring list                       # kid, status, secret count; no key material
  mt vault embed-keyring rotate --reencrypt         # new key + re-seal every secret under it
  mt vault embed-keyring rm k1                      # only once no secret uses k1
  ```

  Changing the master password is a separate step: `mt vault embed-rekey`.
- **Default embed password is public obfuscation, not protection.** It prints a one-time warning.
  Set `MT_EMBED_PASSWORD` (or `MT_EMBED_PASSWORD_FILE`, see `demo:embed-custom`) for real use,
  before the first `embed-add`; a store made with the default cannot be opened with another password.
- **vlt**: `vlt create`/`login` are interactive-only, so the script does not seed it. It runs
  `mt vault vlt-status` and, if vlt is missing, locked, or `demo_key` absent, prints a `SKIPPED`
  message with setup steps and exits 0. Setup: `vlt create; vlt login;
  echo sk-demo-FAKE-vlt-0000 | vlt save --name demo_key`, then `pnpm --filter sample4 run demo:vlt`.
- Test: `tests/secrets.test.ts` runs embed, embed-custom, keepass end to end and the vlt script
  (passes either by resolving or by the graceful skip); also asserts vault files hold refs only.
