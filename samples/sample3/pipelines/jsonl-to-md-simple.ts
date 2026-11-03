import { join } from 'node:path'
import { definePipeline, defineTool, getVariable } from '@mt/core'
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
// Sample-defined scheme used by the `@ru` alias (`my-target://./chapters`).
import '../waypoints/my-target.js'

// === URI shortcuts (aliases) ===
// Source/target URIs can be written as '@name' shortcuts instead of full URIs.
// Shortcuts are defined in this sample's mt.json under "uris", e.g.:
//   "uris": { "en": "md://./chapters/en", "ru": "my-target://./chapters" }
// They are resolved at pipeline run time; full URIs still work unchanged.

// === Flow 1: JSONL → Verified MD ===
const verifyFlow = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterDoc)
  .use(wordCounter)
  .use(chapterIndexer)
  .use(chapterValidator)
  .use(forbiddenCharDetector)
  .tap((ex) => console.log('[forbidden] findings:', getVariable(ex, 'forbidden')))
  .use(tokenCounter)
  .log('MyLogMarker', { truncate: true })
  .to('@en')

// === Flow 2: MD(EN) → MD(RU) simple translation ===
// Simple translation using stubTranslator (no LLM, no summary/proofreading).
// Just basic placeholder translation for demonstration.
const translateFlow = definePipeline().from('@en').use(stubTranslator).to('@ru')

// === Default: orchestration pipeline ===
export default definePipeline().subflow(verifyFlow).subflow(translateFlow)
