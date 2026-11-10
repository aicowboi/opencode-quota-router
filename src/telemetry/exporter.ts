// OpenTelemetry export, the working part: collects what changed since the last export from the local store, queues it,
// and delivers the queue. Nothing here reads a prompt, a response, code, a tool argument or a session title.
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import type { Core } from "../core.ts"
import { describeUrl, logsPayload, metricsPayload, resolveTelemetry, seriesKey, type Attrs, type LogEvent, type Metric, type Resolved } from "./otlp.ts"

type State = { cursorAt?: number; routingId?: number; startAt?: number; lastOk?: number; lastError?: string; sent?: number; dropped?: number }
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null } }>
export type TelemetryDeps = { fetch?: Fetch; env?: Record<string, string | undefined>; gitEmail?: () => Promise<string | undefined>; hostName?: () => string }

/** Queue limits: a collector that is away for long loses the oldest data rather than growing the database. */
const QUEUE_MAX = 500
const QUEUE_MAX_AGE = 24 * 3_600_000
/** After being off, at most this much is caught up in one export. */
const CATCH_UP = 7 * 86_400_000
const RETRYABLE = new Set([429, 502, 503, 504])

const gitEmail = () =>
  new Promise<string | undefined>((resolve) => execFile("git", ["config", "--global", "user.email"], { timeout: 3000 }, (err, out) => resolve(err ? undefined : String(out).trim() || undefined)))

const provider = (model?: string | null) => (model ? model.split("/")[0] : undefined)
const WINDOW: Record<string, string> = { "5-hour session": "5h", "5-hour": "5h", "Weekly (all models)": "weekly", weekly: "weekly" }
const windowName = (label: string) => WINDOW[label] ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")

export class Telemetry {
  private core: Core
  private deps: Required<TelemetryDeps>
  private busy = false
  private email?: { value?: string }
  private state: State

  constructor(core: Core, deps: TelemetryDeps = {}) {
    this.core = core
    this.deps = { fetch: deps.fetch ?? (fetch as unknown as Fetch), env: deps.env ?? process.env, gitEmail: deps.gitEmail ?? gitEmail, hostName: deps.hostName ?? (() => os.hostname()) }
    this.state = core.metaJSON<State>("telemetry_state", {})
  }

  private save() {
    this.core.store.setMeta("telemetry_state", JSON.stringify(this.state))
  }

  resolved(): Resolved {
    const id = this.core.config.telemetry.identity
    const email = id.email === "git" ? this.email?.value : id.email || undefined
    return resolveTelemetry(this.core.config, this.deps.env, this.core.version, { email, hostName: id.hostName ? this.deps.hostName() : undefined })
  }

  /** For the health check and the dashboard. Header values are never included. */
  status() {
    const t = this.core.config.telemetry
    const r = this.resolved()
    return {
      enabled: t.enabled,
      problems: t.enabled ? r.problems : [],
      endpoint: describeUrl(r.metricsUrl),
      headerNames: Object.keys(r.headers),
      level: r.level,
      projects: r.projects,
      intervalMs: r.intervalMs,
      temporality: r.temporality,
      identity: Object.keys(r.resource).filter((k) => ["user.email", "user.id", "organization.id", "host.name"].includes(k)),
      queued: this.core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM telemetry_queue")?.n ?? 0,
      lastOk: this.state.lastOk,
      lastError: this.state.lastError,
      sent: this.state.sent ?? 0,
      dropped: this.state.dropped ?? 0,
    }
  }

  /** Called on the plugin's timer. Collects when an interval has passed, then delivers whatever is queued. */
  async tick(now = Date.now()) {
    if (this.busy) return
    this.busy = true
    try {
      if (!this.core.config.telemetry.enabled) {
        // Nothing recorded while the export is off is sent when it is turned on again.
        if (this.state.cursorAt !== undefined || this.core.store.get("SELECT 1 AS x FROM telemetry_queue LIMIT 1")) {
          this.core.store.run("DELETE FROM telemetry_queue")
          this.state = { ...this.state, cursorAt: undefined, routingId: undefined }
          this.save()
        }
        return
      }
      if (this.core.config.telemetry.identity.email === "git" && !this.email) this.email = { value: await this.deps.gitEmail().catch(() => undefined) }
      const r = this.resolved()
      if (r.problems.length) return
      if (this.state.cursorAt === undefined) {
        // First run: start from now. History from before the export was turned on stays on this machine.
        const routingId = this.core.store.get<{ id: number }>("SELECT COALESCE(MAX(id), 0) AS id FROM routing")?.id ?? 0
        this.state = { ...this.state, cursorAt: now, routingId, startAt: this.state.startAt ?? now }
        this.save()
      } else if (now - this.state.cursorAt >= r.intervalMs) {
        this.collect(r, now)
      }
      await this.flush(r, now)
    } catch (error) {
      this.core.log.warn("telemetry", { error: String(error) })
    } finally {
      this.busy = false
    }
  }

