import { createError, defineEventHandler, getRouterParam } from 'h3'
import { getRunner } from '../../../../utils/runner-registry.js'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing run id' })
  }

  const runner = getRunner(id)
  if (!runner) {
    throw createError({
      statusCode: 404,
      statusMessage: `Run not active: ${id}. The run may have finished or the backend was restarted.`,
    })
  }

  try {
    await runner.unpause()
    return { runId: id, state: 'running' }
  } catch (err) {
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to resume run: ${err instanceof Error ? err.message : 'Unknown'}`,
    })
  }
})
