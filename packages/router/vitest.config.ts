import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Never read the developer's real vault in tests; vault tests point MT_VAULT at a temp dir.
    env: { MT_VAULT: '/nonexistent/mt-router-test-vault.json', MT_ROUTER_VAULT_POLL_MS: '0' },
  },
})
