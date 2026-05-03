import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createError, defineEventHandler, getRouterParam } from 'h3'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing run id' })
  }
  const runsDir = join(process.cwd(), '.mt', 'runs', id)
  try {
    const files = await readdir(runsDir)
    const stateRaw = await readFile(join(runsDir, 'state.json'), 'utf-8')
    const state = JSON.parse(stateRaw)
    return { id, ...state, files }
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Run not found' })
  }
})
