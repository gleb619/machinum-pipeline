import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

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
  },
})
