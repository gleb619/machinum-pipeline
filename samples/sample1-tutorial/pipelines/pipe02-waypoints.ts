import { definePipeline, defineProcess, defineTool, withMeta } from '@mt/core'
import { chapterDoc, stubTranslator, textNormalizer } from '@mt/tools'
import '@mt/waypoint'
// Registers the sample-owned `my-target://` scheme used by the `@ru` alias.
import '../waypoints/my-target.js'

/**
 * PIPE 02 — URI schemes, aliases and waypoints.
 *
 * Three lessons in one file:
 *
 *  1. A SOURCE THAT LISTENS. `hs://` starts an HTTP server and turns every POST body into an
 *     envelope. `?count=3` stops the source after three envelopes, so a run is bounded.
 *     `simulate-book1.ts` is the client that posts the chapters of `books/book1`.
 *
 *  2. URI ALIASES. `mt.json` → `"uris"` maps a short name to a full URI; a pipeline addresses it
 *     as `@name`. Here `@en` is `md://./chapters/en` and `@ru` is the sample-owned
 *     `my-target://./chapters`.
 *
 *  3. A SAMPLE-OWNED WAYPOINT. `my-target://` writes `chapters/<meta.lang>/chapter<N>.md`. The
 *     tool decides *what* (the language, the chapter number); the waypoint decides *where*.
 */

/**
 * Stamps the chapter number of the H1 into `meta.chapterNum`.
 *
 * The `my-target://` target turns that number into the filename, so the RU chapters keep the
 * numbers of their English originals.
 */
const stampChapterNumber = defineTool<string, string>({
  name: 'pipe02-stamp-chapter-number',
  version: '1.0.0',
  mdDescription: 'Reads the chapter number from the H1 and stamps meta.chapterNum.',
  async invoke(env) {
    const digits = /^#\s+(?:Chapter\s+)?(\d+)/m.exec(env.item)?.[1]
    if (digits === undefined) return env
    return withMeta(env, { chapterNum: Number.parseInt(digits, 10) })
  },
})

/** HTTP source → JSONL file. Run `pnpm run simulate` while this pipe waits for POSTs. */
export const httpIngestPipeline = definePipeline({ id: 'pipe02-http-ingest' })
  .from('hs://localhost:9877/?count=3')
  .to('jsonl://./jsonl/http-output.jsonl')

/** JSONL → markdown chapters in the `@en` folder. */
export const aliasPipeline = definePipeline({ id: 'pipe02-alias' })
  .from('jsonl://./jsonl/http-output.jsonl')
  .use(chapterDoc)
  .to('@en')

/** English chapters → normalized, stub-translated RU chapters in `chapters/ru/`. */
export const customSchemePipeline = definePipeline({ id: 'pipe02-custom-scheme' })
  .from('@en')
  .use(textNormalizer)
  .use(stubTranslator)
  .use(stampChapterNumber)
  .to('@ru')

/**
 * The three pipes as one suite.
 *
 * The HTTP pipe has to run while the client posts, so the suite runs the pipes in order:
 * `mt run ./pipelines/pipe02-waypoints.ts` waits for the POSTs of `pnpm run simulate`.
 */
export const waypointSuite = defineProcess(
  [httpIngestPipeline, aliasPipeline, customSchemePipeline],
  { id: 'pipe02-suite' },
)

export default waypointSuite
