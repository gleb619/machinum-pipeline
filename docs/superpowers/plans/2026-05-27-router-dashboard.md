# Router Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Vue 3 + Tailwind SPA dashboard to `@mt/router` showing live cost, usage, pool health, and request logs.

**Architecture:** Nitro serves `public/` as static assets at root (`/`). Two new API routes (`/api/logs`, `/api/pool`) expose log data and pool status. A single-file Vue 3 SPA (`public/app.js`) loads via CDN imports and auto-refreshes every 30s.

**Tech Stack:** Nitro (h3), Vue 3 CDN (esm-browser), Tailwind CDN, TypeScript (server), plain ES modules (client)

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `packages/tools/src/openrouter-pool.ts` | Add `statusCounts()` public method |
| Modify | `packages/router/tests/routes.arch.test.ts` | Add arch tests for logs + pool routes |
| Create | `packages/router/server/routes/api/logs.ts` | `GET /api/logs?date=&limit=` handler |
| Create | `packages/router/server/routes/api/pool.ts` | `GET /api/pool` handler |
| Create | `packages/router/public/index.html` | App shell, CDN script tags, dark bg |
| Create | `packages/router/public/app.js` | Vue 3 SPA — composables + components |

---

### Task 1: Add `statusCounts()` to OpenRouterPool

**Files:**
- Modify: `packages/tools/src/openrouter-pool.ts` (after `totalSize()`, ~line 94)

- [ ] **Step 1: Add the method**

Insert after `totalSize()`:

```typescript
  /** Breakdown of client states */
  statusCounts(): { total: number; available: number; rateLimited: number; disabled: number } {
    const now = Date.now()
    let available = 0
    let rateLimited = 0
    let disabled = 0
    for (const c of this.clients) {
      if (c.disabled) {
        disabled++
      } else if (c.blockedUntil && c.blockedUntil > now) {
        rateLimited++
      } else {
        available++
      }
    }
    return { total: this.clients.length, available, rateLimited, disabled }
  }
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter=@mt/tools typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/tools/src/openrouter-pool.ts
git commit -m "feat(tools): add statusCounts() to OpenRouterPool"
```

---

### Task 2: Arch tests for new routes

**Files:**
- Modify: `packages/router/tests/routes.arch.test.ts`

- [ ] **Step 1: Add tests for logs and pool routes**

Append inside the `describe` block before the closing `})`:

```typescript
  it('logs route exists', async () => {
    expect(await fileExists('../server/routes/api/logs.ts')).toBe(true)
  })

  it('pool route exists', async () => {
    expect(await fileExists('../server/routes/api/pool.ts')).toBe(true)
  })

  it('logs route exports default handler', async () => {
    const content = await readFile(
      join(__dirname, '../server/routes/api/logs.ts'),
      'utf-8',
    )
    expect(content).toContain('export default')
    expect(content).toContain('defineEventHandler')
  })

  it('pool route exports default handler', async () => {
    const content = await readFile(
      join(__dirname, '../server/routes/api/pool.ts'),
      'utf-8',
    )
    expect(content).toContain('export default')
    expect(content).toContain('defineEventHandler')
  })
```

