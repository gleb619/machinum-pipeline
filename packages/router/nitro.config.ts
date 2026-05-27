import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineNitroConfig } from 'nitropack'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineNitroConfig({
  preset: 'node-server',
  dev: true,
  srcDir: 'server',
  publicAssets: [{ baseURL: '/', dir: resolve(__dirname, 'public') }],
  runtimeConfig: {
    routerPort: 7777,
    logDir: '~/.mt/router',
    dailyBudget: 5.0,
    retentionDays: 30,
  },
  routeRules: {
    '/api/chat/completions': { cors: true },
    '/api/translate': { cors: true },
  },
})
