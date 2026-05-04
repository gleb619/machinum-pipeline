import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('UC-53 - Duplex Logger (architectural)', () => {
  it('logger.ts exports DuplexLogger class', async () => {
    const loggerPath = join(__dirname, '..', '..', 'src', 'utils', 'logger.ts')
    const source = await readFile(loggerPath, 'utf-8')
    expect(source).toMatch(/export class DuplexLogger/)
  })

  it('DuplexLogger implements Logger interface from @mt/core', async () => {
    const loggerPath = join(__dirname, '..', '..', 'src', 'utils', 'logger.ts')
    const source = await readFile(loggerPath, 'utf-8')
    expect(source).toMatch(/implements Logger/)
  })

  it('DuplexLogger has info method', async () => {
    const loggerPath = join(__dirname, '..', '..', 'src', 'utils', 'logger.ts')
    const source = await readFile(loggerPath, 'utf-8')
    expect(source).toMatch(/info\(message: string/)
  })

  it('DuplexLogger has warn method', async () => {
    const loggerPath = join(__dirname, '..', '..', 'src', 'utils', 'logger.ts')
    const source = await readFile(loggerPath, 'utf-8')
    expect(source).toMatch(/warn\(message: string/)
  })

  it('DuplexLogger has error method', async () => {
    const loggerPath = join(__dirname, '..', '..', 'src', 'utils', 'logger.ts')
    const source = await readFile(loggerPath, 'utf-8')
    expect(source).toMatch(/error\(message: string/)
  })

  it('DuplexLogger has debug method', async () => {
    const loggerPath = join(__dirname, '..', '..', 'src', 'utils', 'logger.ts')
    const source = await readFile(loggerPath, 'utf-8')
    expect(source).toMatch(/debug\(message: string/)
  })

  it('DuplexLogger constructor accepts logDir string', async () => {
    const loggerPath = join(__dirname, '..', '..', 'src', 'utils', 'logger.ts')
    const source = await readFile(loggerPath, 'utf-8')
    expect(source).toMatch(/constructor\(logDir: string\)/)
  })

  it('DuplexLogger writes to file using appendFile', async () => {
    const loggerPath = join(__dirname, '..', '..', 'src', 'utils', 'logger.ts')
    const source = await readFile(loggerPath, 'utf-8')
    expect(source).toMatch(/appendFile/)
  })
})
