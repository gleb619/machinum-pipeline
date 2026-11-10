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

  forkSync:
    '**.forkSync(...pipelines)** — Sequential fork: each parent envelope runs branch 1 to completion, then branch 2, ... with outputs merged back in arrival order. See `.fork()` for the parallel variant.',

  flatMap: `**.flatMap(fn)** — Fan out one envelope into many.

\`\`\`ts
.flatMap(async (item) => [item, item])
\`\`\`

\`fn\` receives the item and returns an array; the stream continues with its elements.`,

  fork: `**.fork(...pipelines)** — Run several branches CONCURRENTLY per envelope (parallel).

\`\`\`ts
.fork(branchA, branchB, branchC)
\`\`\`

Each branch runs on its own isolated deep-cloned envelope; buffered output merges in branch declaration order. Every argument must be a pipeline without its own \`.from()\` — otherwise a \`TypeError\` is thrown at definition time. A branch without a target merges back into the parent stream; an explicit \`.to()\` redirects it.

**.forkSync(...pipelines)** — Sequential variant: each parent envelope runs branch 1 to completion, then branch 2, ... and each output merges back in arrival order.

\`\`\`ts
.forkSync(branchA, branchB)
\`\`\``,

  subflow: `**.subflow(pipeline)** — Run an inline nested pipeline in the same Runner.

**.subflow(source, pipeline)** — Fan the current stream out 1 → N through a splitter, or run it through a batch child once per package.

\`\`\`ts
.subflow(inlinePipe)
.subflow('paragraphs://', paragraphPipe)
.subflow('batch://?size=5', titlePipe)
.subflow('batch://slide?size=3', windowPipe)
\`\`\`

The split form resolves the registered \`Splitter\` for the source URI's scheme (\`'paragraphs://'\` and \`'#paragraphs'\` are equivalent). The PARENT stream passes through unchanged — the child pipeline is a synchronous side branch. Publish into an entity buffer explicitly: \`.to('chunks://ladder')\` inside the child fills the buffer the next stage reads with \`.from('chunks://ladder')\`. A child without a target gets \`void://\` injected; a child that declares its own \`.from()\` throws a \`TypeError\`.

The batch form — \`batch://[tumbling|slide][?size=N][&slide=true|false]\` — groups the parent stream into packages (default size 5) and runs the child ONCE per package. The package is the child's INPUT: \`item\` and \`items\` hold the member payloads, so a child that starts with \`.use(...)\` needs no \`.from()\`. A child without a target gets \`batch://return\` injected; the parent continues with the ORIGINAL members, patched — changed group variables reach every member, and a group payload array of the package length zips back onto members by index. A child with its own \`.to()\` is a sink. \`size\` must be a positive integer (\`RangeError\` at definition time); \`slide\` makes overlapping windows. \`batch://group\`, \`batch://members\` and \`batch://return\` are child-side views only.

\`.subflow()\` splits the current stream — \`.fork()\` runs whole branches per envelope.`,

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
  'flatMap',
  'fork',
  'forkSync',
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
