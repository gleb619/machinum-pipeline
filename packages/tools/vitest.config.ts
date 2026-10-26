import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // GPU integration tests need the real ollama server: own config (`vitest.gpu.config.ts`).
    exclude: ['tests/it/**'],
  },
  coverage: {
    include: ['src/**/*.ts'],
    reporter: ['text', 'lcov'],
    thresholds: {
      statements: 91,
      branches: 82,
      functions: 95,
      lines: 91,
    },
  },
})
