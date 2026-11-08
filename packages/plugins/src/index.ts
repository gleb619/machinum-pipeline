import { registerSecretResolver } from '@mt/core'
import { KEEPASS_REF_PREFIX, resolveKeepassValue } from './keepass.js'
import { VLT_REF_PREFIX, resolveVltValue } from './vlt.js'

/**
 * `@mt/plugins` — optional secret backends for the mt vault.
 *
 * Importing this package registers the `vlt:` and `keepass:` vault secret resolvers
 * as a side effect (`import '@mt/plugins'`). The built-in `embed:` backend lives in
 * `@mt/core` (`secrets.ts`) and needs no registration.
 */

registerSecretResolver(KEEPASS_REF_PREFIX, resolveKeepassValue)
registerSecretResolver(VLT_REF_PREFIX, resolveVltValue)

export * from './keepass.js'
export * from './vlt.js'
