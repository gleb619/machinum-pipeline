import type { NitroApp } from 'nitropack'

export let mockMode = false

export function isMockMode(): boolean {
  return mockMode
}

export default function mockModePlugin(_nitroApp: NitroApp): void {
  mockMode = process.env.MT_ROUTER_MOCK === 'true'
  if (mockMode) {
    console.log('[router] Starting in MOCK mode')
  } else {
    console.log('[router] Starting in LIVE mode')
  }
}
