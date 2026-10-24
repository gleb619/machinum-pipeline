import { type GateOutput, createLlmGate } from './llm-gate.js'

export interface LlmTranslateInput {
  text: string
  targetLang: string
  sourceLang?: string
  model?: string
}

export interface LlmTranslateOutput {
  translatedText: string
  model?: string
  tokens?: number
}

/**
 * Direct-to-LLM translation gate (no router `/api/translate`). Prompts are templates
 * `translate.system` / `translate.user` - override via tool option, `meta.prompts`, mt.json
 * `prompts.translate.system`, or env `MT_PROMPT_TRANSLATE_SYSTEM`.
 */
export const llmTranslate = createLlmGate<LlmTranslateInput, LlmTranslateOutput>({
  name: 'llm-translate',
  mdDescription:
    'Translates text with an LLM using overridable prompt templates (translate.system / translate.user).',
  normalize: (i) => ({
    systemPromptName: 'translate.system',
    promptName: 'translate.user',
    vars: {
      text: i.text,
      targetLang: i.targetLang,
      sourceLang: i.sourceLang ?? 'the source language',
    },
    model: i.model,
  }),
  toOutput: (state): LlmTranslateOutput => {
    const r = state.response as NonNullable<typeof state.response>
    return { translatedText: r.content.trim(), model: r.model, tokens: r.usage.totalTokens }
  },
  metaFlags: { translated: true },
})

export type { GateOutput }
