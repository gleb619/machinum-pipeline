# T223 — Integration plugins/exporters (Prometheus/Grafana, Sentry, OpenTelemetry, Langfuse)

## Goal

A plugin layer on top of the metrics subsystem (`packages/core/src/metrics.ts`,
`MetricsEvent`) and `wrap.ts` stage hook payloads (`StageHookEvent` / `StageResultEvent`)
that forwards pipeline/tool/stage telemetry to external systems — WITHOUT coupling
`@mt/core` to any vendor SDK.

## Core structure (must exist before any exporter)

- `MetricsSink` interface in @mt/core: `name`, `open()`, `accept(event)`, `close()`.
  `BufferedMetricsRecorder` fans out each recorded `MetricsEvent` to all registered sinks.
- Sink registration: programmatic (`registerMetricsSink(sink)`) + `MT_METRICS_SINKS`
  env / mt.json key for built-ins. Unknown sink name → warn, continue.
- Sinks must never throw into the run: errors are warn-logged and the sink is
  auto-disabled for the rest of the run (circuit breaker, ~3 strikes).
- `wrap.ts` chains should be able to feed the same sink bus (stage events →
  `MetricsEvent`-shaped conversion at the sink boundary, not inside wrap.ts).

## Exporters (each its own package or `packages/integrations/*`, zero deps in core)

1. **Prometheus/Grafana** — HTTP `/metrics` endpoint (pull) or pushgateway (push);
   histograms for stage/tool durations, counters for outcomes. Pull mode needs a
   listener (reuse `http-listener.ts` pattern).
2. **OpenTelemetry** — OTLP exporter translating `MetricsEvent` → OTel metrics;
   optionally traces for pipeline runs (run = trace, tool/stage = span).
   OTel covers Prometheus as backend too — decide whether Prom sink is a thin OTLP
   config or standalone text-format endpoint.
3. **Sentry** — run failure + stage error events (`StageError` attribution gives
   stage path/message); breadcrumbs for tool steps.
4. **Langfuse** — LLM-call observability: map tool invocations with LLM usage
   (tokens/cost from router logs?) to Langfuse traces/generations.

## Also consider

- **Grafana Loki / structured log shipping** (run.log JSONL already on disk — a
  tailer sink is trivial).
- **LangSmith / Braintrust / Helicone** (OTel-compatible — may come free via OTel sink).
- **Dead-letter + metrics correlation** in webui (SQLite mirror already exists).

## Constraints

- Core stays SDK-free; each exporter is an optional package. Import layers rule
  (steering/structure.md): integrations may depend on `core/`, never reverse.
- `MT_METRICS=false` disables the whole bus including sinks.
- No new CLI commands needed for v1; sink config via env/mt.json.

## Steps

1. Add `MetricsSink` interface + fan-out in `BufferedMetricsRecorder`; registration
   API + `MT_METRICS_SINKS` env/mt.json parsing; circuit-breaker error handling; tests.
2. Decide pull vs push for Prometheus; implement `/metrics` text-format sink; verify
   with `promtool check` or a real scrape.
3. OTel sink behind an optional peer dep; map run→trace, tool/stage→span.
4. Sentry sink: run failures + `StageError` events with stage attribution.
5. Langfuse sink: LLM usage mapping from tool invocations.
6. Steering docs + env table updates.

## Time

Planned: 16h

## Done when

- `MetricsSink` bus + registration merged with tests.
- At least the Prometheus sink implemented end-to-end and verified against a real
  Prometheus scrape (or promtool check).
- Steering docs updated (core.md metrics section, tech.md env table, structure.md
  new packages note).

<!-- provenance: row=T223 -->
