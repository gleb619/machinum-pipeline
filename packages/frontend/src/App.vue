<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface PipelineInfo {
  path: string
  declared: string
}

interface RunInfo {
  id: string
  state: string
  started?: string
}

const pipelines = ref<PipelineInfo[]>([])
const runs = ref<RunInfo[]>([])
const activeTab = ref<'pipelines' | 'runs'>('pipelines')
const loading = ref(true)
const error = ref<string | null>(null)
const toast = ref<string | null>(null)

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

function clearToast() {
  toast.value = null
}

function stateColor(state: string): string {
  switch (state) {
    case 'running': return 'text-green-400'
    case 'paused': return 'text-yellow-400'
    case 'done': return 'text-blue-400'
    case 'failed': return 'text-red-400'
    default: return 'text-gray-500'
  }
}

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
  </div>
</template>
