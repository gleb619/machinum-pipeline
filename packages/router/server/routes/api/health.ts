import { defineEventHandler } from 'h3'
import { isMockMode } from '../../plugins/mock-mode.js'
import { getRouterConfig } from '../../utils/router-config.js'
import { getVaultUpstreams } from '../../utils/vault-upstreams.js'

export default defineEventHandler(() => {
  return {
    status: 'ok',
    mockMode: isMockMode(),
    uptime: Date.now(),
    // Names only; never keys or vault content.
    vault: {
      enabled: getRouterConfig().vault,
      entries: getRouterConfig().vault ? getVaultUpstreams().names : [],
    },
  }
})