- [ ] **Step 2: Run tests to confirm they fail (files don't exist yet)**

```bash
pnpm --filter=@mt/router test
```

Expected: the 4 new tests FAIL with "file not found" / false assertion.

- [ ] **Step 3: Commit failing tests**

```bash
git add packages/router/tests/routes.arch.test.ts
git commit -m "test(router): add arch tests for logs and pool routes"
```

---

### Task 3: Create `GET /api/logs` route

**Files:**
- Create: `packages/router/server/routes/api/logs.ts`

- [ ] **Step 1: Create the handler**

```typescript
import { defineEventHandler, getQuery } from 'h3'
import { getDailyCost, getLogPath, type LogEntry } from '../../utils/cost-tracker.js'
import { readFile } from 'node:fs/promises'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const date = typeof query.date === 'string'
    ? query.date
    : new Date().toISOString().split('T')[0] as string
  const limit = Math.min(Number.parseInt(String(query.limit ?? '50'), 10) || 50, 200)

  const entries: LogEntry[] = []

  try {
    const content = await readFile(getLogPath(date), 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as LogEntry)
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // log file absent — return empty
  }

  entries.reverse()

  return { entries: entries.slice(0, limit) }
})
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter=@mt/router test
```

Expected: "logs route exists" and "logs route exports default handler" now PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/router/server/routes/api/logs.ts
git commit -m "feat(router): add GET /api/logs endpoint"
```

---

### Task 4: Create `GET /api/pool` route

**Files:**
- Create: `packages/router/server/routes/api/pool.ts`

- [ ] **Step 1: Create the handler**

```typescript
import { defineEventHandler } from 'h3'
import { isMockMode } from '../../plugins/mock-mode.js'
import { poolSupplier } from '../../utils/openrouter-pool-supplier.js'

export default defineEventHandler(() => {
  const pool = poolSupplier.getPool()
  const counts = pool.statusCounts()

  return {
    mockMode: isMockMode(),
    totalKeys: counts.total,
    activeKeys: counts.available,
    rateLimitedKeys: counts.rateLimited,
    blockedKeys: counts.disabled,
  }
})
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter=@mt/router test
```

Expected: all 4 new arch tests PASS. Full suite green.

- [ ] **Step 3: Commit**

```bash
git add packages/router/server/routes/api/pool.ts
git commit -m "feat(router): add GET /api/pool endpoint"
```

---

### Task 5: Create `public/index.html`

**Files:**
- Create: `packages/router/public/index.html`

- [ ] **Step 1: Create the HTML shell**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MT Router Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'monospace'] }
        }
      }
    }
  </script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen antialiased">
  <div id="app" class="min-h-screen"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Verify Nitro will serve it**

Start the dev server and confirm `http://localhost:7777/` returns HTML (blank Vue mount point is fine at this stage):

```bash
pnpm --filter=@mt/router dev &
sleep 4
curl -s http://localhost:7777/ | grep -c 'MT Router Dashboard'
```

Expected: `1`

Stop the dev server after confirming: `kill %1`

- [ ] **Step 3: Commit**

```bash
git add packages/router/public/index.html
git commit -m "feat(router): add dashboard HTML shell"
```

---

### Task 6: Create `public/app.js` — Vue 3 SPA

**Files:**
- Create: `packages/router/public/app.js`

- [ ] **Step 1: Create the full SPA**

```javascript
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
    pct() { return this.limit > 0 ? Math.min(100, (this.used / this.limit) * 100) : 0 },
    color() {
      if (this.pct < 50) return 'bg-emerald-500'
      if (this.pct < 80) return 'bg-amber-400'
      return 'bg-red-500'
    },
    remaining() { return Math.max(0, this.limit - this.used) }
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
            <tr v-for="(e, i) in entries" :key="i" class="border-t border-slate-700 hover:bg-slate-750">
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

    return { dash, pool, logs, lastRefresh, refreshAll, mockMode, fmtCost, fmtTime }
  },

  methods: { fmtCost },

  template: `
    <div class="max-w-6xl mx-auto px-4 py-6 space-y-6">

      <!-- Header -->
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

      <!-- Error banner -->
      <div v-if="dash.error.value || pool.error.value || logs.error.value"
           class="bg-red-900/50 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-2">
        {{ dash.error.value || pool.error.value || logs.error.value }}
      </div>

      <!-- Summary cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Today calls" :value="dash.data.value?.today?.calls" />
        <SummaryCard label="Today cost" :value="fmtCost(dash.data.value?.today?.totalCost)" />
        <SummaryCard label="Monthly cost" :value="fmtCost(dash.data.value?.month?.totalCost)" :sub="dash.data.value?.month?.calls + ' calls'" />
        <SummaryCard label="Budget left" :value="fmtCost(dash.data.value?.budgetRemaining)" :sub="'of ' + fmtCost(dash.data.value?.budgetLimit)" />
      </div>

      <!-- Budget gauge -->
      <BudgetGauge
        :used="dash.data.value ? (dash.data.value.budgetLimit - dash.data.value.budgetRemaining) : 0"
        :limit="dash.data.value?.budgetLimit ?? 5" />

      <!-- Pool status -->
      <PoolStatus :pool="pool.data.value" />

      <!-- Model breakdown -->
      <ModelTable :models="dash.data.value?.today?.models" />

      <!-- Logs -->
      <LogsTable :entries="logs.data.value" />

    </div>
  `
}

createApp(App).mount('#app')
```

- [ ] **Step 2: Start dev server and open dashboard**

```bash
pnpm --filter=@mt/router dev
```

Open `http://localhost:7777/` in browser. Verify:
- Dark slate background
- 4 summary cards visible (may show `—` if no log data)
- Budget gauge bar renders
- Pool status row visible
- Model table shows "No data yet" or real data
- Logs table shows "No logs yet" or entries

- [ ] **Step 3: Commit**

```bash
git add packages/router/public/app.js
git commit -m "feat(router): add Vue 3 dashboard SPA"
```

---

### Task 7: Playwright smoke tests

**Files:**
- Create: `packages/router/tests/dashboard.playwright.test.ts`

Note: this test requires the router dev server running at `http://localhost:7777`. Run server first: `pnpm --filter=@mt/router dev`

- [ ] **Step 1: Install playwright if not present**

```bash
pnpm --filter=@mt/router add -D @playwright/test
npx --prefix packages/router playwright install chromium
```

- [ ] **Step 2: Create the test**

```typescript
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:7777'

test('dashboard loads and shows main sections', async ({ page }) => {
  await page.goto(BASE)

  // Page title
  await expect(page).toHaveTitle('MT Router Dashboard')

  // 4 summary cards: labels
  await expect(page.getByText('Today calls')).toBeVisible()
  await expect(page.getByText('Today cost')).toBeVisible()
  await expect(page.getByText('Monthly cost')).toBeVisible()
  await expect(page.getByText('Budget left')).toBeVisible()
})

test('pool status section is visible', async ({ page }) => {
  await page.goto(BASE)
  await expect(page.getByText('Pool')).toBeVisible()
  // pool section contains "active"
  await expect(page.locator('text=active')).toBeVisible()
})

test('budget gauge renders', async ({ page }) => {
  await page.goto(BASE)
  await expect(page.getByText('Daily Budget')).toBeVisible()
})

test('model breakdown section renders', async ({ page }) => {
  await page.goto(BASE)
  await expect(page.getByText('Model Breakdown')).toBeVisible()
})

test('logs section renders', async ({ page }) => {
  await page.goto(BASE)
  await expect(page.getByText('Recent Requests')).toBeVisible()
})

test('/api/pool returns expected shape', async ({ request }) => {
  const r = await request.get(`${BASE}/api/pool`)
  expect(r.ok()).toBe(true)
  const json = await r.json()
  expect(json).toHaveProperty('mockMode')
  expect(json).toHaveProperty('totalKeys')
  expect(json).toHaveProperty('activeKeys')
  expect(json).toHaveProperty('rateLimitedKeys')
  expect(json).toHaveProperty('blockedKeys')
})

test('/api/logs returns expected shape', async ({ request }) => {
  const r = await request.get(`${BASE}/api/logs`)
  expect(r.ok()).toBe(true)
  const json = await r.json()
  expect(json).toHaveProperty('entries')
  expect(Array.isArray(json.entries)).toBe(true)
})
```

- [ ] **Step 3: Add playwright config**

Create `packages/router/playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testMatch: '**/*.playwright.test.ts',
  use: {
    baseURL: 'http://localhost:7777',
  },
  // no webServer — requires dev server already running
})
```

- [ ] **Step 4: Run the tests (with dev server running)**

```bash
pnpm --filter=@mt/router exec playwright test
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router/tests/dashboard.playwright.test.ts packages/router/playwright.config.ts
git commit -m "test(router): playwright smoke tests for dashboard"
```
