import type { NitroApp } from 'nitropack'
import { getRouterConfig } from '../utils/router-config.js'

export function isMockMode(): boolean {
  return getRouterConfig().mock
}

/** Logs the active mode. Called by the Nitro plugin and explicitly by `startRouter()`. */
export function startMockMode(): void {
  if (isMockMode()) {
    console.log('[router] Starting in MOCK mode')
  } else {
    console.log('[router] Starting in LIVE mode')
  }
}

export default function mockModePlugin(_nitroApp: NitroApp): void {
  startMockMode()
}
