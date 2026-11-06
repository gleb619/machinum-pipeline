import { definePipeline, defineTool, isSecretRef, resolveVaultRef, withItem } from '@mt/core'
import '@mt/waypoint'

/**
 * PIPE 10 — secret backends, config-only and offline.
 *
 * `mt run` loads the vault (`MT_VAULT=./vault.embed.json`) and resolves every `embed:` /
 * `keepass:` / `vlt:` reference in memory before any tool runs. This pipe proves that happened:
 * it looks the entry up through `ctx.run.global.vault` and reports the entry name, provider and
 * the key LENGTH — never the key itself.
 *
 * The demo uses the built-in `embed:` backend (pure `node:crypto`, no external binary); the same
 * pipeline works with KeePass/vlt when their refs are configured. See `demo/embed.sh` and
 * `vault.embed.json`.
 *
 * Which entry: `MT_DEMO_VAULT_REF`, else mt.json `settings["demo.vaultRef"]`, else
 * `vault://demo-embed`.
 */
const DEFAULT_REF = 'vault://demo-embed'

const revealKeyLength = defineTool<unknown, { entry: string; provider: string; keyLength: number }>(
  {
    name: 'pipe10-secrets',
    version: '1.0.0',
    mdDescription: 'Resolves a vault entry and reports its key length (never the key).',
    async invoke(env, ctx) {
      const setting = ctx.run.global.settings['demo.vaultRef']
      const ref =
        process.env.MT_DEMO_VAULT_REF ?? (typeof setting === 'string' ? setting : DEFAULT_REF)
      const vault = ctx.run.global.vault
      if (!vault) throw new Error('no vault loaded (set MT_VAULT=./vault.embed.json)')
      const { entry, name } = resolveVaultRef(vault, ref)
      const key = entry.apiKey
      if (key === undefined || key === '') throw new Error(`entry "${name}" has no apiKey`)
      if (isSecretRef(key)) {
        throw new Error(`entry "${name}": ref was not resolved (is the backend disabled?)`)
      }
      const result = { entry: name, provider: entry.provider, keyLength: key.length }
      ctx.run.logger.info('secrets-demo', result)
      return withItem(env, result)
    },
  },
)

export default definePipeline({ id: 'pipe10-secrets' })
  .from('jsonl://./.demo/input.jsonl')
  .use(revealKeyLength)
  .to('jsonl://./.demo/result.jsonl')
