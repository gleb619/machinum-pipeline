import { paragraphTranslator, titleTranslator } from '../modification/chapter-translator.js'
import { schemaDocWriter } from '../modification/schema-doc.js'
import { stubSchemaEmit } from './emit.js'
import { stubParagraphTranslateSlot } from './paragraph-slot.js'
import { stubTitleTranslateSlot } from './title-slot.js'
import { stubTranslator } from './translator.js'

/**
 * Install stub tools for dry runs.
 *
 * This function swaps real tool slots with stub implementations to enable
 * offline/dry-run pipeline execution without API calls or LLM dependencies.
 *
 * Call this at the top of your pipeline module before using the tools:
 *
 * ```ts
 * import { installStubs } from '@mt/tools/stubs'
 *
 * installStubs()
 *
 * export default definePipeline()
 *   .use(titleTranslator)  // now uses stubTitleTranslateSlot
 *   .use(paragraphTranslator)  // now uses stubParagraphTranslateSlot
 *   .use(schemaDocWriter)  // now uses stubSchemaEmit
 * ```
 *
 * The stubs are:
 * - `stubTranslator`: wraps paragraphs in [ru]...[/ru] markers
 * - `stubSchemaEmit`: tags content and redirects to schema-mock subfolder
 * - `stubTitleTranslateSlot`: wraps titles in [mock]...[/mock] markers
 * - `stubParagraphTranslateSlot`: wraps paragraphs in [mock]...[/mock] markers
 */
export function installStubs(): void {
  // Swap slots on the shared tool instances
  titleTranslator.with({ translate: stubTitleTranslateSlot })
  paragraphTranslator.with({ translate: stubParagraphTranslateSlot })
  schemaDocWriter.with({ emit: stubSchemaEmit })
}

export { stubTranslator } from './translator.js'
export { stubSchemaEmit } from './emit.js'
export { stubTitleTranslateSlot } from './title-slot.js'
export { stubParagraphTranslateSlot } from './paragraph-slot.js'
