# @mt/bookkit

Reusable stages and tools for long-form book pipelines. Extracted from
`samples/sample2-practical` so the next book project imports one package instead of copying
`lib/`.

```ts
import {
  createGlossaryIndexTool,
  createBookSource,
  createWriteQualityTool,
  qualityRootUri,
  qualitySourceUri,
  statsPath,
} from '@mt/bookkit'
```

## Layout

| Module | Purpose |
|---|---|
| `paths.ts` | Root/URI seams (`uriPath`, `rootUriOf`, `cleanUriFor`); no module-level project root |
| `stats.ts` | Chapter measurement + deterministic `schema/stats.json` |
| `split.ts` | Split oversized chapters, renumber the book, `schema/chapter-map.json` |
| `quality.ts` | Offline quality signals and the translate/preprocess verdict |
| `input.ts` | `chapterOnly`, `createBookSource` (quality-gated source selection) |
| `glossary-index.ts` | Book-wide glossary occurrence index + prior-terms prompt block |
| `vocabulary.ts` | 4/3/2/1-gram vocabulary with `df` and capitalisation signal |
| `entities.ts` | Glossary-to-chapter NER projection |
| `outputs.ts` | Summary/glossary/titles emitters, glossary tagging, chapter sorting |
| `preprocess.ts` | Conditional typo/proofread/gender branch + clean chapter output |
| `titles.ts` | Batch title translator (one XML request for a title batch) |
| `llm.ts` | Reusable LLM picker with optional free-model and real-backend guards |

## Root and env seams

Every path-aware entry point takes `BookPathsOptions`:

```ts
const options = { root: process.cwd(), bookUri: 'md://../../books/book2' }
createBookSource(options)()
qualitySourceUri(options)
statsPath(options)
```

Env overrides: `MT_BOOK`, `MT_CHAPTERS_ROOT`, `MT_FORCE_BRANCH`, plus the split-stage
compatibility vars `MT_SPLIT_BOOK` / `MT_SPLIT_ROOT`.

## Tests

```bash
pnpm --filter=@mt/bookkit test
pnpm --filter=@mt/bookkit typecheck
```
