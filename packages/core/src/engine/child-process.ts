import { spawn } from 'node:child_process'
import type { Envelope } from '../types.ts'
import type { ToolContext } from '../contexts.ts'

/**
 * Options for spawning a child process tool.
 */
export interface ChildProcessOptions {
  command: 'npx' | 'deno' | 'bun'
  args: string[]
  timeout?: number
}

/**
 * Result from a child process tool execution.
 */
export interface ChildProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Execute a tool in a child process via stdio JSON.
 * Serialises { envelope, toolContext } to stdin, reads JSON from stdout.
 */
export async function runChildProcess<I, O>(
  options: ChildProcessOptions,
  envelope: Envelope<I>,
  toolContext: ToolContext,
): Promise<Envelope<O>> {
  const result = await spawnChildProcess(options, envelope, toolContext)
  return JSON.parse(result.stdout) as Envelope<O>
}

/**
 * Stream NDJSON through a child process for batch processing.
 * Each line of stdin is one envelope; each line of stdout is one result.
 */
export async function* streamChildProcess<I, O>(
  options: ChildProcessOptions,
  envelopes: AsyncIterable<Envelope<I>>,
  toolContext: ToolContext,
): AsyncIterable<Envelope<O>> {
  const child = spawn(options.command, options.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MT_TOOL_CONTEXT: JSON.stringify(toolContext),
    },
  })

  // Write envelopes to stdin using Node writable stream.
  const writePromise = (async () => {
    try {
      for await (const env of envelopes) {
        const line = JSON.stringify(env) + '\n'
        if (!child.stdin.write(line, 'utf8')) {
          await new Promise<void>((resolve) => child.stdin.once('drain', resolve))
        }
      }
    } finally {
      child.stdin.end()
    }
  })()

  // Read results from stdout
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) {
        yield JSON.parse(line) as Envelope<O>
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    yield JSON.parse(buffer) as Envelope<O>
  }

  await writePromise

  // Check exit code
  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', resolve)
  })

  if (exitCode !== 0) {
    const stderr = await new Promise<string>((resolve) => {
      let data = ''
      child.stderr.on('data', (chunk: Buffer) => {
        data += chunk.toString()
      })
      child.stderr.on('end', () => resolve(data))
    })
    throw new Error(`Child process exited with code ${exitCode}: ${stderr}`)
  }
}

/**
 * Spawn a child process and communicate via stdio JSON (one-shot).
 */
async function spawnChildProcess<I, O>(
  options: ChildProcessOptions,
  envelope: Envelope<I>,
  toolContext: ToolContext,
): Promise<ChildProcessResult> {
  return new Promise<ChildProcessResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MT_TOOL_CONTEXT: JSON.stringify(toolContext),
      },
      timeout: options.timeout,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 })
    })

    child.on('error', reject)

    // Write input envelope as JSON and close stdin
    const input = JSON.stringify({ envelope, toolContext })
    child.stdin.write(input)
    child.stdin.end()
  })
}
