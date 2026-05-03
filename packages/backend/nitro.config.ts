import { defineNitroConfig } from 'nitropack'

export default defineNitroConfig({
  preset: 'node-server',
  dev: true,
  srcDir: 'server',
  runtimeConfig: {
    runsDir: '.mt/runs',
  },
})
