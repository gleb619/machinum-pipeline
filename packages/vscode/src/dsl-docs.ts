/**
 * Hover documentation for the mt pipeline DSL.
 *
 * Mirrors `packages/core/src/dsl.ts` (signatures + JSDoc) — the extension cannot import
 * `@mt/core` (VS Code extension environment), so the docs are kept here in sync by hand.
 *
 * Pure module: no `vscode` import, so tests can exercise the lookup directly.
 */

/** Docs for `definePipeline()` — the free function, not a builder op. */
const DEFINE_PIPELINE_DOC = `**definePipeline(config?)** — Create a pipeline builder.

\`\`\`ts
definePipeline({ id?, retry?, onError? })
\`\`\`

- \`id\` — pipeline id (default: derived from the file name)
- \`retry\` — \`{ max: 3, backoffMs: 1000, strategy: 'exp' }\`
- \`onError\` — \`'fail-run' | 'skip-item' | 'dead-letter'\` (default \`'fail-run'\`)

Returns a fluent builder — chain \`.from()\`, \`.use()\`, \`.to()\` on it.`

/** Docs per DSL symbol, keyed by the identifier that appears in the source. */
export const DSL_DOCS: Readonly<Record<string, string>> = {
  definePipeline: DEFINE_PIPELINE_DOC,

  from: `**.from(source)** — Set the pipeline source. Accepts a \`Source\` instance or a URI string.

\`\`\`ts
.from('jsonl://./input.jsonl')
\`\`\``,

  use: `**.use(tool, overrides?)** — Add a tool step to the pipeline.

\`\`\`ts
.use(myTool)
.use(myTool, { retry: { max: 5 }, onError: 'skip-item' })
\`\`\`

\`overrides.retry\` and \`overrides.onError\` replace the pipeline defaults for this step.`,

  useAll: `**.useAll(...tools)** — Sugar for \`.use(a).use(b).use(c)\` — every tool runs in order.

\`\`\`ts
.useAll(cleanTool, translateTool)
\`\`\``,

  to: `**.to(target)** — Set the pipeline target. Accepts a \`Target\` instance or a URI string.

\`\`\`ts
.to('md://./output.md')
\`\`\`

Terminal step — the builder doubles as the finished pipeline.`,

  batch: `**.batch(opts?, nested?)** — Group envelopes into packages of \`size\` (default 5), flushing the remainder at the end of the stream.

\`\`\`ts
.batch(10)
.batch({ size: 10, slide: true })
\`\`\`

\`opts\` is a \`number\` or \`{ size?, slide? }\`. \`size\` must be a positive integer — anything else throws a \`RangeError\` at definition time. \`slide: true\` emits overlapping sliding windows (one per arrival) and cannot be combined with \`nested\`.

With \`nested\` (a \`definePipeline()\` pipeline) each package runs through it as a batch scope — pick the view with the \`batch://group\`, \`batch://members\` and \`batch://return\` waypoints.`,

  flatMap: `**.flatMap(fn)** — Fan out one envelope into many.

\`\`\`ts
.flatMap(async (item) => [item, item])
\`\`\`

\`fn\` receives the item and returns an array; the stream continues with its elements.`,

  fork: `**.fork(pipeline)** — Run a child pipeline per envelope (sequential).

\`\`\`ts
.fork(childPipeline)
\`\`\`

Each parent envelope runs the child in its own child Runner with a nested checkpoint node (\`<stepId>/fork-<n>\`); the child output is merged back in arrival order.

**.fork(name, branches)** — Run several branches concurrently per envelope (parallel).

\`\`\`ts
.fork('views', [branchA, branchB])
\`\`\`

\`name\` must be a non-empty string and \`branches\` a non-empty array of pipelines — otherwise a \`TypeError\` is thrown at definition time. Every branch runs concurrently per parent envelope; their buffered output is merged in branch declaration order.`,

  subflow: `**.subflow(pipeline)** — Run an inline nested pipeline in the same Runner.

**.subflow(splitterRef, namespace?)** — Split the current stream 1 → N.

\`\`\`ts
.subflow('paragraphs://')
.subflow('paragraphs://', 'ladder')
\`\`\`

The string form resolves the registered \`Splitter\` for that entity/buffer URI scheme (\`'paragraphs://'\` and \`'#paragraphs'\` are equivalent). When the scheme names an entity buffer (\`chunks\`, \`paragraphs\`, \`lines\`, \`words\`, \`tokens\`, \`chapters\`, \`batches\`), the produced envelopes are also auto-published into \`<scheme>://<namespace>\`; \`namespace\` defaults to \`default\`.

\`.subflow()\` splits the current stream — \`.fork()\` starts a child Runner per envelope.`,

  tap: `**.tap(fn)** — Observe every envelope; the stream passes through unchanged.

\`\`\`ts
.tap((ex) => log.info('got item', { id: ex.id }))
\`\`\`

\`fn\` receives the full \`Exchange\` (\`{ id, item, items?, meta, variables }\`).`,

  log: `**.log(options?)** — Log every envelope to the console; the stream passes through unchanged. Sugar over \`.tap()\`.

\`\`\`ts
.log()
.log({ label: 'chapters', level: 'info' })
\`\`\`

\`options\` is a string (label shorthand) or \`{ label?, level?, truncate? }\`. \`level\` is \`log\` (maps to \`info\`), \`info\`, \`warn\`, \`error\` or \`debug\`.`,
}

/** Builder ops of `PipelineBuilder` — documented only when the word is a method call. */
const BUILDER_OPS = new Set<string>([
  'from',
  'use',
  'useAll',
  'to',
  'batch',
  'flatMap',
  'fork',
  'subflow',
  'tap',
  'log',
])

/**
 * Resolve hover documentation for the word under the cursor.
 *
 * Builder ops resolve only when the word is a method call (preceded by `.`); `definePipeline`
 * resolves as a plain identifier. Anything else has no documentation.
 *
 * @param word - The identifier under the cursor.
 * @param precedingChar - The character right before the word (`''` at the start of a line).
 */
export function docsFor(word: string, precedingChar: string): string | undefined {
  if (word === 'definePipeline') {
    return DEFINE_PIPELINE_DOC
  }
  if (precedingChar !== '.' || !BUILDER_OPS.has(word)) {
    return undefined
  }
  return DSL_DOCS[word]
}