  /** Everything that changed between the last export and `now`, queued as one metrics request and one logs request. */
  collect(r: Resolved, now: number) {
    const store = this.core.store
    const from = Math.max(this.state.cursorAt ?? now, now - CATCH_UP)
    const sums: Metric[] = []
    const sum = (name: string, description: string, unit: string, integer = false) => {
      const m: Metric = { name, description, unit, type: "sum", points: [], integer }
      sums.push(m)
      return (attrs: Attrs, value: number) => {
        if (value > 0) m.points.push({ attrs, value })
      }
    }
    const tokens = sum("quota_router.tokens", "Tokens used, by provider, model and type", "{token}", true)
    const equiv = sum("quota_router.cost.equivalent_usd", "What the usage would cost at pay-per-use prices", "USD")
    const actual = sum("quota_router.cost.actual_usd", "What the usage actually cost on pay-per-use providers", "USD")
    const requests = sum("quota_router.requests", "Model requests", "{request}", true)
    const failed = sum("quota_router.requests.failed", "Model requests that failed", "{request}", true)
    const avoided = sum("quota_router.overage.avoided_usd", "Pay-per-use value of requests a fallback provider served, less what they cost", "USD")
    const fallbacks = sum("quota_router.fallbacks", "Sessions moved to another provider because of a limit", "{fallback}", true)
    const limited = sum("quota_router.limited.duration", "Time a provider spent limited", "s")

    const project = (directory: string | null): Attrs => {
      if (r.projects === "off" || !directory) return {}
      return { project: r.projects === "names" ? path.basename(directory) : createHash("sha256").update(directory).digest("hex").slice(0, 12) }
    }
    const rows = store.all<Record<string, any>>(
      `SELECT s.provider_id AS provider, s.model_id AS model, s.kind AS kind, ${r.projects === "off" ? "NULL" : "se.directory"} AS directory,
         COUNT(*) AS n, SUM(s.status = 'failed') AS failed, SUM(s.input) AS input, SUM(s.output) AS output, SUM(s.reasoning) AS reasoning,
         SUM(s.cache_read) AS cache_read, SUM(s.cache_write) AS cache_write, SUM(s.cost_equiv) AS equiv, SUM(s.cost_actual) AS actual,
         SUM(CASE WHEN s.on_fallback = 1 THEN MAX(s.cost_equiv - s.cost_actual, 0) ELSE 0 END) AS avoided
       FROM steps s LEFT JOIN sessions se ON se.id = s.session_id
       WHERE s.ended_at > ? AND s.ended_at <= ? AND s.status != 'running' GROUP BY 1, 2, 3, 4`,
      from, now,
    )
    for (const x of rows) {
      const base: Attrs = { provider: x.provider, model: x.model, ...project(x.directory) }
      for (const type of ["input", "output", "reasoning", "cache_read", "cache_write"]) tokens({ ...base, type }, Number(x[type] ?? 0))
      equiv(base, Number(x.equiv ?? 0))
      actual(base, Number(x.actual ?? 0))
      requests({ ...base, kind: x.kind }, Number(x.n ?? 0))
      failed({ ...base, kind: x.kind }, Number(x.failed ?? 0))
      avoided(base, Number(x.avoided ?? 0))
    }

    // Routing changes since the last export: fallback counts, and events when asked for.
    const routing = store.all<Record<string, any>>(
      "SELECT id, at, session_id, trigger, kind, from_model, to_model, pool, until FROM routing WHERE id > ? AND dry = 0 ORDER BY id LIMIT 2000",
      this.state.routingId ?? 0,
    )
    const counts = new Map<string, { attrs: Attrs; n: number }>()
    const events: LogEvent[] = []
    for (const x of routing) {
      const moved = { from: x.from_model ?? undefined, to: x.to_model ?? undefined, trigger: x.trigger, "session.id": x.session_id ?? undefined }
      if (x.trigger === "failover" || x.trigger === "preempt") {
        const attrs: Attrs = { from_provider: provider(x.from_model), to_provider: provider(x.to_model), reason_kind: x.kind ?? x.trigger }
        const key = seriesKey("f", attrs)
        counts.set(key, { attrs, n: (counts.get(key)?.n ?? 0) + 1 })
      }
      if (x.trigger === "failover" || x.trigger === "exhausted") events.push({ at: x.at, name: "quota_router.limit_hit", attrs: { provider: provider(x.from_model) ?? x.pool ?? undefined, kind: x.kind ?? undefined, reset_at: x.until ? new Date(x.until).toISOString() : undefined, "session.id": x.session_id ?? undefined } })
      if (x.trigger === "recovery") events.push({ at: x.at, name: "quota_router.recovered", attrs: moved })
      else if (x.trigger === "exhausted") events.push({ at: x.at, name: "quota_router.exhausted", attrs: { "session.id": x.session_id ?? undefined, wait_seconds: x.until && x.until > x.at ? Math.round((x.until - x.at) / 1000) : undefined } })
      else if (x.to_model) events.push({ at: x.at, name: "quota_router.switch", attrs: moved })
    }
    for (const c of counts.values()) fallbacks(c.attrs, c.n)

    // Time limited: the part of this interval each limited pool spent limited.
    for (const p of this.core.pools.all()) {
      if (p.status !== "cooling" && p.status !== "blocked") continue
      const seconds = (Math.min(now, p.until ?? now) - Math.max(from, p.since)) / 1000
      limited({ provider: p.id.split(":")[0], pool: p.id, kind: p.kind }, seconds)
    }

    // Cumulative totals are kept so either temporality can be sent from the same collection.
    if (r.temporality === "cumulative") {
      const totals = this.core.metaJSON<Record<string, number>>("telemetry_totals", {})
      for (const m of sums) for (const p of m.points) p.value = totals[seriesKey(m.name, p.attrs)] = (totals[seriesKey(m.name, p.attrs)] ?? 0) + p.value
      store.setMeta("telemetry_totals", JSON.stringify(totals))
    }

    const metrics = [...sums, ...this.gauges()]
    const enqueue = (signal: "metrics" | "logs", body: unknown) => store.run("INSERT INTO telemetry_queue (at, signal, body) VALUES (?, ?, ?)", now, signal, JSON.stringify(body))
    store.transaction(() => {
      if (metrics.some((m) => m.points.length))
        enqueue("metrics", metricsPayload(metrics, { resource: r.resource, version: this.core.version, start: r.temporality === "cumulative" ? (this.state.startAt ?? from) : from, end: now, temporality: r.temporality }))
      if (r.level === "events" && r.logsUrl && events.length) enqueue("logs", logsPayload(events, { resource: r.resource, version: this.core.version, observed: now }))
      this.state = { ...this.state, cursorAt: now, routingId: routing.at(-1)?.id ?? this.state.routingId }
      this.save()
    })
    this.trim(now)
  }

