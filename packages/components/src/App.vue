<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

interface PipelineInfo {
  path: string
  declared: string
}

interface RunInfo {
  id: string
  state: string
  started?: string
}

interface RouterDashboard {
  today: { calls: number; totalCost: number }
  month: { calls: number; totalCost: number }
  budgetRemaining: number
  budgetLimit: number
  clientBudgetLimit: number | null
}

interface RouterPool {
  mockMode: boolean
  totalKeys: number
  activeKeys: number
  rateLimitedKeys: number
  blockedKeys: number
  upstreams: Array<{
    name: string
    kind: string
    keyless: boolean
    total: number
    available: number
    rateLimited: number
    disabled: number
  }>
}

interface RouterLog {
  timestamp: string
  model: string
  promptTokens: number
  completionTokens: number
  cost: number
  client?: string
}

type Tab = 'pipelines' | 'runs' | 'router'

const ROUTER_TOKEN_KEY = 'mt-router-token'

const pipelines = ref<PipelineInfo[]>([])
const runs = ref<RunInfo[]>([])
const activeTab = ref<Tab>('pipelines')
const loading = ref(true)
const error = ref<string | null>(null)
const toast = ref<string | null>(null)
const routerToken = ref(readRouterToken())
const routerLoading = ref(false)
const routerError = ref<string | null>(null)
const dashboard = ref<RouterDashboard | null>(null)
const pool = ref<RouterPool | null>(null)
const routerLogs = ref<RouterLog[]>([])

