import { defineEventHandler } from 'h3'

export default defineEventHandler(() => {
  return {
    defaultModel: 'openai/gpt-4o-mini',
    supportedLanguages: ['en', 'ru', 'zh', 'fr', 'de', 'es', 'ja', 'ko'],
  }
})