  /** Plan pressure as it stands now: how full each window is, and allowances counted in credits or money. */
  private gauges(): Metric[] {
    const core = this.core
    const utilization: Metric = { name: "quota_router.plan.utilization", description: "How much of a plan window is used, 0 to 100", unit: "%", type: "gauge", points: [] }
    const used: Metric = { name: "quota_router.plan.allowance.used", description: "Allowance used in the current period", unit: "1", type: "gauge", points: [] }
    const total: Metric = { name: "quota_router.plan.allowance.total", description: "Allowance for the current period", unit: "1", type: "gauge", points: [] }
    const fresh = (at?: number) => !!at && Date.now() - at < 30 * 60_000
    if (core.claude.ok && core.claude.data && fresh(core.claude.at)) {
      for (const w of core.claude.data.windows) utilization.points.push({ attrs: { provider: "claude-agent", window: windowName(w.label) }, value: w.utilization })
      const e = core.claude.data.extra
      if (e?.enabled) {
        used.points.push({ attrs: { provider: "claude-agent", allowance: "usage_credits", unit: e.currency ?? "USD" }, value: e.used })
        if (e.limit !== undefined) total.points.push({ attrs: { provider: "claude-agent", allowance: "usage_credits", unit: e.currency ?? "USD" }, value: e.limit })
      }
    }
    if (core.chatgptActive() && core.chatgpt.data && fresh(core.chatgpt.at)) {
      for (const w of core.chatgpt.data.windows) utilization.points.push({ attrs: { provider: "openai", window: windowName(w.label), plan: "chatgpt" }, value: w.usedPct })
    }
    const cp = core.copilot.data
    if (core.copilot.ok && cp && fresh(core.copilot.at) && !cp.unlimited && cp.entitlement > 0) {
      const attrs: Attrs = { provider: "github-copilot", plan: cp.plan, allowance: cp.name, unit: "credits" }
      utilization.points.push({ attrs: { provider: "github-copilot", window: "monthly", plan: cp.plan }, value: Math.min(100, (cp.used / cp.entitlement) * 100) })
      used.points.push({ attrs, value: cp.used })
      total.points.push({ attrs, value: cp.entitlement })
    }
    return [utilization, used, total]
  }

