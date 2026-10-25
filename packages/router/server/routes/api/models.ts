import { defineEventHandler } from 'h3'
import { listModels } from '../../utils/models-list.js'
import { getUpstreamRegistry } from '../../utils/upstream.js'

/** OpenAI-compatible model list of routable ids (see utils/models-list.ts). */
export default defineEventHandler(async () => {
  return { object: 'list', data: await listModels(getUpstreamRegistry()) }
})
