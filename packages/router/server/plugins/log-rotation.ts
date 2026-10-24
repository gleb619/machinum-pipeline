import type { NitroApp } from 'nitropack'
import { rotateLogs } from '../utils/log-rotator.js'
import { getRouterConfig } from '../utils/router-config.js'

/** Rotates the cost log on boot. Called by the Nitro plugin and explicitly by `startRouter()`. */
export function startLogRotation(): Promise<void> {
  return rotateLogs(getRouterConfig().retentionDays)
}

export default function logRotationPlugin(_nitroApp: NitroApp): void {
  void startLogRotation()
}
