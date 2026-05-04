import { defineNitroConfig } from 'nitropack'

export default defineNitroConfig({
  preset: 'node-server',
  dev: true,
  srcDir: 'server',
  runtimeConfig: {
    routerPort: 7777,
    logDir: '~/.mt/router',
    dailyBudget: 5.00,
    retentionDays: 30,
  },
  routeRules: {
    '/api/chat/completions': { cors: true },
  },
})
