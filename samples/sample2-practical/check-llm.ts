import { resolve } from 'node:path'
import { readMtConfigSync } from '@mt/core'
import { OLLAMA_BASE_URL, listOllamaModels, ollamaHealth, readLlmConfig } from '@mt/tools'

/**
 * Prints which backend/model the practical pipes will use. For `ollama` it also checks that the
 * server answers and that the configured model is installed.
 *
 *   pnpm run check-llm
 */
const ROOT = import.meta.dirname
const config = readLlmConfig(process.env, resolve(ROOT, 'mt.json'))
const settings = readMtConfigSync(ROOT).settings ?? {}
console.log(`backend: ${config.tool}`)
console.log(`model:   ${config.model}`)

if (config.tool !== 'ollama') {
  console.log('Not ollama: nothing to check (set llm.tool in mt.local.json or MT_LLM_TOOL=ollama).')
  process.exit(0)
}

const url = process.env.MT_OLLAMA_URL ?? String(settings['llm.baseUrl'] ?? OLLAMA_BASE_URL)
console.log(`url:     ${url}`)
const health = await ollamaHealth(url)
if (!health.ok) {
  console.error(`server not reachable: ${health.error} (SSH tunnel up? URL right?)`)
  process.exit(1)
}
console.log(`server:  ollama ${health.version ?? '?'}`)
const names = (await listOllamaModels(url)).map((model) => model.name)
console.log(`models:  ${names.join(', ') || '(none)'}`)
if (!names.includes(config.model)) {
  console.error(`model '${config.model}' is not on the server (ollama pull ${config.model})`)
  process.exit(1)
}
console.log('ok')
