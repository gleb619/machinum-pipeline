# Sample 2 — Markdown Processing

Pipelines over JSONL and markdown, without LLM calls:

- **`pipelines/basic-md-processing.ts`** — the basics. Shipped tools, typed chapter content and
  corpus statistics.
- **`pipelines/parallel-forks-md-processing.ts`** — JSONL markdown chapters, then three tool-based
  branch pipelines run concurrently through core `.fork('chapter-views', [...])` and merge into
  one markdown file.
- **`pipelines/chunk-normalization.ts`** — chunk splitting, separator reuse and the Structure Ladder.

## What you will learn

- How to read a source (`jsonl://`) and write a target (`md://`).
- How to use the tools that already ship in `@mt/tools` instead of hand-rolling your own.
- How to fan data out with `.flatMap()` and group it with `.batch()`.
- How to parse the main entities (`Chapter → Paragraph → Line`) with shipped tools inside each branch.
- How to run independent branch pipelines concurrently with core `.fork(name, branches)` and
  merge their output deterministically.
- How to clean a chapter of its decorative `---` lines, split it into token-bounded chunks and
  put the chunks back together — without re-splitting them on the next run.
- How to walk the **Structure Ladder** (`jsonl://` → `md://` → `chunks://` → `paragraphs://` →
  `lines://` → `words://`) and count every rung.

## Basics pipeline (`pipelines/basic-md-processing.ts`)

**No `defineTool` in this file** — every processing step is a tool that already ships in
`@mt/tools`. The whole pipeline body is three DSL calls:

```
jsonl://./jsonl/input.jsonl
  → flatMap              (record → one envelope per line)
  → wordCounter          (shipped tool → `wordCount` variable)
  → toMarkdownTool       (shipped tool → markdown text)
  → md://./chapters/output.md
```

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `default` (explicit suite) | `pnpm run runner:basic` | Runs the four exported basics pipelines |
| `defaultPipeline` | `pnpm run runner:basic -- --pipeline defaultPipeline` | JSONL → `wordCounter` → `toMarkdownTool` → `chapters/output.md` |
| `typedContentPipeline` | `pnpm run runner:basic -- --pipeline typedContentPipeline` | JSONL → typed `ChapterDoc` edit → `chapterDocBuild` → `chapters/output-typed.md` |
| `statsPipeline` | `pnpm run runner:stats` | JSONL → batch → `statFreq` (offline word-frequency report) → `void://` |

The end of the file shows the explicit suite and the `.parallel(true)` / sync alternatives.

## Parallel forks (`pipelines/parallel-forks-md-processing.ts`)

One JSONL item is one markdown chapter. The parent pipeline does no branching of its own; it
forks the chapter into three steps-only tool pipelines:

```
jsonl://./jsonl/entities.jsonl   (one markdown chapter per item)
  → fork('chapter-views', …)     (three branches per chapter, concurrently)
       ├─ countBranch           markdownStatsTool + readChapterDoc + tokenizeWords
       ├─ reorderBranch         readChapterDoc, sort each paragraph's lines
       └─ commasBranch          readChapterDoc, replace '.' with ','
  → md://./chapters/parallel-forks.md
```

The `.fork('chapter-views', [countBranch, reorderBranch, commasBranch])` call is the demo. The
engine, not the sample, provides the concurrency contract:

- every branch receives an isolated, deep-cloned copy of the parent envelope, so mutations stay
  branch-local;
- the three branches run concurrently for each chapter;
- each parent/branch gets its own checkpoint node (`<stepId>/fork-<parent>/branch-<branch>`);
- branch output is buffered and merged in declaration order, independent of completion timing;
- if any branch fails, the run fails after every branch settles — no partially merged output.

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `default` | `pnpm run runner:parallel` | Three concurrent branch pipelines per chapter → `chapters/parallel-forks.md` |

For each chapter the file contains `counts`, `lines reordered`, then `dots replaced with commas`,
followed by the next chapter. The order is deterministic because it follows the branch declaration
order.

## Chunk normalization (`pipelines/chunk-normalization.ts`)

