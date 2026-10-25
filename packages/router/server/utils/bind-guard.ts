const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim())
}

/**
 * The router holds upstream keys and spends money for whoever can reach it, so a non-loopback bind
 * requires a router token. Throws with a fix hint otherwise.
 */
export function assertSafeBind(host: string, token: string | undefined): void {
  if (isLoopbackHost(host) || token) return
  throw new Error(
    [
      `Refusing to bind router to non-loopback host '${host}' without a token.`,
      'Set MT_ROUTER_TOKEN=<secret> (clients send Authorization: Bearer <secret>)',
      'or bind to 127.0.0.1 / localhost.',
    ].join(' '),
  )
}
