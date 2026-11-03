import { prepareRouterRuntime } from '@mt/router/standalone'
import type { NitroApp } from 'nitropack'

/** Dev-server twin of `startBackend()`: config, bind guard, vault refresh and log rotation. */
export default async function routerRuntimePlugin(_nitroApp: NitroApp): Promise<void> {
  await prepareRouterRuntime()
}