The chunk pipelines and the Structure Ladder, all built from shipped pieces only — the package
tools `chunkSplit`, the registered `chunks` and `series` splitters, `tokenizeChunkDetailed`, and
the built-in entity-buffer waypoints. The only local code is small mapping/rendering glue inside
`.flatMap()` and logging inside `.tap()`; the chunk descent itself is `.subflow('#chunks')`.

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `default` (explicit suite, sync) | `pnpm run runner:chunks` | All four pipelines in declaration order, sync: clean-split → ladder → token-ladder → series-split |
| `cleanSplitPipeline` | `pnpm run runner:chunks -- --pipeline cleanSplitPipeline` | Chapter → `chunkSplit` (clean + token-bounded chunks) → `chapters/chunked.md`, then the same file again → `chapters/chunked-reused.md` |
| `ladderPipeline` | `pnpm run runner:ladder` | The Structure Ladder → `chapters/ladder-chapters/*.md` + `chapters/ladder-summary.md` |
| `seriesSplitPipeline` | `pnpm run runner:chunks -- --pipeline seriesSplitPipeline` | Chapter → `.subflow('#series')` → `chapters/series-output.md` |

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
  mt.json `settings.chunkSize` → `MT_CHUNK_SIZE` → 6000. The sample pins
  `MT_CHUNK_SIZE=40` as a process env default (`CHUNK_SIZE = process.env.MT_CHUNK_SIZE ?? 40`) so
  one chapter always splits into several chunks; a real `MT_CHUNK_SIZE` still wins:
  `MT_CHUNK_SIZE=100 pnpm run runner:chunks`.
- **Metadata stays out of the file.** `chunkSplit` sets both `meta.chunkCount` (in-flight) and
  the durable `chunkCount` variable, plus `chunkSeparator`. The `md://` target writes the payload
  verbatim, so `chapters/chunked.md` is pure chunk text — no synthetic comment header. Downstream
  stages read the text they actually split, and the `md://` round-trip stays byte-identical.
- **Separator reuse.** Stage two reads `chapters/chunked.md` and runs the same splitter. The text
  already carries `---` separators, so the splitter keeps the chunks as they are instead of
  cutting them again — `chapters/chunked-reused.md` is byte-identical to `chapters/chunked.md`.

### The Structure Ladder

```
jsonl://./jsonl/ladder.jsonl      (a chapter record)
  → chapterDocBuild + chapterIndexer + chapterDocEmit   → md://./chapters/ladder-chapters
  → .subflow('#chunks') (md → chunks)                   → temp://chunks/ladder
  → chunks://ladder → .subflow('#paragraphs') (chunk → paragraphs) → temp://paragraphs/ladder (chunkId)
  → paragraphs://ladder → .subflow('lines://') (paragraph → lines) → temp://lines/ladder
  → lines://ladder → .subflow('#words') (line → words)   → temp://words/ladder
  → words://ladder → batch + summary                     → md://./chapters (chapters/ladder-summary.md)
```

The chunk, paragraph, line and word descents read like type identification.
`.subflow('#paragraphs')` and `.subflow('paragraphs://')` are two spellings of the same registry
lookup (bare `'paragraphs'` is rejected); the sample uses the `#` shortcut for the chunk,
paragraph and word rungs, and the explicit `'lines://'` form for the line rung (the series stage
uses `#series`). A URI with a path also works (`'paragraphs://ladder'`). Each string resolves a splitter
registered under that buffer scheme; the splitter sees the full Exchange and returns child
entities, so no local glue or splitter import is needed. The word rung uses the registered
`wordSplitter` via `.subflow('#words')`. `.flatMap()` remains for the record→document mapping and
the summary rendering. Each stage is still just a cardinality op plus one entity buffer. The typed
rungs are source-only: each stage writes `temp://<rung>/ladder`, the next reads
`<rung>://ladder`. The buffers are built in, the pipeline only uses them. The entities are the real
core types (`Chapter`, `Paragraph`, `Chunk`, `Line`); `Word` is not a core type, so the sample
declares one. The summary has one row per rung:

```
| Rung | Scheme | Units |
| --- | --- | --- |
| 0 | jsonl:// | 2 |
| 1 | md:// | 2 |
| 2 | chunks:// | 4 |
| 3 | paragraphs:// | 4 |
| 4 | lines:// | 5 |
| 5 | words:// | 73 |
```

Series splitting uses the same type-driven form:

```ts
definePipeline()
  .from('md://./chapters/chapter1.md')
  .subflow('#series') // same lookup as 'series://'
  .to('md://./chapters/series-output.md')
```

`.subflow('#series')` resolves the series splitter and fans the chapter into frontmatter-bearing
parts. It parses the markdown with `readChapterDoc` and writes each part with `writeChapterDoc`:
the H1 title gains the part number (`Chapter One 1`, `Chapter One 2`, …), `series` comes from the
original frontmatter or falls back to the original title, and `number`/`warnings` are preserved.
The balanced strategy splits a chapter whose meaningful body exceeds the target
(`SERIES_SPLIT_TARGET_CHARS`, 10_000 chars by default) into about
`ceil(bodyChars / targetChars)` parts, capped by whole paragraph/sentence boundaries. The sample
pins `MT_CONST_SERIES_SPLIT_TARGET_CHARS=150` as a process env default so the demo chapter splits;
a real env value still wins, and the full chain is `constants` variable → mt.json
`settings.constants.SERIES_SPLIT_TARGET_CHARS` → env → shipped constant. A chapter below the
target is returned unchanged as one item; no `series:` frontmatter is introduced. `.fork()` is not
used: it nests a child Runner per envelope, which is the wrong shape for a plain 1→N split.

