import { defineEventHandler } from 'h3'
import { isMockMode } from '../../plugins/mock-mode.js'

export default defineEventHandler(() => {
  return {
    status: 'ok',
    mockMode: isMockMode(),
    uptime: Date.now(),
  }
})
