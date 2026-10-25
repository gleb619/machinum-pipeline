/**
 * Model bench CLI: sends the built-in EN fixture paragraph-by-paragraph to an LLM gate tool for
 * each model, scores the RU output, writes results/<timestamp>.json and results/report.md.
 *
 *   tsx src/bench.ts --tool ollama --models gemma4:latest,gpt-oss:20b --runs 2 --out results/
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { ToolContext } from '@mt/core'
import {
  OLLAMA_BASE_URL,
  mockLlmCall,
  ollamaHealth,
  ollamaTool,
  openrouterFree,
  openrouterPool,
} from '../../packages/tools/src/index.ts'
import { FIXTURE, type Fixture } from './fixture.ts'
import { type ScoreResult, scoreTranslation } from './score.ts'

type ToolName = 'ollama' | 'openrouter-free' | 'openrouter-pool' | 'mock'
const TOOLS: ToolName[] = ['ollama', 'openrouter-free', 'openrouter-pool', 'mock']

interface GateLike {
  invoke(
    env: { item: Record<string, unknown>; meta: Record<string, unknown> },
    ctx: ToolContext,
  ): Promise<{ item: unknown }>
}

interface GateReply {
  content: string
  promptTokens: number
  completionTokens: number
}

export interface ParagraphResult extends ScoreResult {
  index: number
  latencyMs: number
  promptTokens: number
  completionTokens: number
  output: string
  error?: string
}

export interface RunResult {
  run: number
  paragraphs: ParagraphResult[]
}

export interface ModelSummary {
  model: string
  score: number
  parity: number
  glossary: number
  cyrillic: number
  failRate: number
  avgLatencyMs: number
  tokensPerSec: number
  totalTokens: number
  errors: number
  runs: RunResult[]
}

export function buildSystemPrompt(glossary: Record<string, string>): string {
  const gl = Object.entries(glossary)
    .map(([en, ru]) => `${en} = ${ru}`)
    .join('\n')
  return [
    'You are a professional literary translator. Translate the user text from English to Russian.',
    'Rules:',
    '- Keep exactly one output line per input line; do not add or drop lines.',
    '- Output only the translation: no notes, no quotes around it, no explanations.',
    '- Use this glossary for names and terms (translate exactly as given):',
    gl,
  ].join('\n')
}

/** Drop reasoning blocks some models emit. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function mockTranslate(en: string, glossary: Record<string, string>, model: string): string {
  if (model.includes('echo')) return en
  let out = en
  for (const [term, ru] of Object.entries(glossary)) out = out.split(term).join(ru)
  // crude fake: keep non-glossary words out, add cyrillic filler
  return model.includes('bad') ? 'Перевод.' : `${out.replace(/[A-Za-z]+/g, '').trim()} Перевод.`
}

function pickGate(tool: ToolName, fixture: Fixture): GateLike {
  switch (tool) {
    case 'ollama':
      return ollamaTool as unknown as GateLike
    case 'openrouter-free':
      return openrouterFree as unknown as GateLike
    case 'openrouter-pool':
      return openrouterPool as unknown as GateLike
    case 'mock':
      return ollamaTool.with({
        call: mockLlmCall((req) => {
          const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
          return mockTranslate(user, fixture.glossary, req.model)
        }),
      }) as unknown as GateLike
  }
}

async function translate(
  gate: GateLike,
  model: string,
  system: string,
  text: string,
): Promise<GateReply> {
  const out = await gate.invoke(
    {
      item: { model, systemPrompt: system, prompt: text, temperature: 0.2, maxTokens: 2048 },
      meta: {},
    },
    {} as ToolContext,
  )
  return out.item as GateReply
}

export async function benchModel(
  gate: GateLike,
  model: string,
  runs: number,
  fixture: Fixture,
  log: (s: string) => void = () => {},
): Promise<ModelSummary> {
  const system = buildSystemPrompt(fixture.glossary)
  const runResults: RunResult[] = []
  for (let run = 1; run <= runs; run++) {
    const paragraphs: ParagraphResult[] = []
    for (const [index, en] of fixture.paragraphs.entries()) {
      const t0 = Date.now()
      try {
        const reply = await translate(gate, model, system, en)
        const latencyMs = Date.now() - t0
        const output = stripThinking(reply.content)
        const sc = scoreTranslation({ en, ru: output, glossary: fixture.glossary })
        paragraphs.push({
          index,
          latencyMs,
          promptTokens: reply.promptTokens,
          completionTokens: reply.completionTokens,
          output,
          ...sc,
        })
      } catch (err) {
        paragraphs.push({
          index,
          latencyMs: Date.now() - t0,
          promptTokens: 0,
          completionTokens: 0,
          output: '',
          parity: 0,
          glossary: 0,
          cyrillic: 0,
          failed: true,
          score: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      const last = paragraphs[paragraphs.length - 1] as ParagraphResult
      log(
        `  ${model} run ${run} p${index + 1}: score ${last.score.toFixed(2)} ${last.latencyMs}ms${
          last.error ? ` ERROR ${last.error.slice(0, 80)}` : ''
        }`,
      )
    }
    runResults.push({ run, paragraphs })
  }
  const all = runResults.flatMap((r) => r.paragraphs)
  const totalMs = all.reduce((a, p) => a + p.latencyMs, 0)
  const compTokens = all.reduce((a, p) => a + p.completionTokens, 0)
  return {
    model,
    score: mean(all.map((p) => p.score)),
    parity: mean(all.map((p) => p.parity)),
    glossary: mean(all.map((p) => p.glossary)),
    cyrillic: mean(all.map((p) => p.cyrillic)),
    failRate: all.length === 0 ? 0 : all.filter((p) => p.failed).length / all.length,
    avgLatencyMs: mean(all.map((p) => p.latencyMs)),
    tokensPerSec: totalMs === 0 ? 0 : compTokens / (totalMs / 1000),
    totalTokens: all.reduce((a, p) => a + p.promptTokens + p.completionTokens, 0),
    errors: all.filter((p) => p.error).length,
    runs: runResults,
  }
}

export function renderReport(tool: string, summaries: ModelSummary[], runs: number): string {
  const ranked = [...summaries].sort((a, b) => b.score - a.score)
  const rows = ranked.map(
    (s, i) =>
      `| ${i + 1} | ${s.model} | ${s.score.toFixed(3)} | ${s.parity.toFixed(2)} | ${s.glossary.toFixed(2)} | ${s.cyrillic.toFixed(2)} | ${(s.failRate * 100).toFixed(0)}% | ${s.avgLatencyMs.toFixed(0)} | ${s.tokensPerSec.toFixed(1)} | ${s.totalTokens} | ${s.errors} |`,
  )
  return [
    `# Model bench (${tool}, ${runs} run(s))`,
    '',
    '| # | model | score | parity | glossary | cyrillic | fail | avg ms/par | tok/s | tokens | errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    ranked[0]
      ? `Best: **${ranked[0].model}** (score ${ranked[0].score.toFixed(3)})`
      : 'No results.',
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tool: { type: 'string', default: 'ollama' },
      models: { type: 'string' },
      runs: { type: 'string', default: '1' },
      out: { type: 'string', default: 'results/' },
    },
  })
  const tool = values.tool as ToolName
  if (!TOOLS.includes(tool)) throw new Error(`--tool must be one of ${TOOLS.join('|')}`)
  const models = (values.models ?? (tool === 'mock' ? 'mock-good,mock-bad,mock-echo' : ''))
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
  if (models.length === 0) throw new Error('--models a,b,c required')
  const runs = Math.max(1, Number.parseInt(values.runs ?? '1', 10) || 1)
  const out = values.out ?? 'results/'

  if (tool === 'ollama') {
    const url = process.env.MT_OLLAMA_URL ?? OLLAMA_BASE_URL
    const h = await ollamaHealth(url)
    if (!h.ok) {
      console.error(`ollama unreachable at ${h.baseUrl}: ${h.error}`)
      process.exit(2)
    }
    console.log(`ollama ${h.version ?? '?'} at ${h.baseUrl}`)
  }

  const gate = pickGate(tool, FIXTURE)
  const summaries: ModelSummary[] = []
  for (const model of models) {
    console.log(`model ${model}`)
    summaries.push(await benchModel(gate, model, runs, FIXTURE, console.log))
  }

  await mkdir(out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const report = renderReport(tool, summaries, runs)
  await writeFile(
    join(out, `${stamp}.json`),
    JSON.stringify({ tool, runs, models, at: new Date().toISOString(), summaries }, null, 2),
  )
  await writeFile(join(out, 'report.md'), report)
  console.log(`\n${report}\nwritten: ${join(out, `${stamp}.json`)}, ${join(out, 'report.md')}`)
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('bench.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
