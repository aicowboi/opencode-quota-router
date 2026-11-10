// Process-wide state shared by every plugin instance: pools, sessions, store, usage probes, dashboard.
import path from "node:path"
import os from "node:os"
import { feed, raise, type AlertInput } from "./alerts.ts"
import { checkSetting, loadConfig, overlay, refKey, refLabel, type Config } from "./engine/config.ts"
import { modelPools } from "./engine/classify.ts"
import { localDay, Store } from "./db.ts"
import { dataDir, Logger } from "./log.ts"
import { composeGates, downGate, economyGate, saveGate, spendBlocks, spendGate, type Gate, type Saved, type Spend } from "./engine/policy.ts"
import { PoolStore } from "./engine/pools.ts"
import { estimate } from "./engine/pricing.ts"
import { fetchClaudeUsage, interpretClaudeUsage, readClaudeToken, type ClaudeUsage } from "./probes/claude.ts"
import { fetchCopilotUser, findGithubToken, interpretCopilot, type CopilotQuota } from "./probes/copilot.ts"
import { fetchLocal, LOCAL_NAMES, type LocalHealth, type LocalKind } from "./probes/local.ts"
import { healthGate, speedOf, summariseHealth, type ProviderHealth } from "./engine/health.ts"
import { learnPool, type LearnedPool, type PoolSpend } from "./engine/learn.ts"
import { fetchOpenRouterKey, findOpenRouterKey, interpretOpenRouter, type OpenRouterCredit } from "./probes/openrouter.ts"
import { markDirty, optimize, prune, refreshSessions, rollupDirty } from "./maintenance.ts"
import { applyDiscovery, suggest, withAdditions, type ConnectionMethod } from "./engine/discovery.ts"
import type { CodexWindow } from "./engine/headers.ts"
import { Recorder } from "./recorder.ts"
import { Telemetry } from "./telemetry/exporter.ts"
import { forecast, paceGate, type WindowForecast } from "./engine/forecast.ts"
import { nextMonthUtc } from "./engine/resets.ts"
import { findInChains, orderedChain, type Preferred } from "./engine/router.ts"
import type { ModelInfo, ModelRef, PoolState, Signal, Tokens } from "./engine/types.ts"

export const VERSION = "0.1.0"

export type SessionState = {
  id: string
  /** The model the session should be on when nothing is limited. Undefined: not in any chain, left alone. */
  preferred?: Preferred & { model: ModelRef }
  current?: ModelRef
  stepModel?: ModelRef
  pending: Array<{ model: ModelRef; at: number }>
  pinned: boolean
  lastInputTokens?: number
  lastRetry?: { attempt: number; from: string; at: number }
  resumed: Set<string>
  resumes: number[]
  deferred?: { at: number; executionEventID: string }
  parentID?: string
  /** When routing last moved the session. */
  movedAt?: number
  /** The agent the session runs as, when known. */
  agent?: string
  /** The user chose a model in this session, which outranks the chain configured for its agent. */
  picked?: boolean
  /** `preferred` comes from the chain configured for the session's agent. */
  byAgent?: boolean
  /** Dry run: the last move suggested at a turn, so the same suggestion is not recorded again every turn. */
  dryLast?: string
  /** Set while the session runs on a fallback; cleared when it returns or the user picks a model. */
  fallback?: { from: ModelRef; reason?: string; at: number }
}

export type ProbeStatus<T> = { at?: number; ok: boolean; message?: string; data?: T; nextAt?: number }

type Ctx = any

export class Core {
  config: Config
  warnings: string[]
  readonly log: Logger
  readonly store: Store
  readonly pools: PoolStore
  readonly recorder: Recorder
  readonly sessions = new Map<string, SessionState>()
  models = new Map<string, ModelInfo>()
  modelsAt = 0
  ctx: Ctx
  instances = new Set<Ctx>()
  paused = false
  started = Date.now()
  lastActivity = Date.now()
  claude: ProbeStatus<ClaudeUsage> & { lastExtraUsed?: number; plan?: { type?: string; tier?: string } } = { ok: false }
  copilot: ProbeStatus<CopilotQuota> = { ok: false }
  openrouter: ProbeStatus<OpenRouterCredit> = { ok: false }
  /** Model servers on this machine: whether each is running and what it has loaded. */
  local = new Map<LocalKind, ProbeStatus<LocalHealth>>()
  readonly totalMemory = os.totalmem()
  /** ChatGPT plan windows, read from response headers while OpenAI is signed in with ChatGPT. */
  chatgpt: ProbeStatus<{ windows: CodexWindow[] }> = { ok: false }
  /** How each connected provider is signed in. */
  connections = new Map<string, ConnectionMethod | undefined>()
  /** Called when the ChatGPT sign-in becomes active, to start reading its headers. */
  onChatgpt = new Set<() => Promise<void> | void>()
  private options: unknown
  dashboardURL?: string
  private listeners = new Set<(kinds: string[]) => void>()
  private pendingKinds = new Set<string>()
  private notifyTimer?: ReturnType<typeof setTimeout>
  private timers: Array<ReturnType<typeof setInterval>> = []
  private probing = { claude: false, copilot: false, openrouter: false, local: false }
  private lastSnapshot = new Map<string, { json: string; at: number }>()
  private maintaining = false
  shutdown?: () => Promise<void>
  readonly version = VERSION
  readonly telemetry: Telemetry

  private constructor(store: Store, log: Logger, options: unknown) {
    this.store = store
    this.options = options
    const { config, warnings } = loadConfig(overlay(options, this.storedSettings()))
    this.config = config
    this.warnings = warnings
    this.log = log
    this.pools = new PoolStore(config)
    this.pools.load(store.all<{ state: string }>("SELECT state FROM pools").map((r) => JSON.parse(r.state) as PoolState))
    this.pools.onChange(({ pool, previous, reason }) => {
      store.run("INSERT INTO pools (id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state", pool.id, JSON.stringify(pool))
      const meaningful = !previous || previous.status !== pool.status || previous.until !== pool.until || previous.kind !== pool.kind
      if (meaningful) {
        store.run(
          "INSERT INTO pool_log (at, pool, status, kind, until, utilization, evidence, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          pool.updated, pool.id, pool.status, pool.kind, pool.until, pool.utilization, pool.evidence, reason,
        )
        log.info("pool", { pool: pool.id, status: pool.status, kind: pool.kind, until: pool.until && new Date(pool.until).toISOString(), evidence: pool.evidence, reason })
      }
      this.notify("pools")
    })
    this.recorder = new Recorder(store, (p, m, t, r) => this.price(p, m, t, r), (id) => void this.fetchSession(id), (k) => this.notify(k), (id) => !!this.sessions.get(id)?.fallback)
    this.telemetry = new Telemetry(this)
    for (const w of warnings) log.warn("config", { warning: w })
  }

