import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@mt/core': resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  coverage: {
    include: ['src/**/*.ts'],
    exclude: ['tests/**/*.test.ts'],
    reporter: ['text', 'lcov'],
    thresholds: {
      statements: 88,
      branches: 82,
      functions: 91,
      lines: 88,
    },
  },
})
