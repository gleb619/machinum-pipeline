import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Never read the developer's real vault in tests; router tests point MT_HOME at a temp dir.
    env: {
      MT_VAULT: '/nonexistent/mt-webui-test-vault.json',
      MT_ROUTER_VAULT: 'false',
      MT_ROUTER_VAULT_POLL_MS: '0',
    },
  },
})
