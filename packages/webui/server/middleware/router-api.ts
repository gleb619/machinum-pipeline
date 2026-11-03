import { createRouterApp, handleRouterError, isRouterApiPath } from '@mt/router/standalone'
import { createError, defineEventHandler } from 'h3'

const routerApp = createRouterApp()

/** Mount the router API beside the Nitro dev routes without touching the admin `/api/health`. */
export default defineEventHandler(async (event) => {
  if (!isRouterApiPath(event.path ?? '')) return
  try {
    return await routerApp.handler(event)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    handleRouterError(createError(message), event)
  }
})
