# Sample 2 — Beginner, Intermediate, Advanced

Three pipelines that grow from "one source, one tool, one target" to fork/merge and
type-driven chunking. No LLM calls are needed.

| Level | Pipeline | What it teaches |
| --- | --- | --- |
| Beginner | [`pipelines/beginner.ts`](pipelines/beginner.ts) | `jsonl://` → shipped tool → `md://`; typed chapter content; `console://` |
| Intermediate | [`pipelines/intermediate.ts`](pipelines/intermediate.ts) | `.fork(name, [branches])` runs three tool-based branches per chapter |
| Advanced | [`pipelines/advanced.ts`](pipelines/advanced.ts) | `chunkSplit`, separator reuse, the Structure Ladder, `tokens://` |

## Big input fixtures

`prepare-input.ts` generates the big lorem-ipsum fixtures for all three levels. It uses the
`lorem-ipsum` dev dependency with a seeded random generator, so a forced regeneration produces
the same text.

| File | Used by | Shape |
| --- | --- | --- |
| `jsonl/input.jsonl` | Beginner | 10 records, two lorem paragraphs each |
| `jsonl/entities.jsonl` | Intermediate | 4 large lorem markdown chapters |
| `jsonl/ladder.jsonl` | Advanced ladder | 3 chapter records: 3 paragraphs × 3 lines |
| `chapters/chapter1.md` | Advanced chunking | Long chapter with decorative `---` lines |
| `chapters/chapter-series.md` | Advanced series split | Long chapter above the series target |

Fixtures are written **once**. Running `pnpm run prepare-input` again keeps an existing file, so a
pipeline always sees the same big text:

```bash
pnpm run prepare-input          # write missing fixtures, keep existing ones
pnpm run prepare-input:force    # regenerate every fixture (deterministic)
```

## Beginner — `pipelines/beginner.ts`

**No `defineTool` in this file.** Every processing step ships in `@mt/tools`:

```
jsonl://./jsonl/input.jsonl
  → flatMap              (record → one envelope per line)
  → wordCounter          (shipped tool → `wordCount` variable)
  → toMarkdownTool       (shipped tool → markdown text)
  → md://./chapters/output.md
```

| Pipeline | Command | Purpose |
| --- | --- | --- |
| `default` suite | `pnpm run runner:beginner` | Runs the five exported beginner pipelines |
| `defaultPipeline` | `pnpm run runner:beginner -- --pipeline defaultPipeline` | JSONL → `wordCounter` → `toMarkdownTool` → `chapters/output.md` |
| `typedContentPipeline` | `pnpm run runner:beginner -- --pipeline typedContentPipeline` | JSONL → typed `ChapterDoc` edit → `chapterDocBuild` → `chapters/output-typed.md` |
| `chapterDomainPipeline` | `pnpm run runner:beginner -- --pipeline chapterDomainPipeline` | JSONL → core `Chapter` value → `chapters/output-custom-typed.md` |
| `statsPipeline` | `pnpm run runner:beginner -- --pipeline statsPipeline` | JSONL → batch → `statFreq` (offline word-frequency report) → `void://` |
| `consolePreviewPipeline` | `pnpm run runner:beginner -- --pipeline consolePreviewPipeline` | JSONL → per-line text → `console://` (prefixed terminal preview) |

The end of the file shows the explicit suite and the `.parallel(true)` / sync alternatives.

## Intermediate — `pipelines/intermediate.ts`

One JSONL item is one markdown chapter. The parent pipeline forks each chapter into three
steps-only tool pipelines:

```
jsonl://./jsonl/entities.jsonl   (one markdown chapter per item)
  → fork('chapter-views', …)     (three branches per chapter, concurrently)
       ├─ countBranch           markdownStatsTool + readChapterDoc + tokenizeWords
       ├─ reorderBranch         readChapterDoc, sort each paragraph's lines
       └─ commasBranch          readChapterDoc, replace '.' with ','
  → md://./chapters/parallel-forks.md
```

`.fork('chapter-views', [countBranch, reorderBranch, commasBranch])` is the demo. The engine, not
the sample, provides the concurrency contract:

