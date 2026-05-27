import { createApp, ref, computed, onMounted, onUnmounted } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js'

// ── composables ──────────────────────────────────────────────────

function useDashboard() {
  const data = ref(null)
  const error = ref(null)
  async function refresh() {
    try {
      const r = await fetch('/api/dashboard')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      data.value = await r.json()
      error.value = null
    } catch (e) {
      error.value = e.message
    }
  }
  return { data, error, refresh }
}

function usePool() {
  const data = ref(null)
  const error = ref(null)
  async function refresh() {
    try {
      const r = await fetch('/api/pool')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      data.value = await r.json()
      error.value = null
    } catch (e) {
      error.value = e.message
    }
  }
  return { data, error, refresh }
}

function useLogs() {
  const data = ref([])
  const error = ref(null)
  async function refresh() {
    try {
      const r = await fetch('/api/logs?limit=50')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = await r.json()
      data.value = json.entries ?? []
      error.value = null
    } catch (e) {
      error.value = e.message
    }
  }
  return { data, error, refresh }
}

// ── helpers ──────────────────────────────────────────────────────

function fmtCost(v) {
  return v == null ? '—' : `$${Number(v).toFixed(4)}`
}

function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function truncate(s, n = 8) {
  if (!s) return '—'
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ── components ───────────────────────────────────────────────────

const SummaryCard = {
  props: ['label', 'value', 'sub'],
  template: `
    <div class="bg-slate-800 rounded-xl p-4 flex flex-col gap-1 min-w-[130px]">
      <span class="text-slate-400 text-xs uppercase tracking-wide">{{ label }}</span>
      <span class="text-2xl font-bold text-white">{{ value ?? '—' }}</span>
      <span v-if="sub" class="text-slate-500 text-xs">{{ sub }}</span>
    </div>
  `
}

const BudgetGauge = {
  props: ['used', 'limit'],
  computed: {
    pct() {
      if (!this.limit || this.limit <= 0) return 0
      return Math.min(100, (this.used / this.limit) * 100)
    },
    color() {
      if (this.pct < 50) return 'bg-emerald-500'
      if (this.pct < 80) return 'bg-amber-400'
      return 'bg-red-500'
    },
    remaining() { return Math.max(0, (this.limit ?? 0) - (this.used ?? 0)) }
  },
  template: `
    <div class="bg-slate-800 rounded-xl p-4 flex flex-col gap-2">
      <div class="flex justify-between items-center">
        <span class="text-slate-400 text-xs uppercase tracking-wide">Daily Budget</span>
        <span class="text-slate-300 text-sm font-mono">{{ fmtCost(remaining) }} left / {{ fmtCost(limit) }}</span>
      </div>
      <div class="w-full bg-slate-700 rounded-full h-3">
        <div :class="[color, 'h-3 rounded-full transition-all duration-500']" :style="{ width: pct + '%' }"></div>
      </div>
    </div>
  `,
  methods: { fmtCost }
}

const PoolStatus = {
  props: ['pool'],
  computed: {
    dot() {
      if (!this.pool) return 'bg-slate-600'
      if (this.pool.activeKeys === 0) return 'bg-red-500'
      if (this.pool.rateLimitedKeys > 0 || this.pool.blockedKeys > 0) return 'bg-amber-400'
      return 'bg-emerald-500'
    }
  },
  template: `
    <div class="bg-slate-800 rounded-xl p-4 flex items-center gap-4 flex-wrap">
      <span class="text-slate-400 text-xs uppercase tracking-wide">Pool</span>
      <span class="flex items-center gap-1.5">
        <span :class="[dot, 'w-2.5 h-2.5 rounded-full inline-block']"></span>
        <span class="text-sm text-slate-200">{{ pool?.activeKeys ?? '—' }} active</span>
      </span>
      <span class="text-sm text-amber-400" v-if="pool?.rateLimitedKeys">{{ pool.rateLimitedKeys }} rate-limited</span>
      <span class="text-sm text-red-400" v-if="pool?.blockedKeys">{{ pool.blockedKeys }} blocked</span>
      <span class="text-sm text-slate-500">{{ pool?.totalKeys ?? '—' }} total keys</span>
    </div>
  `
}

const ModelTable = {
  props: ['models'],
  template: `
    <div class="bg-slate-800 rounded-xl p-4">
      <h3 class="text-slate-400 text-xs uppercase tracking-wide mb-3">Model Breakdown (today)</h3>
      <div v-if="!models || !Object.keys(models).length" class="text-slate-500 text-sm">No data yet</div>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 text-xs">
            <th class="pb-2 font-normal">Model</th>
            <th class="pb-2 font-normal text-right">Calls</th>
            <th class="pb-2 font-normal text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(stats, model) in models" :key="model" class="border-t border-slate-700">
            <td class="py-1.5 font-mono text-xs text-slate-300">{{ model }}</td>
            <td class="py-1.5 text-right text-slate-300">{{ stats.calls }}</td>
            <td class="py-1.5 text-right font-mono text-slate-300">{{ fmtCost(stats.cost) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
  methods: { fmtCost }
}

const LogsTable = {
  props: ['entries'],
  template: `
    <div class="bg-slate-800 rounded-xl p-4">
      <h3 class="text-slate-400 text-xs uppercase tracking-wide mb-3">Recent Requests</h3>
      <div v-if="!entries?.length" class="text-slate-500 text-sm">No logs yet</div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-left text-slate-500">
              <th class="pb-2 font-normal pr-4">Time</th>
              <th class="pb-2 font-normal pr-4">Model</th>
              <th class="pb-2 font-normal pr-4">Run</th>
              <th class="pb-2 font-normal pr-4">Step</th>
              <th class="pb-2 font-normal text-right pr-4">Prompt</th>
              <th class="pb-2 font-normal text-right pr-4">Compl</th>
              <th class="pb-2 font-normal text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(e, i) in entries" :key="i" class="border-t border-slate-700 hover:bg-slate-700/50">
              <td class="py-1 pr-4 text-slate-400">{{ fmtTime(e.timestamp) }}</td>
              <td class="py-1 pr-4 text-slate-300">{{ e.model }}</td>
              <td class="py-1 pr-4 text-slate-500" :title="e.runId">{{ truncate(e.runId) }}</td>
              <td class="py-1 pr-4 text-slate-500" :title="e.stepId">{{ truncate(e.stepId) }}</td>
              <td class="py-1 pr-4 text-right text-slate-400">{{ e.promptTokens }}</td>
              <td class="py-1 pr-4 text-right text-slate-400">{{ e.completionTokens }}</td>
              <td class="py-1 text-right text-slate-300">{{ fmtCost(e.cost) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `,
  methods: { fmtCost, fmtTime, truncate }
}

// ── root app ─────────────────────────────────────────────────────

const App = {
  components: { SummaryCard, BudgetGauge, PoolStatus, ModelTable, LogsTable },

  setup() {
    const dash = useDashboard()
    const pool = usePool()
    const logs = useLogs()
    const lastRefresh = ref(null)

    async function refreshAll() {
      await Promise.all([dash.refresh(), pool.refresh(), logs.refresh()])
      lastRefresh.value = new Date().toLocaleTimeString()
    }

    let timer = null
    onMounted(async () => {
      await refreshAll()
      timer = setInterval(refreshAll, 30_000)
    })
    onUnmounted(() => clearInterval(timer))

    const mockMode = computed(() => pool.data.value?.mockMode ?? false)

    return { dash, pool, logs, lastRefresh, refreshAll, mockMode, fmtCost }
  },

  template: `
    <div class="max-w-6xl mx-auto px-4 py-6 space-y-6">

      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h1 class="text-xl font-bold text-white tracking-tight">MT Router</h1>
          <span v-if="mockMode" class="bg-orange-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full">MOCK</span>
        </div>
        <div class="flex items-center gap-3 text-slate-500 text-xs">
          <span v-if="lastRefresh">↻ {{ lastRefresh }}</span>
          <button @click="refreshAll" class="text-slate-400 hover:text-white transition-colors text-sm px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Refresh</button>
        </div>
      </div>

      <div v-if="dash.error.value || pool.error.value || logs.error.value"
           class="bg-red-900/50 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-2">
        {{ dash.error.value || pool.error.value || logs.error.value }}
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Today calls" :value="dash.data.value?.today?.calls" />
        <SummaryCard label="Today cost" :value="fmtCost(dash.data.value?.today?.totalCost)" />
        <SummaryCard label="Monthly cost" :value="fmtCost(dash.data.value?.month?.totalCost)" :sub="(dash.data.value?.month?.calls ?? 0) + ' calls'" />
        <SummaryCard label="Budget left" :value="fmtCost(dash.data.value?.budgetRemaining)" :sub="'of ' + fmtCost(dash.data.value?.budgetLimit)" />
      </div>

      <BudgetGauge
        :used="dash.data.value ? (dash.data.value.budgetLimit - dash.data.value.budgetRemaining) : 0"
        :limit="dash.data.value?.budgetLimit ?? 5" />

      <PoolStatus :pool="pool.data.value" />

      <ModelTable :models="dash.data.value?.today?.models" />

      <LogsTable :entries="logs.data.value" />

    </div>
  `
}

createApp(App).mount('#app')