  static async create(options: unknown): Promise<Core> {
    const dir = dataDir()
    const log = new Logger(path.join(dir, "router.log"))
    const store = await Store.open(path.join(dir, "router.db"))
    const core = new Core(store, log, options)
    log.setLevel(core.config.log.level)
    log.info("start", { version: VERSION, runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}` })
    return core
  }

  setOptions(options: unknown) {
    this.options = options
    this.rebuildConfig()
    this.log.setLevel(this.config.log.level)
    for (const w of this.warnings) this.log.warn("config", { warning: w })
  }

  /** Options, then settings changed at runtime, then what the connections say, then the chain entries accepted on the dashboard. */
  rebuildConfig() {
    const { config, warnings } = loadConfig(overlay(this.options, this.storedSettings()))
    const connected = new Map<string, ConnectionMethod | undefined>()
    for (const m of this.models.values()) if (!connected.has(m.providerID)) connected.set(m.providerID, this.connections.get(m.providerID))
    this.config = withAdditions(applyDiscovery(config, connected), this.chainAdditions())
    this.warnings = warnings
    this.pools.setConfig(this.config)
    // Chains and ranks may have changed: re-resolve each session's preference.
    for (const s of this.sessions.values()) {
      if (s.preferred && !s.byAgent) s.preferred = this.preferredFor(s.preferred.model)
      this.prefer(s)
    }
    this.notify("config")
  }

  // ---------- connections and chain suggestions ----------

  /** Read how each connected provider is signed in, and re-rank. */
  async refreshConnections() {
    if (!this.ctx) return
    const providers = [...new Set([...this.models.values()].map((m) => m.providerID))]
    const next = new Map<string, ConnectionMethod | undefined>()
    await Promise.all(
      providers.map(async (id) => {
        try {
          const c = await this.ctx.integration.connection.active(id)
          next.set(id, c?.type === "env" ? "env" : c?.method)
        } catch {
          next.set(id, undefined)
        }
      }),
    )
    const wasChatgpt = this.chatgptActive()
    for (const [id, method] of next) {
      const before = this.connections.get(id)
      if (this.connections.has(id) && before !== method) {
        this.log.info("connection changed", { provider: id, from: before, to: method })
        this.resetProvider(id, "sign-in changed")
      }
    }
    this.connections = next
    this.rebuildConfig()
    if (!wasChatgpt && this.chatgptActive()) for (const f of this.onChatgpt) await f()
  }

  /** OpenAI signed in with ChatGPT rather than an API key. */
  chatgptActive() {
    return this.connections.get("openai") === "oauth"
  }

  /** A different login or plan: what was learned about the old one no longer applies. */
  resetProvider(providerID: string, reason: string) {
    for (const p of this.pools.all()) if (p.id === providerID || p.id.startsWith(`${providerID}:`)) this.pools.reset(p.id, reason)
    if (providerID === "openai") this.chatgpt = { ok: false }
  }

  metaJSON<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(this.store.meta(key) ?? "") as T
    } catch {
      return fallback
    }
  }

  /** Settings changed from a command or the dashboard. They sit on top of `opencode.jsonc`, which is never written to. */
  storedSettings(): Record<string, unknown> {
    const stored = this.metaJSON<unknown>("settings", {})
    return typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  }

  /** Change one setting by its dotted path, for example `claude.cutoverAtPct`. `undefined` goes back to the configured value. */
  setSetting(path: string, value: unknown): { ok: true } | { ok: false; error: string } {
    const checked = checkSetting(this.options, this.storedSettings(), path, value)
    if (!checked.ok) return checked
    this.store.setMeta("settings", JSON.stringify(checked.stored))
    this.log.info("setting", { path, cleared: value === undefined })
    this.rebuildConfig()
    this.log.setLevel(this.config.log.level)
    return { ok: true }
  }

  /** Routing policies beyond pool health. Each feature adds its own; the router asks them in order. */
  policies: Array<(s?: SessionState) => Gate | undefined> = [
    () => spendGate(this.config, this.spend(), Date.now()),
    () => saveGate(this.saved(), Date.now()),
    () => downGate(this.localDown()),
    () => healthGate(this.config, this.health()),
    () => economyGate(this.config, this.copilot.data && this.copilot.data.entitlement > 0 ? (this.copilot.data.used / this.copilot.data.entitlement) * 100 : undefined, this.models),
    (s) => (this.config.pace.enabled && s && this.isLight(s) ? paceGate(this.config, this.forecasts(), true, Date.now()) : undefined),
  ]

  /** Light work for the pace guard: a subagent's session, or a session run by one of the agents listed. */
  isLight(s: SessionState) {
    return Boolean(s.parentID) || (s.agent !== undefined && this.config.pace.lightAgents.includes(s.agent))
  }

  private healthCache?: { at: number; health: Record<string, ProviderHealth> }

  /** Time to first token over the last hour and the error rate over `health.windowMs`, per provider. */
  health(now = Date.now()): Record<string, ProviderHealth> {
    const c = this.healthCache
    if (c && now - c.at < 10_000 && now >= c.at) return c.health
    const rows = this.store.all<{ p: string; at: number; status: string; first_ms: number | null; error_type: string | null }>(
      "SELECT provider_id AS p, COALESCE(ended_at, started_at) AS at, status, first_ms, error_type FROM steps WHERE started_at >= ? AND kind = 'primary' AND status IN ('ok', 'failed') AND provider_id IS NOT NULL",
      now - Math.max(3_600_000, this.config.health.windowMs),
    )
    const health = summariseHealth(rows.map((r) => ({ providerID: r.p, at: r.at, ok: r.status === "ok", firstMs: r.first_ms ?? undefined, errorType: r.error_type ?? undefined })), now, this.config.health.windowMs)
    this.healthCache = { at: now, health }
    return health
  }

  /** For `route`: which of two providers of the same priority starts answering sooner. */
  speed() {
    return speedOf(this.health())
  }

  /** Local servers seen not running at a check recent enough to trust. */
  localDown(now = Date.now()): Record<string, string> {
    const down: Record<string, string> = {}
    if (!this.config.local.healthCheck) return down
    for (const [kind, status] of this.local) if (status.data && !status.data.running && status.at && now - status.at < 3 * 60_000) down[kind] = `${LOCAL_NAMES[kind]} is not running`
    return down
  }

  async probeLocal(force = false) {
    const cfg = this.config.local
    if (!cfg.healthCheck || this.probing.local) return
    const servers = ([["ollama", cfg.ollamaUrl], ["lmstudio", cfg.lmstudioUrl]] as const).filter(([kind]) => this.hasProvider(kind))
    if (servers.length === 0) return
    this.probing.local = true
    try {
      await Promise.all(
        servers.map(async ([kind, url]) => {
          const prev = this.local.get(kind)
          const now = Date.now()
          if (!force && prev?.nextAt && now < prev.nextAt) return
          const health = await fetchLocal(kind, url)
          this.local.set(kind, { at: Date.now(), ok: health.running && !health.error, data: health, message: health.running ? health.error : `${LOCAL_NAMES[kind]} is not running at ${url}`, nextAt: now + 30_000 })
          if (prev?.data && prev.data.running !== health.running) this.log.info("local", { server: kind, running: health.running })
        }),
      )
    } catch (error) {
      this.log.warn("local health check failed", { error: String(error) })
    } finally {
      this.probing.local = false
      this.notify("usage")
    }
  }

  private forecastCache?: { at: number; list: WindowForecast[] }
  private learnedCache?: { at: number; spend: PoolSpend[]; pool?: LearnedPool }

  /**
   * xAI publishes no usage figures, so the size of its weekly pool is learned: each time it has run out, the usage
   * in the week before, at list prices, is a reading of what it holds. An estimate, and shown as one.
   */
  learned(now = Date.now()): { xai?: LearnedPool } {
    if (!this.hasProvider("xai") || this.config.providers.xai?.kind !== "subscription") return {}
    const WEEK = 7 * 86_400_000
    const c = this.learnedCache
    if (c && now - c.at < 5 * 60_000 && now >= c.at) return c.pool ? { xai: c.pool } : {}
    const exhausted = this.store
      .all<{ at: number; until: number | null }>("SELECT at, until FROM pool_log WHERE pool = 'xai' AND status IN ('cooling', 'blocked') AND kind IN ('window', 'billing') AND at >= ? ORDER BY at", now - 26 * WEEK)
      .map((r) => ({ at: r.at, until: r.until ?? undefined }))
    const first = exhausted[0]
    const spend = first
      ? this.store.all<PoolSpend>(
          "SELECT (COALESCE(ended_at, started_at) / 3600000) * 3600000 AS at, SUM(cost_equiv) AS usd FROM steps WHERE provider_id = 'xai' AND COALESCE(ended_at, started_at) >= ? GROUP BY 1 ORDER BY 1",
          first.at - WEEK,
        )
      : []
    const pool = learnPool({ exhausted, spend, windowMs: WEEK, now })
    this.learnedCache = { at: now, spend, pool }
    return pool ? { xai: pool } : {}
  }

  /** Where each plan window is heading at its recent pace, from the usage figures the checks have recorded. */
  forecasts(now = Date.now()): WindowForecast[] {
    if (this.forecastCache && now - this.forecastCache.at < 30_000 && now >= this.forecastCache.at) return this.forecastCache.list
    const DAY = 86_400_000
    const windows: Array<{ providerID: string; pool: string; label: string; pct: number; limitPct: number; resetAt?: number; windowMs: number; read: (data: any) => number | undefined }> = []
    const claude = this.config.claude
    for (const w of this.claude.data?.windows ?? [])
      windows.push({
        providerID: "claude-agent", pool: w.pool, label: `Claude ${w.label}`, pct: w.utilization, resetAt: w.resetAt,
        limitPct: claude.avoidUsageCredits ? claude.cutoverAtPct : 100,
        windowMs: /5-hour/.test(w.label) ? 5 * 3_600_000 : 7 * DAY,
        read: (d) => d?.windows?.find((x: any) => x?.label === w.label)?.utilization,
      })
    const q = this.copilot.data
    if (q && q.entitlement > 0 && !q.unlimited)
      windows.push({
        providerID: "github-copilot", pool: "github-copilot", label: "Copilot monthly allowance", pct: (q.used / q.entitlement) * 100, resetAt: q.resetAt,
        limitPct: 100 - this.config.copilot.reserveFraction * 100,
        windowMs: 30 * DAY,
        read: (d) => (d?.entitlement > 0 ? (d.used / d.entitlement) * 100 : undefined),
      })
    if (this.chatgptActive())
      for (const w of this.chatgpt.data?.windows ?? [])
        windows.push({
          providerID: "openai", pool: "openai", label: `ChatGPT ${w.label}`, pct: w.usedPct, resetAt: w.resetAt,
          limitPct: this.config.chatgpt.cutoverAtPct,
          windowMs: (w.windowMinutes ?? (w.label === "weekly" ? 7 * 1440 : 300)) * 60_000,
          read: (d) => d?.windows?.find((x: any) => x?.label === w.label)?.usedPct,
        })
    const list: WindowForecast[] = []
    const rows = new Map<string, Array<{ at: number; data: unknown }>>()
    for (const w of windows) {
      let history = rows.get(w.providerID)
      if (!history) {
        history = this.store.all<{ at: number; data: string }>("SELECT at, data FROM usage_snapshots WHERE provider = ? AND at >= ? ORDER BY at", w.providerID, now - 3 * DAY).flatMap((r) => {
          try {
            return [{ at: r.at, data: JSON.parse(r.data) }]
          } catch {
            return []
          }
        })
        rows.set(w.providerID, history)
      }
      const samples = history.flatMap((r) => {
        const pct = w.read(r.data)
        return typeof pct === "number" ? [{ at: r.at, pct }] : []
      })
      const f = forecast(samples, { resetAt: w.resetAt, windowMs: w.windowMs, limitPct: w.limitPct, now })
      if (f) list.push({ ...f, providerID: w.providerID, pool: w.pool, label: w.label, pct: w.pct, limitPct: w.limitPct, resetAt: w.resetAt })
    }
    const xai = this.learned(now).xai
    if (xai && !xai.exhausted && xai.resetAt) {
      // No readings over time for a learned pool, so they are rebuilt from the usage on record.
      const spend = (this.learnedCache?.spend ?? []).filter((s) => s.at >= xai.windowStart && s.at <= now)
      const samples: Array<{ at: number; pct: number }> = []
      let sum = 0
      let i = 0
      for (let at = xai.windowStart; ; at = Math.min(now, at + 3_600_000)) {
        while (i < spend.length && spend[i].at < at) sum += spend[i++].usd
        samples.push({ at, pct: (sum / xai.capacityUsd) * 100 })
        if (at >= now) break
      }
      const f = forecast(samples, { resetAt: xai.resetAt, windowMs: 7 * DAY, limitPct: 100, now })
      if (f) list.push({ ...f, providerID: "xai", pool: "xai", label: "xAI weekly pool (estimated)", pct: xai.pct, limitPct: 100, resetAt: xai.resetAt })
    }
    this.forecastCache = { at: now, list }
    return list
  }

  /** Providers set aside for later, and until when. Kept in the database, so a restart does not forget them. */
  saved(now = Date.now()): Saved {
    const stored = this.metaJSON<Saved>("saved", {})
    return Object.fromEntries(Object.entries(stored && typeof stored === "object" ? stored : {}).filter(([, until]) => typeof until === "number" && until > now))
  }

  /** Set a provider aside until a time, or with no time, make it available again. */
  save(providerID: string, until?: number) {
    const next = this.saved()
    if (until && until > Date.now()) next[providerID] = until
    else {
      delete next[providerID]
      this.settle()
    }
    this.store.setMeta("saved", JSON.stringify(next))
    this.log.info("save", { provider: providerID, until: until && new Date(until).toISOString() })
    this.notify("pools")
  }

  /** The provider a word means: its ID, a common name for it, or the only provider whose ID contains the word. */
  findProvider(word: string): string | undefined {
    const w = word.toLowerCase()
    const ids = Object.keys(this.config.providers)
    const alias: Record<string, string> = { claude: "claude-agent", copilot: "github-copilot", github: "github-copilot", chatgpt: "openai", gpt: "openai", codex: "openai", grok: "xai", gemini: "google" }
    if (ids.includes(w)) return w
    if (alias[w] && ids.includes(alias[w])) return alias[w]
    const found = ids.filter((id) => id.includes(w))
    return found.length === 1 ? found[0] : undefined
  }

  private spendCache?: { at: number; spend: Spend }

  /** What pay-per-use providers have cost today and this month. Read from recorded requests, and cached briefly. */
  spend(now = Date.now()): Spend {
    if (this.spendCache && now - this.spendCache.at < 5_000 && now >= this.spendCache.at) return this.spendCache.spend
    const today = localDay(now)
    const rows = this.store.all<{ p: string; d: number; m: number }>(
      "SELECT provider_id AS p, SUM(CASE WHEN day = ? THEN cost_actual ELSE 0 END) AS d, SUM(cost_actual) AS m FROM steps WHERE day >= ? AND cost_actual > 0 GROUP BY provider_id",
      today, `${today.slice(0, 8)}01`,
    )
    const spend: Spend = { day: {}, month: {} }
    for (const r of rows) {
      if (r.d > 0) spend.day[r.p] = r.d
      spend.month[r.p] = r.m
    }
    this.spendCache = { at: now, spend }
    return spend
  }

  /** Spend caps reached right now, by provider (`*` for the cap across all of them). */
  spendBlocks(now = Date.now()) {
    return spendBlocks(this.config, this.spend(now), now)
  }

  gate(s?: SessionState): Gate | undefined {
    return composeGates(this.policies.map((p) => p(s)))
  }

  chainAdditions(): Record<string, string[]> {
    return this.metaJSON<Record<string, string[]>>("chain_additions", {})
  }

  ignoredSuggestions(): string[] {
    return this.metaJSON<string[]>("chain_ignored", [])
  }

  suggestions() {
    return suggest(this.config, this.models, new Set(this.ignoredSuggestions()))
  }

  /** Accept, ignore or undo a suggested chain entry. Stored in the plugin's database, never in the user's config. */
  changeChain(action: "add" | "ignore" | "remove", chain: string, ref: string) {
    const additions = this.chainAdditions()
    const key = ref.replace(/#.*$/, "")
    if (action === "add") additions[chain] = [...(additions[chain] ?? []).filter((r) => r.replace(/#.*$/, "") !== key), ref]
    else if (action === "remove") additions[chain] = (additions[chain] ?? []).filter((r) => r.replace(/#.*$/, "") !== key)
    else this.store.setMeta("chain_ignored", JSON.stringify([...new Set([...this.ignoredSuggestions(), `${chain} ${key}`])]))
    if (action !== "ignore") this.store.setMeta("chain_additions", JSON.stringify(additions))
    this.log.info("chain", { action, chain, ref })
    this.rebuildConfig()
  }

  // ---------- notifications ----------

  /** Raise a notification. Dropped when its kind is turned off or it repeats a recent one. */
  alert(a: AlertInput) {
    try {
      const raised = raise(this.store, this.config, a)
      if (!raised) return
      this.log.info("alert", { kind: a.kind, title: a.title })
      this.notify("alerts")
    } catch (error) {
      this.log.warn("alert failed", { error: String(error) })
    }
  }

  alerts(opts: { after?: number; limit?: number } = {}) {
    return feed(this.store, opts)
  }

  private failingSince = new Map<string, number>()

  /** Conditions noticed by looking rather than by an event: a spend cap reached, a usage check that keeps failing. */
  checkAlerts(now = Date.now()) {
    for (const [id, b] of Object.entries(this.spendBlocks(now))) {
      this.alert({ kind: "spendCap", key: `${id} ${b.until ?? ""}`, title: id === "*" ? "Spend cap reached" : `Spend cap reached for ${id}`, body: `${b.reason}. Routing passes ${id === "*" ? "pay-per-use providers" : id} over until ${new Date(b.until ?? now).toLocaleString()}.` })
    }
    for (const [name, enabled, status] of [["Claude", this.config.claude.usageProbe, this.claude], ["Copilot", this.config.copilot.usageProbe, this.copilot], ["OpenRouter", this.config.openrouter.usageProbe, this.openrouter]] as const) {
      if (!enabled || !status.at || status.ok) {
        this.failingSince.delete(name)
        continue
      }
      const since = this.failingSince.get(name) ?? now
      this.failingSince.set(name, since)
      // One failed check is routine (a login being refreshed, a busy endpoint); ten minutes of them is not.
      if (now - since >= 10 * 60_000) this.alert({ kind: "usageCheck", key: name, title: `${name} usage check is failing`, body: `${status.message ?? "No answer"}. Until it works, a limit is only seen when a request fails.` })
    }
  }

  // ---------- change notification (dashboard live updates) ----------

  subscribe(listener: (kinds: string[]) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(kind: string) {
    this.pendingKinds.add(kind)
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      const kinds = [...this.pendingKinds]
      this.pendingKinds.clear()
      for (const l of this.listeners) l(kinds)
    }, 400)
  }

  // ---------- models ----------

  async refreshModels(force = false) {
    if (!this.ctx || (!force && Date.now() - this.modelsAt < 5 * 60_000 && this.models.size > 0)) return
    try {
      const result = await this.ctx.model.list()
      const list: any[] = Array.isArray(result) ? result : (result?.data ?? result?.items ?? [])
      const next = new Map<string, ModelInfo>()
      for (const m of list) {
        if (!m?.providerID || !m?.id || m.enabled === false) continue
        next.set(refKey(m), {
          providerID: m.providerID,
          id: m.id,
          name: m.name,
          variants: (m.variants ?? []).map((v: any) => (typeof v === "string" ? v : v?.id)).filter(Boolean),
          context: m.limit?.context,
          cost: Array.isArray(m.cost) ? m.cost : undefined,
          family: typeof m.family === "string" ? m.family : undefined,
          released: typeof m.time?.released === "number" ? m.time.released : undefined,
          tools: typeof m.capabilities?.tools === "boolean" ? m.capabilities.tools : undefined,
          status: typeof m.status === "string" ? m.status : undefined,
        })
      }
      if (next.size > 0) {
        const providers = (m: Map<string, ModelInfo>) => [...new Set([...m.values()].map((x) => x.providerID))].sort().join(",")
        const changed = providers(next) !== providers(this.models)
        this.models = next
        this.modelsAt = Date.now()
        if (changed || force) await this.refreshConnections()
      }
    } catch (error) {
      this.log.warn("model list failed", { error: String(error) })
    }
  }

  price(providerID: string, modelID: string, tokens: Tokens, reported: number) {
    return estimate(this.config, this.models, providerID, modelID, tokens, reported)
  }

  // ---------- sessions ----------

  preferredFor(model: ModelRef): SessionState["preferred"] {
    const found = findInChains(this.config, model)
    return found ? { ...found, variant: model.variant, model } : undefined
  }

  /**
   * Apply the chain configured for the session's agent: the session then prefers that chain's first entry, whatever
   * model it started on. A model the user picked in the session outranks it, and subagent sessions are left alone
   * because they run on their parent's model.
   */
  prefer(s: SessionState): boolean {
    const chain = s.agent && !s.picked && !s.parentID && Object.hasOwn(this.config.agents, s.agent) ? this.config.agents[s.agent] : undefined
    const first = chain ? orderedChain(this.config, chain)[0] : undefined
    if (chain && first) {
      s.preferred = { chain, index: 0, variant: first.variant, model: first }
      s.byAgent = true
      return true
    }
    if (s.byAgent) {
      s.byAgent = false
      s.preferred = s.current ? this.preferredFor(s.current) : undefined
    }
    return false
  }

  /** Note the agent a session runs as. A newly selected agent's chain applies even after an earlier model pick. */
  setAgent(s: SessionState, agent: unknown, selected = false) {
    if (typeof agent !== "string" || !agent || (agent === s.agent && !selected)) return
    s.agent = agent
    if (selected && s.picked && Object.hasOwn(this.config.agents, agent)) {
      s.picked = false
      this.savePrefs(s)
    }
    this.prefer(s)
  }

  session(id: string): SessionState {
    let s = this.sessions.get(id)
    if (!s) {
      s = { id, pending: [], pinned: false, resumed: new Set(), resumes: [] }
      const saved = this.store.get<{ data: string }>("SELECT data FROM session_prefs WHERE id = ?", id)
      if (saved) {
        try {
          const d = JSON.parse(saved.data)
          s.pinned = d.pinned === true
          if (d.preferred?.providerID) s.preferred = this.preferredFor(d.preferred)
          // Before agent chains existed, a stored preference was always the user's own pick.
          s.picked = d.picked === undefined ? Boolean(d.preferred?.providerID) : d.picked === true
        } catch {}
      }
      this.sessions.set(id, s)
    }
    return s
  }

  savePrefs(s: SessionState) {
    this.store.run(
      "INSERT INTO session_prefs (id, data, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
      s.id, JSON.stringify({ pinned: s.pinned, preferred: s.byAgent ? undefined : s.preferred?.model, picked: s.picked === true }), Date.now(),
    )
  }

  /** Learn a session's model and preference when the plugin first meets it. */
  async initSession(s: SessionState) {
    if (s.preferred || s.current || !this.ctx) return
    try {
      const r = await this.ctx.session.get({ sessionID: s.id })
      const info = r?.data ?? r
      if (info?.parentID) s.parentID = info.parentID
      const model: ModelRef | undefined = info?.model
      if (model?.providerID) {
        s.current = model
        s.preferred = this.preferredFor(model)
      }
      this.setAgent(s, info?.agent)
    } catch (error) {
      this.log.debug("session get failed", { sessionID: s.id, error: String(error) })
    }
  }

  async fetchSession(id: string) {
    if (!this.ctx) return
    try {
      const r = await this.ctx.session.get({ sessionID: id })
      const info = r?.data ?? r
      if (!info?.id) return
      this.recorder.upsertSession({
        id: info.id,
        parentID: info.parentID,
        projectID: info.projectID,
        directory: info.location?.directory ?? info.directory,
        title: info.title,
        agent: info.agent,
        created: info.time?.created,
      })
      this.notify("session")
    } catch {}
  }

  recordRouting(r: { sessionID?: string; trigger: string; kind?: string; from?: ModelRef; to?: ModelRef; signal?: Signal; until?: number; evidence?: string }) {
    const at = Date.now()
    // In a dry run every decision is recorded as one that was not applied. The user's own switches are always real.
    const dry = this.config.dryRun && r.trigger !== "manual"
    this.store.run(
      "INSERT INTO routing (at, session_id, trigger, kind, from_model, to_model, pool, until, evidence, dry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      at, r.sessionID, r.trigger, r.kind ?? r.signal?.kind, r.from && refLabel(r.from), r.to && refLabel(r.to), r.signal?.pools.join(","),
      r.until ?? r.signal?.resetAt, r.evidence ?? r.signal?.evidence, dry,
    )
    if (r.sessionID) markDirty(this.store, r.sessionID, undefined)
    this.log.info("route", { sessionID: r.sessionID, trigger: r.trigger, ...(dry ? { dry } : {}), from: r.from && refLabel(r.from), to: r.to && refLabel(r.to), evidence: r.evidence ?? r.signal?.evidence })
    this.notify("routing")
    if (dry) return
    const why = r.evidence ?? r.signal?.evidence
    const to = r.to && refLabel(r.to)
    if ((r.trigger === "failover" || r.trigger === "preempt") && r.to) this.alert({ kind: "fallback", key: r.sessionID, sessionID: r.sessionID, title: `Moved to ${to}`, body: [r.from && `From ${refLabel(r.from)}`, why].filter(Boolean).join(": ") })
    else if (r.trigger === "recovery" && r.to) this.alert({ kind: "return", key: r.sessionID, sessionID: r.sessionID, title: `Back on ${to}`, body: why })
    else if (r.trigger === "exhausted") this.alert({ kind: "allLimited", sessionID: r.sessionID, title: "Every provider is limited", body: "Nothing in the chain can take the request. The dashboard shows when each one is free again." })
  }

  /** What a switch costs: the new provider has no cache of the conversation, so the whole context is sent again. */
  resendNote(s: SessionState, target: ModelRef): string | undefined {
    const tokens = s.lastInputTokens ?? 0
    if (tokens < 20_000) return undefined
    const cost = this.price(target.providerID, target.id, { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 0).actual
    return `sends ${Math.round(tokens / 1000)}k tokens of context again${cost >= 0.01 ? `, about $${cost.toFixed(2)}` : ""}`
  }

  /** The user asked for a provider back (a reset, or the end of a save): sessions may return to it at their next turn. */
  settle() {
    for (const s of this.sessions.values()) s.movedAt = undefined
  }

  /** The session's current model can keep serving it: not limited, not cooling, and not passed over by a policy. */
  canStay(s: SessionState): boolean {
    const m = s.current
    if (!m || this.config.providers[m.providerID]?.allow === "never" || !this.models.has(refKey(m))) return false
    return this.poolsFor(m).every((p) => this.pools.usable(p) === "yes") && !this.gate(s)?.(m)
  }

  /**
   * Switch a session's model, remembering that the switch was ours so it is not read as a manual change.
   * Returns false in a dry run, where the switch is recorded but not made.
   */
  async switchTo(s: SessionState, target: ModelRef, trigger: string, signal?: Signal, evidence?: string): Promise<boolean> {
    const from = s.current
    if (this.config.dryRun) {
      this.recordRouting({ sessionID: s.id, trigger, from, to: target, signal, evidence })
      return false
    }
    s.pending.push({ model: target, at: Date.now() })
    s.pending = s.pending.filter((p) => Date.now() - p.at < 120_000)
    const resend = this.resendNote(s, target)
    if (resend) evidence = [evidence ?? signal?.evidence, resend].filter(Boolean).join(" · ")
    await this.ctx.session.switchModel({ sessionID: s.id, model: target })
    s.current = target
    s.movedAt = Date.now()
    if (["failover", "resume", "wait", "deferred", "preempt"].includes(trigger)) {
      if (!s.fallback && from) s.fallback = { from, reason: evidence ?? signal?.evidence, at: Date.now() }
    } else s.fallback = undefined
    this.recordRouting({ sessionID: s.id, trigger, from, to: target, signal, evidence })
    return true
  }

  // ---------- usage probes ----------

  /** Store a usage snapshot when it changed, or at most every 15 minutes when it did not. */
  private snapshot(provider: string, data: unknown, now: number) {
    const json = JSON.stringify(data)
    const last = this.lastSnapshot.get(provider)
    if (last && last.json === json && now - last.at < 15 * 60_000) return
    this.lastSnapshot.set(provider, { json, at: now })
    this.store.run("INSERT INTO usage_snapshots (at, provider, data) VALUES (?, ?, ?)", now, provider, json)
  }

  hasProvider(providerID: string) {
    for (const m of this.models.values()) if (m.providerID === providerID) return true
    return false
  }

  async probeClaude(force = false) {
    const cfg = this.config.claude
    if (!cfg.usageProbe || this.probing.claude || !this.hasProvider("claude-agent")) return
    if (!force && this.claude.nextAt && Date.now() < this.claude.nextAt) return
    this.probing.claude = true
    const now = Date.now()
    try {
      const login = await readClaudeToken()
      if (!login) {
        this.claude = { ...this.claude, at: now, ok: false, message: "Claude Code login not found", nextAt: now + 10 * 60_000 }
        return
      }
      this.claude.plan = login.plan
      if (login.expiresAt && login.expiresAt < now + 60_000) {
        this.claude = { ...this.claude, at: now, ok: false, message: "Claude Code login expired; it refreshes the next time Claude Code runs", nextAt: now + 2 * 60_000 }
        return
      }
      const res = await fetchClaudeUsage(login.token)
      if (!res.json) {
        this.claude = { ...this.claude, at: now, ok: false, message: `Usage endpoint returned HTTP ${res.status}`, nextAt: now + (res.status === 429 ? 5 * 60_000 : 2 * 60_000) }
        return
      }
      const usage = interpretClaudeUsage(res.json, now)
      this.applyClaude(usage, now)
      this.snapshot("claude-agent", usage, now)
      this.claude = { ...this.claude, at: now, ok: true, message: undefined, data: usage, nextAt: now + 30_000 }
    } catch (error) {
      this.claude = { ...this.claude, at: now, ok: false, message: String(error), nextAt: now + 2 * 60_000 }
    } finally {
      this.probing.claude = false
      this.notify("usage")
    }
  }

  applyClaude(usage: ClaudeUsage, now: number) {
    const cfg = this.config.claude
    const byPool = new Map<string, { utilization: number; resetAt?: number; label: string }>()
    for (const w of usage.windows) {
      const prev = byPool.get(w.pool)
      if (!prev || w.utilization > prev.utilization) byPool.set(w.pool, { utilization: w.utilization, resetAt: w.resetAt, label: w.label })
    }
    const cutover = cfg.avoidUsageCredits ? cfg.cutoverAtPct : 100
    for (const [pool, w] of byPool) {
      this.pools.usage(pool, {
        utilization: w.utilization,
        resetAt: w.resetAt,
        exhausted: w.utilization >= cutover,
        warn: w.utilization >= cfg.warnAtPct,
        evidence: `${w.label} at ${Math.round(w.utilization)}%`,
      })
    }
    // Credits going up means Claude Code is past a window and paying per token: move off it.
    const extra = usage.extra
    if (cfg.avoidUsageCredits && extra?.enabled && this.claude.lastExtraUsed !== undefined && extra.used > this.claude.lastExtraUsed + 0.001) {
      const tightest = [...byPool.values()].sort((a, b) => b.utilization - a.utilization)[0]
      this.pools.usage("claude-agent", {
        utilization: 100,
        resetAt: tightest?.resetAt ?? now + 15 * 60_000,
        exhausted: true,
        warn: true,
        evidence: `Usage credits being drawn (${extra.used} ${extra.currency ?? ""} used this month)`,
      })
    }
    if (extra) this.claude.lastExtraUsed = extra.used
  }

  async probeCopilot(force = false) {
    const cfg = this.config.copilot
    if (!cfg.usageProbe || this.probing.copilot || !this.ctx || !this.hasProvider("github-copilot")) return
    if (!force && this.copilot.nextAt && Date.now() < this.copilot.nextAt) return
    this.probing.copilot = true
    const now = Date.now()
    try {
      const connection = await this.ctx.integration.connection.active("github-copilot")
      const credential = connection ? await this.ctx.integration.connection.resolve(connection) : undefined
      const token = findGithubToken(credential)
      if (!token) {
        this.copilot = { at: now, ok: false, message: "No GitHub token in the Copilot connection", nextAt: now + 30 * 60_000 }
        this.log.debug("copilot credential shape", { keys: credential && typeof credential === "object" ? Object.keys(credential) : typeof credential })
        return
      }
      const res = await fetchCopilotUser(token)
      if (!res.json) {
        this.copilot = { at: now, ok: false, message: `Copilot quota endpoint returned HTTP ${res.status}`, nextAt: now + 10 * 60_000 }
        return
      }
      const quota = interpretCopilot(res.json, now, cfg.monthlyCredits)
      if (!quota) {
        this.copilot = { at: now, ok: true, message: "No metered allowance found (unlimited plan?)", nextAt: now + 30 * 60_000 }
        return
      }
      this.applyCopilot(quota, now)
      this.snapshot("github-copilot", quota, now)
      this.copilot = { at: now, ok: true, data: quota, nextAt: now + 60_000 }
    } catch (error) {
      this.copilot = { at: now, ok: false, message: String(error), nextAt: now + 5 * 60_000 }
    } finally {
      this.probing.copilot = false
      this.notify("usage")
    }
  }

  async probeOpenRouter(force = false) {
    const cfg = this.config.openrouter
    if (!cfg.usageProbe || this.probing.openrouter || !this.ctx || !this.hasProvider("openrouter")) return
    if (!force && this.openrouter.nextAt && Date.now() < this.openrouter.nextAt) return
    this.probing.openrouter = true
    const now = Date.now()
    try {
      const connection = await this.ctx.integration.connection.active("openrouter")
      const credential = connection ? await this.ctx.integration.connection.resolve(connection) : undefined
      const key = findOpenRouterKey(credential) ?? findOpenRouterKey(process.env.OPENROUTER_API_KEY)
      if (!key) {
        this.openrouter = { at: now, ok: false, message: "No OpenRouter key in the connection or in OPENROUTER_API_KEY", nextAt: now + 30 * 60_000 }
        this.log.debug("openrouter credential shape", { keys: credential && typeof credential === "object" ? Object.keys(credential) : typeof credential })
        return
      }
      const res = await fetchOpenRouterKey(key)
      const credit = res.json ? interpretOpenRouter(res.json, now) : undefined
      if (!credit) {
        // The endpoint has its own burst limit; a 429 from it says nothing about the key's credit.
        this.openrouter = { ...this.openrouter, at: now, ok: false, message: `OpenRouter key endpoint returned HTTP ${res.status}`, nextAt: now + (res.status === 429 ? 5 : 10) * 60_000 }
        return
      }
      this.applyOpenRouter(credit, now)
      this.snapshot("openrouter", credit, now)
      this.openrouter = { at: now, ok: true, data: credit, message: credit.limitUsd === undefined ? "This key has no spending limit, so there is nothing to run out of here" : undefined, nextAt: now + 60_000 }
    } catch (error) {
      this.openrouter = { ...this.openrouter, at: now, ok: false, message: String(error), nextAt: now + 5 * 60_000 }
    } finally {
      this.probing.openrouter = false
      this.notify("usage")
    }
  }

  /** OpenRouter: leave when the key's limit (or the budget above it) is spent, and `:free` models when their daily requests are. */
  applyOpenRouter(c: OpenRouterCredit, now: number) {
    const usd = (x: number) => `$${x.toFixed(2)}`
    if (c.limitUsd !== undefined && c.limitUsd > 0) {
      const remaining = c.remainingUsd ?? 0
      const exhausted = remaining <= this.config.openrouter.reserveUsd
      const what = c.scope && c.scope !== "key" ? `${c.scope} budget` : "key limit"
      this.pools.usage("openrouter", {
        utilization: Math.max(0, Math.min(100, 100 - (remaining / c.limitUsd) * 100)),
        // A limit that never resets stays spent until it is raised; look again in an hour.
        resetAt: c.resetAt ?? now + 60 * 60_000,
        exhausted,
        warn: remaining / c.limitUsd <= 0.15,
        evidence: exhausted ? `OpenRouter ${what} spent (${usd(Math.max(0, remaining))} of ${usd(c.limitUsd)} left)` : `OpenRouter ${what}: ${usd(remaining)} left`,
      })
    }
    if (c.free) {
      const d = new Date(now)
      this.pools.usage("openrouter:free", {
        utilization: Math.max(0, Math.min(100, (c.free.used / c.free.limit) * 100)),
        resetAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
        exhausted: c.free.remaining <= 0,
        warn: c.free.remaining / c.free.limit <= 0.1,
        evidence: c.free.remaining <= 0 ? `OpenRouter free-model requests used for today (${c.free.limit})` : `OpenRouter free-model requests: ${c.free.remaining} of ${c.free.limit} left today`,
      })
    }
  }

  /** ChatGPT plan windows from a response: leave before the tightest one is spent. */
  applyChatgpt(windows: CodexWindow[], now: number) {
    if (!windows.length) return
    const cfg = this.config.chatgpt
    const tightest = [...windows].sort((a, b) => b.usedPct - a.usedPct)[0]
    this.pools.usage("openai", {
      utilization: tightest.usedPct,
      resetAt: tightest.resetAt,
      exhausted: tightest.usedPct >= cfg.cutoverAtPct,
      warn: tightest.usedPct >= cfg.warnAtPct,
      evidence: `ChatGPT ${tightest.label} window at ${Math.round(tightest.usedPct)}%`,
    })
    this.snapshot("openai", { windows }, now)
    this.chatgpt = { at: now, ok: true, data: { windows } }
    this.notify("usage")
  }

  applyCopilot(q: CopilotQuota, now: number) {
    const cfg = this.config.copilot
    const reserve = Math.ceil(q.entitlement * cfg.reserveFraction)
    const exhausted = cfg.avoidAdditionalCredits ? q.remaining <= reserve || q.overageUsed > 0 : q.remaining <= 0 && !q.overagePermitted
    this.pools.usage("github-copilot", {
      utilization: Math.max(0, Math.min(100, 100 - q.percentRemaining)),
      resetAt: q.resetAt ?? nextMonthUtc(now),
      exhausted,
      warn: q.percentRemaining <= 15,
      evidence: exhausted
        ? `Included Copilot ${q.name === "ai_credits" ? "credits" : "allowance"} used (${Math.round(q.remaining)} of ${q.entitlement} left${q.overageUsed ? `, ${Math.round(q.overageUsed)} beyond` : ""})`
        : `Copilot ${q.name === "ai_credits" ? "credits" : "allowance"} ${Math.round(q.percentRemaining)}% left`,
    })
  }

  /** Called at each turn: refresh usage that is older than the configured age, waiting briefly for it. */
  async freshUsage(providers: string[]) {
    const maxAge = this.config.probes.maxAgeAtTurnMs
    const tasks: Promise<void>[] = []
    if (providers.includes("claude-agent") && (!this.claude.at || Date.now() - this.claude.at > maxAge)) tasks.push(this.probeClaude(true))
    if (providers.includes("github-copilot") && (!this.copilot.at || Date.now() - this.copilot.at > maxAge)) tasks.push(this.probeCopilot(true))
    if (providers.includes("openrouter") && (!this.openrouter.at || Date.now() - this.openrouter.at > Math.max(maxAge, 2 * 60_000))) tasks.push(this.probeOpenRouter(true))
    if ((["ollama", "lmstudio"] as const).some((k) => providers.includes(k) && Date.now() - (this.local.get(k)?.at ?? 0) > Math.min(maxAge, 60_000))) tasks.push(this.probeLocal(true))
    if (tasks.length) await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 2500))])
  }

  startTimers() {
    if (this.timers.length) return
    const tick = () => {
      const active = this.recorder.live.size > 0 || Date.now() - this.lastActivity < 10 * 60_000
      const interval = active ? this.config.probes.activeIntervalMs : this.config.probes.idleIntervalMs
      if (!this.claude.at || Date.now() - this.claude.at >= interval) void this.probeClaude(true)
      const copilotBusy = [...this.recorder.live.values()].some((e) => e.step?.model?.providerID === "github-copilot")
      if (!this.copilot.at || Date.now() - this.copilot.at >= (copilotBusy ? 60_000 : interval)) void this.probeCopilot(true)
      if (!this.openrouter.at || Date.now() - this.openrouter.at >= interval) void this.probeOpenRouter(true)
      // A server that was down is looked at every tick, so it is used again soon after it starts.
      const localAt = Math.min(...[...this.local.values()].map((l) => l.at ?? 0), this.local.size ? Infinity : 0)
      if (Object.keys(this.localDown()).length || Date.now() - localAt >= (active ? 60_000 : interval)) void this.probeLocal(true)
      void this.refreshModels()
      this.maintain()
      this.checkAlerts()
      void this.telemetry.tick()
      this.notify("tick")
    }
    const t = setInterval(tick, 30_000)
    ;(t as { unref?: () => void }).unref?.()
    this.timers.push(t)
    setTimeout(tick, 3_000)
  }

  /** Keep rollups and session totals current; prune and optimise once a day. Never throws. */
  maintain(force = false) {
    if (this.maintaining) return
    this.maintaining = true
    try {
      let changed = 0
      for (let i = 0; i < 50; i++) {
        const n = rollupDirty(this.store)
        changed += n
        if (n === 0) break
      }
      for (let i = 0; i < 50; i++) {
        const n = refreshSessions(this.store)
        changed += n
        if (n === 0) break
      }
      if (changed) this.notify("rollup")
      const last = Number(this.store.meta("last_maintenance") ?? 0)
      if (force || Date.now() - last > 24 * 3_600_000) {
        prune(this.store, Date.now(), this.config.retention)
        optimize(this.store)
        this.store.setMeta("last_maintenance", String(Date.now()))
        this.log.info("maintenance", { retention: this.config.retention })
      }
    } catch (error) {
      this.log.error("maintenance failed", { error: String(error) })
    } finally {
      this.maintaining = false
    }
  }

  stopTimers() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  poolsFor(model: ModelRef) {
    return modelPools(model.providerID, model.id)
  }
}