- every branch receives an isolated, deep-cloned copy of the parent envelope;
- the three branches run concurrently for each chapter;
- each parent/branch gets its own checkpoint node (`<stepId>/fork-<parent>/branch-<branch>`);
- branch output is buffered and merged in declaration order, independent of completion timing;
- if any branch fails, the run fails after every branch settles — no partially merged output.

```bash
pnpm run runner:intermediate   # three concurrent views per chapter → chapters/parallel-forks.md
```

For each chapter the file contains `counts`, `lines reordered`, then `dots replaced with commas`,
followed by the next chapter. The order is deterministic because it follows the branch declaration
order.

## Advanced — `pipelines/advanced.ts`

The chunk pipelines and the Structure Ladder, all built from shipped pieces. The package tool
`chunkSplit`, the registered `chunks`/`series` splitters, `tokenizeChunkDetailed`, and the built-in
entity-buffer waypoints do the work. The only local code is small mapping/rendering glue inside
`.flatMap()` and logging inside `.tap()`; the chunk descent itself is `.subflow('#chunks', 'ladder')`, which auto-publishes the chunks for the next rung.

| Pipeline | Command | Purpose |
| --- | --- | --- |
| `default` (suite) | `pnpm run runner:advanced` | All advanced pipelines in declaration order |
| `cleanSplitPipeline` | `pnpm run runner:advanced -- --pipeline cleanSplitPipeline` | Series split, then clean + chunk chapter1 and reuse the separators |
| `ladderPipeline` | `pnpm run runner:advanced -- --pipeline ladderPipeline` | The Structure Ladder → `chapters/ladder-chapters/*.md` + `chapters/ladder-summary.md` |
| `tokenLadderPipeline` | `pnpm run runner:advanced -- --pipeline tokenLadderPipeline` | Chunks → tokens → `chapters/token-ladder-summary.md` |

### Clean + split, and why the second run changes nothing

```
chapters/chapter1.md
  → md://./chapters/chapter1.md     (one envelope: the whole chapter)
  → chunkSplit                       (drops the decorative `---` lines, cuts the
                                      text into token-bounded chunks and
                                      writes them back with `---` between them)
  → md://./chapters                  (chapters/chunked.md)
```

- **Chunk size.** `chunkSplit` resolves the target as `meta.chunkSize` → tool option →
  mt.json `settings.chunkSize` → `MT_CHUNK_SIZE` → 6000. The sample pins `MT_CHUNK_SIZE=40` as a
  process env default so a chapter always splits into several chunks; a real `MT_CHUNK_SIZE` still
  wins: `MT_CHUNK_SIZE=100 pnpm run runner:advanced`.
- **Metadata stays out of the file.** `chunkSplit` sets both `meta.chunkCount` (in-flight) and the
  durable `chunkCount` variable, plus `chunkSeparator`. The `md://` target writes the payload
  verbatim, so `chapters/chunked.md` is pure chunk text — no synthetic comment header.
- **Separator reuse.** Stage two reads `chapters/chunked.md` and runs the same splitter. The text
  already carries `---` separators, so the splitter keeps the chunks as they are instead of cutting
  them again — `chapters/chunked-reused.md` is byte-identical to `chapters/chunked.md`.

### The Structure Ladder

```
jsonl://./jsonl/ladder.jsonl      (a chapter record)
  → chapterDocBuild + chapterIndexer + chapterDocEmit   → md://./chapters/ladder-chapters
  → .subflow('#chunks', 'ladder') (md → chunks)          → auto-publish chunks://ladder
  → chunks://ladder → .subflow('#paragraphs', 'ladder')  → auto-publish paragraphs://ladder
  → paragraphs://ladder → .subflow('lines://', 'ladder') → auto-publish lines://ladder
  → lines://ladder → .subflow('#words', 'ladder')        → auto-publish words://ladder
  → words://ladder → batch + summary                    → md://./chapters (chapters/ladder-summary.md)
```

`.subflow('#paragraphs')` and `.subflow('paragraphs://')` are two spellings of the same registry
lookup (bare `'paragraphs'` is rejected). The word rung uses the registered `wordSplitter` via
`.subflow('#words')`. Each stage is a cardinality op plus one entity buffer: the stage's splitter
subflow auto-publishes into `<rung>://<namespace>`, and the next stage reads it. The namespace is
the second argument; omitting it uses `default` (`chunks://` == `chunks://default`).