#### Alternate route: chunks → tokens

`chunks://` also branches into `tokens://` (tiktoken-style BPE tokens, what the LLM sees).
`tokenLadderPipeline` runs jsonl → md → `temp://chunks/ladder` → `chunks://ladder` →
`temp://tokens/ladder` → `tokens://ladder` → summary and writes
`chapters/token-ladder-summary.md` with the chunk count, the token count and a `Heuristic` flag
(true only when `gpt-tokenizer` is unavailable and ~4-char pieces are used). With the demo
fixture: 4 chunks, 86 tokens.

```bash
pnpm run runner:tokens    # chapters/token-ladder-summary.md
```

```bash
pnpm run prepare-input    # writes jsonl/ladder.jsonl too
pnpm run runner:chunks    # chapters/chunked.md + chapters/chunked-reused.md
pnpm run runner:ladder    # chapters/ladder-chapters/*.md + chapters/ladder-summary.md
```

`pnpm test` deletes the generated `chapters/ladder-chapters/chapterN.md` files in its success
cleanup but keeps the tracked `.gitkeep`, so the directory never vanishes. The chapter files are
gitignored — only `.gitkeep` is committed. After `pnpm run runner:chunks` or `pnpm run runner:ladder`,
`ls chapters/ladder-chapters` shows them, and the run log prints the absolute directory the `md://`
target wrote to.

## Run manually

```bash
cd samples/sample2
pnpm run runner          # every runner script of this sample, one by one
cat out/runner-report.md # the markdown report of the whole sweep
```

`pnpm run runner` runs `run-all.ts`: it prepares the fixtures, then launches every sibling
runner script (`runner:basic`, `runner:parallel`, …) one after another and writes a markdown
report to `out/runner-report.md` — one row per runner with its status, duration, run id and the
files it touched, plus the captured output of each run. The same text goes to stdout, so
`pnpm run runner | less` works too.

The runner scripts stay individually runnable:

```bash
pnpm run runner:basic      # basics pipelines
pnpm run runner:parallel   # parallel branches → chapters/parallel-forks.md
pnpm run runner:chunks     # chapters/chunked.md + chapters/chunked-reused.md
pnpm run runner:ladder     # chapters/ladder-chapters/*.md + chapters/ladder-summary.md
```

Select one export with `--pipeline`:

```bash
pnpm run runner:basic -- --pipeline defaultPipeline
pnpm run runner:stats
```

## Clean up

```bash
pnpm run cleanup
```

## How the test works

`tests/basic-md-processing.test.ts` writes fixed three-line JSONL input, runs the basics
pipelines, and asserts:

- `chapters/output.md` contains every input line,
- the default pipeline logs the shipped `wordCounter` result per line (`wordCount=5`),
- `statsPipeline` logs the shipped `statFreq` report (`totalWords=15`, `uniqueWords=7`).

`tests/parallel-forks-md-processing.test.ts` writes two markdown chapter records and asserts:

- both chapters' counts (`2 paragraphs · 3 lines · 13 words` for Chapter One and `2 paragraphs ·
  2 lines · 9 words` for Chapter Two),
- every paragraph's lines are in alphabetical order,
- every `.` in the body became a `,`,
- each chapter's headings are `counts`, `lines reordered`, `dots replaced with commas`, and
  Chapter One's three sections precede Chapter Two's.

`tests/chunk-normalization.test.ts` runs the chunk pipelines and asserts:

- `chapters/chunked.md` holds the chapter as chunks separated by `---`,
- the chunk count in the `chunkCount` variable and in the number of separators agree
  (`chunkCount - 1` separators, so no decorative line survived the clean step) and the file
  contains only chunk text,
- the second run reuses the separators: `chapters/chunked-reused.md` is identical to
  `chapters/chunked.md` and both runs report the same chunk count,
- the document stage writes `chapters/ladder-chapters/chapter1.md` and `chapter2.md` with the
  fixture titles,
- the ladder summary has one row per rung and the counts agree with the run log and with the
  fixture (2 records, 2 documents, more chunks than documents, at least one paragraph per chunk, 5 lines,
  73 words),
- the series stage writes multiple numbered `# ` parts with `series:` frontmatter; the part count
  follows the pinned 150-char target (`ceil(bodyChars / 150)`, capped by paragraph boundaries).
