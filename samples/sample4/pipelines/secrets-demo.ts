import { definePipeline, defineTool, isSecretRef, resolveVaultRef, withItem } from '@mt/core'
import '@mt/waypoint'

// === Secret backends demo: resolve a vault ref WITHOUT an LLM call ===
// `mt run` loads the vault (MT_VAULT) and resolves every `embed:` / `keepass:` / `vlt:` key in
// memory before any tool runs. This tool only proves that happened: it looks the entry up via
// `ctx.run.global.vault` and reports entry name, provider and the key LENGTH - never the key.
//
// Which entry: env `MT_DEMO_VAULT_REF`, else mt.json setting `demo.vaultRef`
// (the `mt-*.json` variants set it), else `vault://demo-embed`.

const DEFAULT_REF = 'vault://demo-embed'

const revealKeyLength = defineTool<unknown, { entry: string; provider: string; keyLength: number }>(
  {
    name: 'secrets-demo',
    version: '1.0.0',
    mdDescription: 'Resolve a vault entry and report its key length (never the key).',
    invoke: async (ex, ctx) => {
      const setting = ctx.run.global.settings['demo.vaultRef']
      const ref =
        process.env.MT_DEMO_VAULT_REF ?? (typeof setting === 'string' ? setting : DEFAULT_REF)
      const vault = ctx.run.global.vault
      if (!vault) throw new Error('no vault loaded (set MT_VAULT=./vault.<variant>.json)')
      const { entry, name } = resolveVaultRef(vault, ref)
      const key = entry.apiKey
      if (key === undefined || key === '') throw new Error(`entry "${name}" has no apiKey`)
      if (isSecretRef(key)) {
        throw new Error(`entry "${name}": ref was not resolved (is the backend disabled?)`)
      }
      const result = { entry: name, provider: entry.provider, keyLength: key.length }
      console.log(
        `[secrets-demo] entry=${result.entry} provider=${result.provider} keyLength=${result.keyLength}`,
      )
      return withItem(ex, result)
    },
  },
)

export default definePipeline()
  .from('jsonl://./.demo/input.jsonl')
  .use(revealKeyLength)
  .to('jsonl://./.demo/result.jsonl')