  private trim(now: number) {
    const store = this.core.store
    const before = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM telemetry_queue")?.n ?? 0
    store.run("DELETE FROM telemetry_queue WHERE at < ?", now - QUEUE_MAX_AGE)
    store.run("DELETE FROM telemetry_queue WHERE id NOT IN (SELECT id FROM telemetry_queue ORDER BY id DESC LIMIT ?)", QUEUE_MAX)
    const dropped = before - (store.get<{ n: number }>("SELECT COUNT(*) AS n FROM telemetry_queue")?.n ?? 0)
    if (dropped > 0) {
      this.state = { ...this.state, dropped: (this.state.dropped ?? 0) + dropped }
      this.save()
    }
  }

  /** Deliver the queue, oldest first. A request the collector cannot take yet stays queued; one it refuses is dropped. */
  async flush(r: Resolved, now = Date.now()) {
    const store = this.core.store
    this.trim(now)
    for (const signal of ["metrics", "logs"] as const) {
      const url = signal === "metrics" ? r.metricsUrl : r.logsUrl
      if (!url) continue
      for (const row of store.all<{ id: number; body: string; attempts: number; next_at: number }>("SELECT id, body, attempts, next_at FROM telemetry_queue WHERE signal = ? ORDER BY id LIMIT 50", signal)) {
        // Oldest first: while one request waits to be retried, the ones behind it wait too, so data arrives in order.
        if (row.next_at > now) break
        let status = 0
        let retryAfter = 0
        let failure = ""
        try {
          // Redirects are refused, so headers are never passed on to another host.
          const res = await this.deps.fetch(url, { method: "POST", headers: { ...r.headers, "content-type": "application/json" }, body: row.body, redirect: "error", signal: AbortSignal.timeout(10_000) })
          status = res.status
          const after = Number(res.headers.get("retry-after"))
          if (Number.isFinite(after) && after > 0) retryAfter = Math.min(after, 3600) * 1000
        } catch (error) {
          failure = error instanceof Error ? error.name : "network error"
        }
        if (status >= 200 && status < 300) {
          store.run("DELETE FROM telemetry_queue WHERE id = ?", row.id)
          this.state = { ...this.state, lastOk: now, lastError: undefined, sent: (this.state.sent ?? 0) + 1 }
          continue
        }
        const where = `${describeUrl(url)}`
        if (status === 0 || RETRYABLE.has(status)) {
          const backoff = Math.max(retryAfter, Math.min(600_000, 5_000 * 2 ** row.attempts))
          store.run("UPDATE telemetry_queue SET attempts = attempts + 1, next_at = ? WHERE id = ?", now + backoff, row.id)
          this.state = { ...this.state, lastError: status ? `HTTP ${status} from ${where}; will retry` : `Could not reach ${where} (${failure}); will retry` }
          break
        }
        store.run("DELETE FROM telemetry_queue WHERE id = ?", row.id)
        this.state = { ...this.state, lastError: `HTTP ${status} from ${where}; the request was dropped`, dropped: (this.state.dropped ?? 0) + 1 }
      }
    }
    this.save()
  }
}