The entities are the real core types (`Chapter`, `Paragraph`, `Chunk`, `Line`); `Word` is not a
core type, so the sample declares one. The summary has one row per rung:

```
| Rung | Scheme | Units |
| --- | --- | --- |
| 0 | jsonl:// | 3 |
| 1 | md:// | 3 |
| 2 | chunks:// | … |
| 3 | paragraphs:// | … |
| 4 | lines:// | … |
| 5 | words:// | … |
```

The chunk, paragraph, line and word counts depend on the generated fixture and are recomputed on
every run.

### Series splitting

`cleanSplitPipeline` starts with the registered series splitter:

```ts
definePipeline()
  .from('md://./chapters/chapter-series.md')
  .subflow('#series') // same lookup as 'series://'
  .to('md://./chapters/series-first-output.md')
```

The balanced strategy splits a chapter whose meaningful body exceeds the target
(`SERIES_SPLIT_TARGET_CHARS`, 10_000 chars by default) into about
`ceil(bodyChars / targetChars)` parts, capped by whole paragraph/sentence boundaries. The sample
pins `MT_CONST_SERIES_SPLIT_TARGET_CHARS=150` as a process env default so the generated chapter
splits. A chapter below the target is returned unchanged as one item.

### Alternate route: chunks → tokens

`chunks://` also branches into `tokens://` (tiktoken-style BPE tokens, what the LLM sees).
`tokenLadderPipeline` runs jsonl → md → `chunks://ladder` → `.subflow('#tokens', 'ladder')` →
`tokens://ladder` → summary and writes `chapters/token-ladder-summary.md` with the chunk count,
the token count and a `Heuristic` flag.

```bash
pnpm run runner:advanced -- --pipeline tokenLadderPipeline
```

## Run everything

```bash
cd samples/sample2
pnpm run prepare-input   # once; keeps existing fixtures
pnpm run runner          # beginner, intermediate and advanced runners, one by one
cat chapters/runner-report.md # markdown report of the whole sweep
```

`pnpm run runner` runs `run-all.ts`: it prepares missing fixtures, then launches every
`runner:<level>` script one after another and writes a markdown report to `chapters/runner-report.md` —
one row per runner with its status, duration, run id, the files it touched and the captured output.
The same text goes to stdout, so `pnpm run runner | less` works too.

The runner scripts stay individually runnable:

```bash
pnpm run runner:beginner      # → chapters/output.md + terminal preview
pnpm run runner:intermediate  # → chapters/parallel-forks.md
pnpm run runner:advanced      # → chapters/chunked*.md + ladder/token summaries
```

Select one export with `--pipeline`:

```bash
pnpm run runner:beginner -- --pipeline defaultPipeline
pnpm run runner:beginner -- --pipeline statsPipeline
pnpm run runner:advanced -- --pipeline ladderPipeline
```

`pnpm test` deletes the generated `chapters/ladder-chapters/chapterN.md` files in its success
cleanup but keeps the tracked `.gitkeep`, so the directory never vanishes. The chapter files are
gitignored — only `.gitkeep` is committed.

## Clean up

```bash
pnpm run cleanup
```

## How the tests work

`tests/beginner.test.ts` writes fixed three-line JSONL input, runs the beginner pipelines, and
asserts output content, per-line `wordCount`, corpus statistics and the console preview.

`tests/intermediate.test.ts` writes two markdown chapter records and asserts the three branch
views (counts, alphabetical lines, dot→comma), their headings and their declaration-order merge.

`tests/advanced.test.ts` runs the chunk pipelines and asserts:

- `chapters/chunked.md` holds the chapter as chunks separated by `---`;
- the chunk count in the `chunkCount` variable and the number of separators agree, and the file
  contains only chunk text;
- the second run reuses the separators: `chapters/chunked-reused.md` is identical to
  `chapters/chunked.md`;
- the ladder writes one document per record, one summary row per rung, and the summary agrees with
  the run log;
- the token route reports more tokens than chunks.

`tests/ladder-visibility.test.ts` checks that `chapters/ladder-chapters/.gitkeep` stays tracked and
visible while generated chapter files stay ignored.
