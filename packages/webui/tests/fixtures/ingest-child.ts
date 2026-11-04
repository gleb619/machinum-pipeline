import type { ParsedUri, SourceContext } from '@mt/core'
import { createHttpSource } from '../../../waypoint/src/http-server.js'

const parent = process.env.MT_INGEST_PARENT
if (!parent) {
  process.stderr.write('MT_INGEST_PARENT is required\n')
  process.exit(2)
}

const uri: ParsedUri = {
  raw: 'hs://127.0.0.1:0/ingest',
  scheme: 'hs',
  host: '127.0.0.1:0',
  path: '/ingest',
  query: { port: '0' },
  fragment: '',
}

const logger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    process.stdout.write(`LOG ${message} ${JSON.stringify(meta ?? {})}\n`)
  },
  warn: () => undefined,
  error: (message: string) => {
    process.stderr.write(`${message}\n`)
  },
  debug: () => undefined,
}

const ctx = {
  run: {
    runId: 'child-run',
    global: { env: process.env as Record<string, string> },
    logger,
  },
} as unknown as SourceContext

const source = createHttpSource(uri)
for await (const exchange of source.start(ctx)) {
  process.stdout.write(`ITEM ${JSON.stringify(exchange.item)}\n`)
  break
}
