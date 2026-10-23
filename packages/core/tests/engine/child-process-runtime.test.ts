import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../src/contexts.js'
import {
  resolveToolCommand,
  runChildProcess,
  streamChildProcess,
  workerPath,
} from '../../src/engine/child-process.js'
import { pickTool } from '../../src/engine/worker.js'
import type { Envelope } from '../../src/types.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/echo-tool.ts', import.meta.url))

/** Runtime available on PATH? Skips the test when it isn't installed. */
function hasRuntime(runtime: string): boolean {
  try {
    execFileSync('which', [runtime], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function toolContext(stepName: string): ToolContext {
  return {
    step: { stepId: 'step-1', name: stepName, type: 'tool', index: 0 },
    run: { runId: 'run-1' },
  } as unknown as ToolContext
}

function envelope(value: string): Envelope<{ value: string }> {
  return { item: { value }, meta: {} }
}

const RUNTIMES = (['bun', 'npx', 'deno'] as const).filter(hasRuntime)

describe('resolveToolCommand', () => {
  it('maps every runtime to <runtime argv> + worker + module + toolName', () => {
    const worker = workerPath()
    expect(resolveToolCommand('bun', '/tools/echo.ts', 'echo')).toEqual({
      command: 'bun',
      args: ['run', worker, '/tools/echo.ts', 'echo'],
    })
    expect(resolveToolCommand('deno', '/tools/echo.ts', 'echo').args).toEqual([
      'run',
      '-A',
      worker,
      '/tools/echo.ts',
      'echo',
    ])
    expect(resolveToolCommand('npx', '/tools/echo.ts', 'echo').args).toEqual([
      'tsx',
      worker,
      '/tools/echo.ts',
      'echo',
    ])
  })

  it('throws a clear error when a child-process tool has no module', () => {
    expect(() => resolveToolCommand('bun', undefined, 'echo')).toThrow(/no `module`/)
  })

  it('rejects unknown runtimes', () => {
    expect(() => resolveToolCommand('python' as 'bun', '/tools/echo.ts', 'echo')).toThrow(
      /Unknown exec runtime/,
    )
  })
})

describe('worker pickTool', () => {
  const tool = { name: 'x', invoke: async () => ({}) }

  it('finds a default export with a matching name', () => {
    expect(pickTool({ default: tool }, 'x')).toBe(tool)
  })

  it('finds a named export whose key differs from the tool name', () => {
    const other = { name: 'y', invoke: async () => ({}) }
    expect(pickTool({ xTool: tool, yTool: other }, 'x')).toBe(tool)
  })

  it('finds a tool inside an exported record', () => {
    expect(pickTool({ tools: { x: tool } }, 'x')).toBe(tool)
  })

  it('fails with the export list when the tool is absent', () => {
    const other = { name: 'y', invoke: async () => ({}) }
    expect(() => pickTool({ other }, 'x')).toThrow(/Tool 'x' not found/)
    expect(() => pickTool({ other }, 'x')).toThrow(/other/)
  })
})

describe.runIf(RUNTIMES.length > 0)('worker NDJSON protocol', () => {
  it.each(RUNTIMES)(
    '%s returns the envelope the tool produced',
    async (runtime) => {
      const result = await runChildProcess(
        resolveToolCommand(runtime, FIXTURE, 'fixture-echo'),
        envelope('hello'),
        toolContext('step-echo'),
      )
      expect(result.item).toEqual({ value: 'echo:hello' })
      // Init line carried the ToolContext into the child.
      expect(result.meta.stepName).toBe('step-echo')
    },
    60_000,
  )

  it.each(RUNTIMES)(
    '%s streams many envelopes through one process',
    async (runtime) => {
      const inputs = ['a', 'b', 'c']
      const out: Envelope<{ value: string }>[] = []
      for await (const env of streamChildProcess<{ value: string }, { value: string }>(
        resolveToolCommand(runtime, FIXTURE, 'fixture-echo'),
        (async function* () {
          for (const value of inputs) yield envelope(value)
        })(),
        toolContext('step-stream'),
      )) {
        out.push(env)
      }
      expect(out.map((env) => env.item.value)).toEqual(['echo:a', 'echo:b', 'echo:c'])
    },
    60_000,
  )

  it.each(RUNTIMES)(
    '%s surfaces the child error and stderr on failure',
    async (runtime) => {
      await expect(
        runChildProcess(
          resolveToolCommand(runtime, FIXTURE, 'fixture-fail'),
          envelope('boom'),
          toolContext('step-fail'),
        ),
      ).rejects.toThrow(/fixture-exploded/)
    },
    60_000,
  )

  it.each(RUNTIMES)(
    '%s resolves tools exported from a record',
    async (runtime) => {
      const result = await runChildProcess(
        resolveToolCommand(runtime, FIXTURE, 'fixture-recorded'),
        envelope('x'),
        toolContext('step-recorded'),
      )
      expect(result.item).toEqual({ value: 'recorded:x' })
    },
    60_000,
  )
})
