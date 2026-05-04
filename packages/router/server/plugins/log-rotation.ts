import type { NitroApp } from 'nitropack'
import { rotateLogs } from '../utils/log-rotator.js'

export default function logRotationPlugin(_nitroApp: NitroApp): void {
  const retentionDays = Number.parseInt(process.env.MT_RETENTION_DAYS || '30', 10)
  rotateLogs(retentionDays)
}