function readRouterToken(): string {
  try {
    return sessionStorage.getItem(ROUTER_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function persistRouterToken(): void {
  try {
    const token = routerToken.value.trim()
    if (token) sessionStorage.setItem(ROUTER_TOKEN_KEY, token)
    else sessionStorage.removeItem(ROUTER_TOKEN_KEY)
  } catch {
    // Private mode / disabled storage: the in-memory ref still works for this tab.
  }
}

async function routerFetch(path: string): Promise<Response> {
  const headers: Record<string, string> = {}
  const token = routerToken.value.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(path, { headers })
}

async function fetchPipelines() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/pipelines')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    pipelines.value = await res.json()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load pipelines'
  } finally {
    loading.value = false
  }
}

async function fetchRuns() {
  try {
    const res = await fetch('/api/runs')
    if (res.ok) runs.value = await res.json()
  } catch {
    // runs may not be available
  }
}

async function fetchRouterPanel() {
  routerLoading.value = true
  routerError.value = null
  try {
    const responses = await Promise.all([
      routerFetch('/api/dashboard'),
      routerFetch('/api/pool'),
      routerFetch('/api/logs?limit=20'),
    ])
    if (responses.some((res) => res.status === 401)) {
      throw new Error('Router token required or invalid')
    }
    const [dashRes, poolRes, logsRes] = responses
    if (!dashRes?.ok || !poolRes?.ok || !logsRes?.ok) {
      throw new Error(`HTTP ${dashRes?.status ?? poolRes?.status ?? logsRes?.status ?? 'error'}`)
    }
    dashboard.value = (await dashRes.json()) as RouterDashboard
    pool.value = (await poolRes.json()) as RouterPool
    const logs = (await logsRes.json()) as { entries: RouterLog[] }
    routerLogs.value = logs.entries
  } catch (err) {
    routerError.value = err instanceof Error ? err.message : 'Failed to load router status'
  } finally {
    routerLoading.value = false
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
async function startRun(declared: string) {
  toast.value = null
  try {
    const res = await fetch('/api/runs/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline: declared }),
    })
    if (!res.ok) {
      const msg = await res.text()
      throw new Error(msg || `HTTP ${res.status}`)
    }
    const data = await res.json()
    toast.value = `Run started: ${data.runId}`
    await fetchRuns()
  } catch (err) {
    toast.value = `Error: ${err instanceof Error ? err.message : 'Unknown'}`
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
async function pauseRun(runId: string) {
  toast.value = null
  try {
    const res = await fetch(`/api/runs/${runId}/pause`, { method: 'POST' })
    if (!res.ok) {
      const msg = await res.text()
      throw new Error(msg || `HTTP ${res.status}`)
    }
    toast.value = `Run ${runId} paused`
    await fetchRuns()
  } catch (err) {
    toast.value = `Error: ${err instanceof Error ? err.message : 'Unknown'}`
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
async function resumeRun(runId: string) {
  toast.value = null
  try {
    const res = await fetch(`/api/runs/${runId}/resume`, { method: 'POST' })
    if (!res.ok) {
      const msg = await res.text()
      throw new Error(msg || `HTTP ${res.status}`)
    }
    toast.value = `Run ${runId} resumed`
    await fetchRuns()
  } catch (err) {
    toast.value = `Error: ${err instanceof Error ? err.message : 'Unknown'}`
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function clearToast() {
  toast.value = null
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function stateColor(state: string): string {
  switch (state) {
    case 'running':
      return 'text-green-400'
    case 'paused':
      return 'text-yellow-400'
    case 'done':
      return 'text-blue-400'
    case 'failed':
      return 'text-red-400'
    default:
      return 'text-gray-500'
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function money(value: number): string {
  return `$${value.toFixed(4)}`
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function clock(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString()
}

watch(activeTab, (tab) => {
  if (tab === 'router') void fetchRouterPanel()
})

onMounted(() => {
  fetchPipelines()
  fetchRuns()
})
</script>

<template>
  <div class="max-w-4xl mx-auto px-4 py-8">
    <header class="mb-8">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold tracking-tight">Mt — Pipeline Admin</h1>
        <nav class="flex gap-4 text-sm">
          <button
            class="transition-colors"
            :class="activeTab === 'pipelines' ? 'text-white font-medium' : 'text-blue-400 hover:text-blue-300'"
            @click="activeTab = 'pipelines'"
          >Pipelines</button>
          <button
            class="transition-colors"
            :class="activeTab === 'runs' ? 'text-white font-medium' : 'text-blue-400 hover:text-blue-300'"
            @click="activeTab = 'runs'"
          >Runs</button>
          <button
            class="transition-colors"
            :class="activeTab === 'router' ? 'text-white font-medium' : 'text-blue-400 hover:text-blue-300'"
            @click="activeTab = 'router'"
          >Router</button>
        </nav>
      </div>
    </header>

    <!-- Toast -->
    <div
      v-if="toast"
      class="mb-6 rounded-lg border px-4 py-3 text-sm flex items-center justify-between"
      :class="toast.startsWith('Error') ? 'border-red-800 bg-red-900/50 text-red-300' : 'border-green-800 bg-green-900/50 text-green-300'"
    >
      <span>{{ toast }}</span>
      <button
        class="ml-4 text-current opacity-60 hover:opacity-100 font-mono text-lg leading-none"
        @click="clearToast"
      >&times;</button>
    </div>

    <!-- Pipelines Tab -->
    <div v-if="activeTab === 'pipelines'">
      <div v-if="loading" class="text-gray-500 text-sm animate-pulse">Loading pipelines...</div>

      <div v-else-if="error" class="rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-400">
        {{ error }}
        <button class="ml-4 underline hover:text-red-300" @click="fetchPipelines">Retry</button>
      </div>

      <div v-else-if="pipelines.length === 0" class="text-gray-600 text-sm">
        No pipelines registered.
      </div>

      <ul v-else class="space-y-2">
        <li
          v-for="pipe in pipelines"
          :key="pipe.declared"
          class="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3 hover:border-gray-700 transition-colors"
        >
          <div class="min-w-0 flex-1">
            <code class="text-sm text-gray-200 font-mono truncate block">{{ pipe.declared }}</code>
            <span class="text-xs text-gray-600 mt-0.5 block truncate">{{ pipe.path }}</span>
          </div>
          <button
            class="ml-4 shrink-0 rounded-md bg-green-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-600 active:bg-green-800 transition-colors"
            @click="startRun(pipe.declared)"
          >&#9654; Run</button>
        </li>
      </ul>
    </div>

    <!-- Runs Tab -->
    <div v-if="activeTab === 'runs'">
      <div v-if="runs.length === 0" class="text-gray-600 text-sm">
        No runs yet. Start one from the <button class="underline text-blue-400 hover:text-blue-300" @click="activeTab = 'pipelines'">Pipelines</button> tab.
      </div>

      <ul v-else class="space-y-2">
        <li
          v-for="run in runs"
          :key="run.id"
          class="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3 hover:border-gray-700 transition-colors"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <code class="text-sm text-gray-200 font-mono truncate">{{ run.id }}</code>
              <span class="text-xs font-medium uppercase" :class="stateColor(run.state)">{{ run.state }}</span>
            </div>
            <span v-if="run.started" class="text-xs text-gray-600 mt-0.5 block">{{ run.started }}</span>
          </div>
          <div class="flex gap-2 ml-4 shrink-0">
            <button
              v-if="run.state === 'running'"
              class="rounded-md bg-yellow-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-600 active:bg-yellow-800 transition-colors"
              @click="pauseRun(run.id)"
            >⏸ Pause</button>
            <button
              v-if="run.state === 'paused'"
              class="rounded-md bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 active:bg-green-800 transition-colors"
              @click="resumeRun(run.id)"
            >▶ Resume</button>
          </div>
        </li>
      </ul>
    </div>

    <!-- Router Tab -->
    <div v-if="activeTab === 'router'">
      <div class="mb-4 rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3">
        <label for="router-token" class="text-xs uppercase tracking-wide text-gray-500">Router token</label>
        <input
          id="router-token"
          v-model="routerToken"
          type="password"
          autocomplete="off"
          placeholder="MT_ROUTER_TOKEN (optional)"
          class="mt-1 block w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-blue-500 focus:outline-none"
          @change="persistRouterToken"
        >
        <p class="mt-1 text-xs text-gray-600">Kept in this tab only; never added to URLs or logs.</p>
      </div>

      <div v-if="routerLoading" class="text-gray-500 text-sm animate-pulse">Loading router status...</div>

      <div v-else-if="routerError" class="rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-400">
        {{ routerError }}
        <button class="ml-4 underline hover:text-red-300" @click="fetchRouterPanel">Retry</button>
      </div>

      <template v-else>
        <div v-if="dashboard" class="grid gap-4 sm:grid-cols-3">
          <section class="rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3">
            <h2 class="text-xs uppercase tracking-wide text-gray-500">Today</h2>
            <p class="mt-1 text-lg font-semibold text-gray-100">{{ money(dashboard.today.totalCost) }}</p>
            <p class="text-xs text-gray-600">{{ dashboard.today.calls }} calls</p>
          </section>
          <section class="rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3">
            <h2 class="text-xs uppercase tracking-wide text-gray-500">Month</h2>
            <p class="mt-1 text-lg font-semibold text-gray-100">{{ money(dashboard.month.totalCost) }}</p>
            <p class="text-xs text-gray-600">{{ dashboard.month.calls }} calls</p>
          </section>
          <section class="rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3">
            <h2 class="text-xs uppercase tracking-wide text-gray-500">Daily budget</h2>
            <p class="mt-1 text-lg font-semibold text-gray-100">{{ money(dashboard.budgetRemaining) }}</p>
            <p class="text-xs text-gray-600">of {{ money(dashboard.budgetLimit) }} left</p>
          </section>
        </div>

        <section v-if="pool" class="mt-6 rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-xs uppercase tracking-wide text-gray-500">Pool</h2>
            <span
              v-if="pool.mockMode"
              class="rounded bg-blue-900 px-2 py-0.5 text-xs font-medium text-blue-300"
            >MOCK</span>
          </div>
          <p class="mt-1 text-sm text-gray-200">
            {{ pool.activeKeys }} / {{ pool.totalKeys }} active
            <span class="text-gray-600">
              · {{ pool.rateLimitedKeys }} rate limited · {{ pool.blockedKeys }} blocked
            </span>
          </p>
          <ul v-if="pool.upstreams.length > 0" class="mt-2 space-y-1 text-xs text-gray-500">
            <li v-for="upstream in pool.upstreams" :key="upstream.name">
              <span class="font-mono text-gray-300">{{ upstream.name }}</span>
              ({{ upstream.kind }}{{ upstream.keyless ? ', keyless' : '' }})
              · {{ upstream.available }} / {{ upstream.total }} active
            </li>
          </ul>
        </section>

        <section class="mt-6">
          <h2 class="mb-2 text-xs uppercase tracking-wide text-gray-500">Recent calls</h2>
          <div v-if="routerLogs.length === 0" class="text-gray-600 text-sm">
            No router calls logged today.
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="(entry, index) in routerLogs"
              :key="`${entry.timestamp}-${index}`"
              class="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-2 text-sm"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <code class="truncate font-mono text-gray-200">{{ entry.model }}</code>
                  <span v-if="entry.client" class="text-xs text-gray-600">{{ entry.client }}</span>
                </div>
                <span class="text-xs text-gray-600">
                  {{ clock(entry.timestamp) }} · {{ entry.promptTokens + entry.completionTokens }} tokens
                </span>
              </div>
              <span class="ml-4 shrink-0 font-mono text-xs text-gray-400">{{ money(entry.cost) }}</span>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>
