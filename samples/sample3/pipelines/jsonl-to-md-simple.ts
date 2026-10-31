import { join } from 'node:path'
import { definePipeline, defineTool } from '@mt/core'
import {
  chapterDoc,
  chapterIndexer,
  chapterValidator,
  forbiddenCharDetector,
  mdOutputEmitter,
  stubTranslator,
  tokenCounter,
  wordCounter,
} from '@mt/tools'
import '@mt/waypoint'

// === URI shortcuts (aliases) ===
// Source/target URIs can be written as '@name' shortcuts instead of full URIs.
// Shortcuts are defined in this sample's mt.json under "uris", e.g.:
//   "uris": { "en": "md://./chapters/en", "ru": "chapter-output://./chapters" }
// They are resolved at pipeline run time; full URIs still work unchanged.

// === Flow 1: JSONL → Verified MD ===
const verifyFlow = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterDoc)
  .use(wordCounter)
  .use(chapterIndexer)
  .use(chapterValidator)
  .use(forbiddenCharDetector)
  .use(tokenCounter)
  .tap(async (item: unknown) => {
    const meta = (item as { meta?: { errors?: unknown } }).meta
    console.log('[verify] errors:', meta?.errors)
  })
  .to('@en')

// === Flow 2: MD(EN) → MD(RU) simple translation ===
// Simple translation using stubTranslator (no LLM, no summary/proofreading).
// Just basic placeholder translation for demonstration.
const translateFlow = definePipeline()
  .from('@en')
  .use(wordCounter)
  .use(chapterIndexer)
  .use(stubTranslator)
  .to('@ru')

// === Default: orchestration pipeline ===
export default definePipeline().subflow(verifyFlow).subflow(translateFlow)
