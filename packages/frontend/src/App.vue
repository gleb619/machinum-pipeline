<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface PipelineInfo {
  path: string
  declared: string
}

const pipelines = ref<PipelineInfo[]>([])
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
  } catch (err) {
    toast.value = `Error: ${err instanceof Error ? err.message : 'Unknown'}`
  }
}

function clearToast() {
  toast.value = null
}

onMounted(fetchPipelines)
</script>

<template>
  <div class="max-w-4xl mx-auto px-4 py-8">
    <header class="mb-8">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold tracking-tight">Mt — Pipeline Admin</h1>
        <nav class="flex gap-4 text-sm">
          <a href="/api/runs" class="text-blue-400 hover:text-blue-300 transition-colors">Runs</a>
          <a href="/api/health" class="text-blue-400 hover:text-blue-300 transition-colors">Health</a>
        </nav>
      </div>
      <p class="mt-1 text-sm text-gray-500">Registered pipelines from mt.json</p>
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

    <!-- Loading -->
    <div v-if="loading" class="text-gray-500 text-sm animate-pulse">Loading pipelines...</div>

    <!-- Error -->
    <div v-else-if="error" class="rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-400">
      {{ error }}
      <button class="ml-4 underline hover:text-red-300" @click="fetchPipelines">Retry</button>
    </div>

    <!-- Empty -->
    <div v-else-if="pipelines.length === 0" class="text-gray-600 text-sm">
      No pipelines registered. Add paths to <code class="font-mono text-gray-500">mt.json</code> → <code class="font-mono text-gray-500">pipelines</code>.
    </div>

    <!-- Pipeline List -->
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
        >
          &#9654; Run
        </button>
      </li>
    </ul>
  </div>
</template>
