// Process-wide state shared by every plugin instance: pools, sessions, store, usage probes, dashboard.
import path from "node:path"
import { loadConfig, refKey, refLabel, type Config } from "./config.ts"
import { modelPools } from "./classify.ts"
import { Store } from "./db.ts"
import { dataDir, Logger } from "./log.ts"
import { PoolStore } from "./pools.ts"
import { estimate } from "./pricing.ts"
import { fetchClaudeUsage, interpretClaudeUsage, readClaudeToken, type ClaudeUsage } from "./probes/claude.ts"
import { fetchCopilotUser, findGithubToken, interpretCopilot, type CopilotQuota } from "./probes/copilot.ts"
import { markDirty, optimize, prune, refreshSessions, rollupDirty } from "./maintenance.ts"
import { Recorder } from "./recorder.ts"
import { nextMonthUtc } from "./resets.ts"
import { findInChains, type Preferred } from "./router.ts"
import type { ModelInfo, ModelRef, PoolState, Signal, Tokens } from "./types.ts"

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
  claude: ProbeStatus<ClaudeUsage> & { lastExtraUsed?: number } = { ok: false }
  copilot: ProbeStatus<CopilotQuota> = { ok: false }
  dashboardURL?: string
  private listeners = new Set<(kinds: string[]) => void>()
  private pendingKinds = new Set<string>()
  private notifyTimer?: ReturnType<typeof setTimeout>
  private timers: Array<ReturnType<typeof setInterval>> = []
  private probing = { claude: false, copilot: false }
  private lastSnapshot = new Map<string, { json: string; at: number }>()
  private maintaining = false
  shutdown?: () => Promise<void>

  private constructor(store: Store, log: Logger, options: unknown) {
    const { config, warnings } = loadConfig(options)
    this.config = config
    this.warnings = warnings
    this.log = log
    this.store = store
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
    this.recorder = new Recorder(store, (p, m, t, r) => this.price(p, m, t, r), (id) => void this.fetchSession(id), (k) => this.notify(k))
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
    const { config, warnings } = loadConfig(options)
    this.config = config
    this.warnings = warnings
    this.pools.setConfig(config)
    this.log.setLevel(config.log.level)
    for (const w of warnings) this.log.warn("config", { warning: w })
    // Chains may have changed: re-resolve each session's preference.
    for (const s of this.sessions.values()) if (s.preferred) s.preferred = this.preferredFor(s.preferred.model)
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
        })
      }
      if (next.size > 0) {
        this.models = next
        this.modelsAt = Date.now()
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
        } catch {}
      }
      this.sessions.set(id, s)
    }
    return s
  }

  savePrefs(s: SessionState) {
    this.store.run(
      "INSERT INTO session_prefs (id, data, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
      s.id, JSON.stringify({ pinned: s.pinned, preferred: s.preferred?.model }), Date.now(),
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
    this.store.run(
      "INSERT INTO routing (at, session_id, trigger, kind, from_model, to_model, pool, until, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      at, r.sessionID, r.trigger, r.kind ?? r.signal?.kind, r.from && refLabel(r.from), r.to && refLabel(r.to), r.signal?.pools.join(","),
      r.until ?? r.signal?.resetAt, r.evidence ?? r.signal?.evidence,
    )
    if (r.sessionID) markDirty(this.store, r.sessionID, undefined)
    this.log.info("route", { sessionID: r.sessionID, trigger: r.trigger, from: r.from && refLabel(r.from), to: r.to && refLabel(r.to), evidence: r.evidence ?? r.signal?.evidence })
    this.notify("routing")
  }

  /** Switch a session's model, remembering that the switch was ours so it is not read as a manual change. */
  async switchTo(s: SessionState, target: ModelRef, trigger: string, signal?: Signal, evidence?: string) {
    const from = s.current
    s.pending.push({ model: target, at: Date.now() })
    s.pending = s.pending.filter((p) => Date.now() - p.at < 120_000)
    await this.ctx.session.switchModel({ sessionID: s.id, model: target })
    s.current = target
    if (["failover", "resume", "wait", "deferred", "preempt"].includes(trigger)) {
      if (!s.fallback && from) s.fallback = { from, reason: evidence ?? signal?.evidence, at: Date.now() }
    } else s.fallback = undefined
    this.recordRouting({ sessionID: s.id, trigger, from, to: target, signal, evidence })
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
      void this.refreshModels()
      this.maintain()
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
