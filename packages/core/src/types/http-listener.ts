import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/**
 * Handler mounted on a shared HTTP listener. The registry dispatches by exact pathname;
 * the `'*'` route is the fallback used by `mt serve` to mount its h3 app.
 */
export type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * One refcounted claim on an HTTP listener. `server` is the shared `http.Server`;
 * `shared` is true when another lease already held the same listener at acquire time.
 */
export interface ListenerLease {
  readonly server: Server
  readonly host: string
  readonly port: number
  readonly shared: boolean
  /** Mount an exact pathname (`'*'` = fallback). Returns a disposer that removes the route. */
  addRoute(path: string, handler: HttpRouteHandler): () => void
  /** Drop this lease and every route it mounted. Closes the server after the last release. */
  release(): Promise<void>
}
