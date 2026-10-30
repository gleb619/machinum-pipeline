import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@mt/core': resolve(import.meta.dirname, '../core/src'),
      '@mt/core/engine/git-worktree-source.js': resolve(
        import.meta.dirname,
        '../core/src/engine/git-worktree-source.ts',
      ),
      '@mt/waypoint': resolve(import.meta.dirname, '../waypoint/src'),
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
