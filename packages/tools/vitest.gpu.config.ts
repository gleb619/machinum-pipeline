import { defineConfig } from 'vitest/config'

/**
 * GPU integration tests (`tests/it`): run against the real ollama server on
 * `borispc3.ai:7869`. Never part of `pnpm test` — invoke with `pnpm test:gpu`.
 */
export default defineConfig({
  test: {
    include: ['tests/it/**/*.it.test.ts'],
    testTimeout: 30_000,
  },
})
