import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // GPU integration tests need the real ollama server: own config (`vitest.gpu.config.ts`).
    exclude: ['tests/it/**'],
  },
})
