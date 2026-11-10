// Local-only dashboard server. Binds to 127.0.0.1, checks the Host header (DNS rebinding) and requires a
// custom header on actions (cross-site requests cannot send one without a preflight we never allow).
import { unreliable } from "../engine/health.ts"
import { localNote } from "../probes/local.ts"
import http from "node:http"
import { refLabel } from "../engine/config.ts"
import { VERSION, type Core } from "../core.ts"
import { planAdvice } from "../advisor.ts"
import { runDoctor } from "../doctor.ts"
import { claudePlan } from "../engine/plans.ts"
import { orderedChain } from "../engine/router.ts"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as q from "./queries.ts"

const PAGE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "page.html")
/** Read on each request (it is small), so design changes show on reload. */
const page = () => fs.readFileSync(PAGE_FILE, "utf8")

/** Compact status for the macOS menu bar. */
export function buildMenubar(core: Core) {
  const now = Date.now()
  const live = [...core.recorder.live.values()]
  const today = q.summary(core.store, q.resolveRange("today", now))
  const last = core.store.get<Record<string, any>>("SELECT r.at, r.trigger, r.from_model, r.to_model, r.evidence, se.title FROM routing r LEFT JOIN sessions se ON se.id = r.session_id ORDER BY r.id DESC LIMIT 1")
  const title = (id: string) => core.store.get<{ title: string; directory: string }>("SELECT title, directory FROM sessions WHERE id = ?", id)
  const saved = core.saved(now)
  const providers = Object.entries(core.config.providers)
    .sort((a, b) => a[1].priority - b[1].priority)
    .filter(([id]) => core.hasProvider(id))
    .map(([id, p]) => {
      const pools = core.pools.all().filter((x) => x.id === id || x.id.startsWith(`${id}:`))
      const limited = pools.find((x) => (x.status === "cooling" || x.status === "blocked") && (x.until ?? 0) > now)
      return {
        id,
        priority: p.priority,
        kind: p.kind,
        status: limited ? limited.status : pools.some((x) => x.status === "degraded") ? "degraded" : "available",
        until: limited?.until,
        evidence: limited?.evidence,
        saved: saved[id] as number | undefined,
        serving: live.filter((e) => e.step?.model?.providerID === id || core.sessions.get(e.sessionID)?.current?.providerID === id).length,
      }
    })
  return {
    now,
    paused: core.paused,
    dryRun: core.config.dryRun,
    url: core.dashboardURL,
    claude: core.claude.data ? { windows: core.claude.data.windows, extra: core.claude.data.extra, at: core.claude.at } : undefined,
    chatgpt: core.chatgptActive() && core.chatgpt.data ? { windows: core.chatgpt.data.windows, at: core.chatgpt.at } : undefined,
    copilot: core.copilot.data ? { ...core.copilot.data, at: core.copilot.at } : undefined,
    providers,
    live: live.map((e) => {
      const s = core.sessions.get(e.sessionID)
      const info = title(e.sessionID)
      const model = e.step?.model ?? s?.current
      return { title: info?.title ?? e.sessionID, project: info?.directory, startedAt: e.startedAt, model: model ? refLabel(model) : undefined, fallback: s?.fallback ? refLabel(s.fallback.from) : undefined }
    }),
    today: { tokens: today.tokens ?? 0, equiv: today.equiv ?? 0, actual: today.actual ?? 0, steps: today.steps ?? 0 },
    last,
    alerts: core.alerts({ limit: 5 }).alerts.filter((a) => a.at > now - 86_400_000).reverse(),
  }
}

export function buildState(core: Core) {
  const now = Date.now()
  const sessionInfo = (id: string) =>
    core.store.get<{ title: string; directory: string; parent_id: string; agent: string }>("SELECT title, directory, parent_id, agent FROM sessions WHERE id = ?", id)
  const live = [...core.recorder.live.values()].map((e) => {
    const info = sessionInfo(e.sessionID)
    const s = core.sessions.get(e.sessionID)
    return {
      sessionID: e.sessionID,
      title: info?.title,
      directory: info?.directory,
      parentID: info?.parent_id ?? s?.parentID,
      agent: e.step?.agent ?? info?.agent,
      startedAt: e.startedAt,
      model: e.step?.model ? refLabel(e.step.model) : s?.current ? refLabel(s.current) : undefined,
      stepStartedAt: e.step?.startedAt,
      tools: e.tools,
      retry: e.retry,
      fallback: s?.fallback ? { from: refLabel(s.fallback.from), reason: s.fallback.reason, at: s.fallback.at } : undefined,
    }
  })
  const providers = Object.entries(core.config.providers)
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([id, p]) => ({
      id,
      ...p,
      connected: core.hasProvider(id),
      pools: core.pools.all().filter((x) => x.id === id || x.id.startsWith(`${id}:`)),
      serving: live.filter((l) => l.model?.startsWith(`${id}/`)).length,
    }))
  return {
    now,
    version: VERSION,
    started: core.started,
    paused: core.paused,
    enabled: core.config.enabled,
    dryRun: core.config.dryRun,
    providers,
    plans: { claude: core.hasProvider("claude-agent") ? claudePlan(core.config.claude.plan || core.claude.plan?.type, core.claude.plan?.tier)?.name : undefined },
    claude: { ok: core.claude.ok, at: core.claude.at, message: core.claude.message, data: core.claude.data, enabled: core.config.claude.usageProbe, cutoverAtPct: core.config.claude.cutoverAtPct },
    copilot: { ok: core.copilot.ok, at: core.copilot.at, message: core.copilot.message, data: core.copilot.data, enabled: core.config.copilot.usageProbe, reserveFraction: core.config.copilot.reserveFraction, economyAtPct: core.config.copilot.economyAtPct, byModel: core.copilot.data ? q.copilotCredits(core.store, Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)) : [] },
    openrouter: { ok: core.openrouter.ok, at: core.openrouter.at, message: core.openrouter.message, data: core.openrouter.data, enabled: core.config.openrouter.usageProbe },
    chatgpt: { active: core.chatgptActive(), at: core.chatgpt.at, data: core.chatgpt.data, cutoverAtPct: core.config.chatgpt.cutoverAtPct },
    saved: core.saved(now),
    spend: { ...core.config.spend, ...core.spend(now), blocked: core.spendBlocks(now) },
    suggestions: core.suggestions(),
    added: core.chainAdditions(),
    live,
    agents: core.config.agents,
    pace: core.config.pace,
    forecasts: core.forecasts(now),
    learned: core.learned(now),
    health: Object.fromEntries(Object.entries(core.health(now)).map(([id, h]) => [id, { ...h, unreliable: core.config.health.enabled && unreliable(core.config, h) }])),
    local: Object.fromEntries([...core.local].map(([kind, l]) => [kind, { at: l.at, running: l.data?.running, message: l.message, models: (l.data?.models ?? []).map((m) => ({ ...m, note: localNote(m, core.totalMemory) })) }])),
    chains: Object.fromEntries(Object.keys(core.config.chains).map((name) => [name, orderedChain(core.config, name).map(refLabel)])),
    warnings: core.warnings,
  }
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>
type Listener = {
  server: http.Server
  url: string
  handler?: Handler
  clients: Set<http.ServerResponse>
  unsubscribe?: () => void
}
/**
 * One HTTP listener per OpenCode process, kept across core rebuilds (code reloads swap its handler). Closing and
 * re-binding the port on every reload races with browsers' keep-alive connections, which would keep reaching the old
 * handler after its database closed.
 */
const LISTENER = Symbol.for("opencode-quota-router.http")
const registry = globalThis as Record<symbol, Listener | undefined>

function makeHandler(core: Core, clients: Set<http.ServerResponse>): Handler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "")
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostHeader)) {
      res.writeHead(403)
      return res.end("Forbidden")
    }
    try {
      const range = url.searchParams.get("range") ?? "7d"
      const r = q.resolveRange(range)
      const num = (name: string, fallback: number) => {
        const v = Number(url.searchParams.get(name))
        return Number.isFinite(v) && v > 0 ? v : fallback
      }
      switch (url.pathname) {
        case "/":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
          return res.end(page())
        case "/api/ping":
          return json(res, { app: "quota-router", pid: process.pid })
        case "/api/state":
          return json(res, buildState(core))
        case "/api/advice":
          return json(res, planAdvice(core))
        case "/api/doctor":
          return json(res, { at: Date.now(), checks: runDoctor(core) })
        case "/api/notifications":
          return json(res, core.alerts({ after: url.searchParams.has("after") ? num("after", 0) : undefined, limit: num("limit", 50) }))
        case "/api/menubar":
          return json(res, buildMenubar(core))
        case "/api/summary":
          return json(res, q.summary(core.store, r))
        case "/api/series":
          return json(res, q.series(core.store, r))
        case "/api/breakdown":
          return json(res, q.breakdown(core.store, r, url.searchParams.get("by") ?? "model", num("limit", 25)))
        case "/api/tools":
          return json(res, q.tools(core.store, r, num("limit", 25)))
        case "/api/sessions":
          return json(
            res,
            q.sessions(core.store, r, {
              cursor: url.searchParams.get("cursor") ?? undefined,
              q: url.searchParams.get("q")?.trim() || undefined,
              limit: num("limit", 25),
              project: url.searchParams.has("project") ? (url.searchParams.get("project") ?? "") : undefined,
              day: url.searchParams.get("day") ?? undefined,
            }),
          )
        case "/api/sessions/groups":
          return json(res, q.sessionGroups(core.store, r, url.searchParams.get("by") === "day" ? "day" : "project", url.searchParams.get("q")?.trim() || undefined))
        case "/api/routing/days":
          return json(res, q.routingDays(core.store, r, { filter: url.searchParams.get("filter") ?? undefined, before: url.searchParams.get("before") ?? undefined }))
        case "/api/routing/summary":
          return json(res, q.routingSummary(core.store, r))
        case "/api/routing/groups":
          return json(
            res,
            q.routingGroups(core.store, r, { filter: url.searchParams.get("filter") ?? undefined, before: num("before", 0) || undefined, day: url.searchParams.get("day") ?? undefined, limit: num("limit", 20) }),
          )
        case "/api/routing/events":
          return json(
            res,
            q.routingEvents(core.store, {
              day: url.searchParams.get("day") ?? "",
              trigger: url.searchParams.get("trigger") ?? "",
              from: url.searchParams.get("from") ?? "",
              to: url.searchParams.get("to") ?? "",
              beforeId: num("before", 0) || undefined,
            }),
          )
        case "/api/pools":
          return json(res, q.poolHistory(core.store, r.fromMs))
        case "/api/usage-history":
          return json(res, q.usageHistory(core.store, url.searchParams.get("provider") ?? "claude-agent", r.name === "today" ? Date.now() - 86_400_000 : r.fromMs))
        case "/api/export.csv": {
          const table = url.searchParams.get("table") ?? "steps"
          res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="quota-router-${table}-${range}.csv"` })
          for (const chunk of q.csv(core.store, table, r.fromMs)) res.write(chunk)
          return res.end()
        }
        case "/api/stream": {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
          res.write(`event: hello\ndata: {}\n\n`)
          clients.add(res)
          const ping = setInterval(() => res.write(`: ping\n\n`), 15_000)
          req.on("close", () => {
            clearInterval(ping)
            clients.delete(res)
          })
          return
        }
        case "/api/action": {
          if (req.method !== "POST" || req.headers["x-quota-router"] !== "1") return json(res, { error: "Forbidden" }, 403)
          let body = ""
          for await (const chunk of req) body += chunk
          const a = JSON.parse(body || "{}")
          if (a.action === "reset-pool" && typeof a.pool === "string") {
            core.pools.reset(a.pool, "dashboard")
            core.settle()
          } else if (a.action === "pause") core.paused = true
          else if (a.action === "resume") core.paused = false
          else if (a.action === "dry-run" && typeof a.on === "boolean") core.setSetting("dryRun", a.on)
          else if (a.action === "save" && typeof a.provider === "string" && core.config.providers[a.provider] && Number.isFinite(a.minutes) && a.minutes >= 1 && a.minutes <= 7 * 1440)
            core.save(a.provider, Date.now() + Math.round(a.minutes) * 60_000)
          else if (a.action === "unsave" && typeof a.provider === "string") core.save(a.provider)
          else if (a.action === "probe") await Promise.allSettled([core.probeClaude(true), core.probeCopilot(true)])
          else if (["chain-add", "chain-ignore", "chain-remove"].includes(a.action) && typeof a.chain === "string" && typeof a.ref === "string" && core.config.chains[a.chain] && /^[^/\s]+\/[^\s]+$/.test(a.ref))
            core.changeChain(a.action.slice(6) as "add" | "ignore" | "remove", a.chain, a.ref)
          else return json(res, { error: "Unknown action" }, 400)
          core.log.info("dashboard action", { action: a.action, pool: a.pool })
          core.notify("pools")
          return json(res, { ok: true })
        }
      }
      res.writeHead(404)
      res.end("Not found")
    } catch (error) {
      core.log.error("dashboard request failed", { path: url.pathname, error: String(error) })
      json(res, { error: "Internal error" }, 500)
    }
  }
}

export async function startDashboard(core: Core): Promise<{ url: string; close: () => Promise<void>; stop: () => Promise<void> } | undefined> {
  const { host, port } = core.config.dashboard
  let l = registry[LISTENER]
  if (!l) {
    for (let attempt = 0; attempt < 5 && !l; attempt++) {
      const p = port + attempt
      const server = http.createServer((req, res) => {
        const h = registry[LISTENER]?.handler
        if (h) return void h(req, res)
        res.writeHead(503, { "retry-after": "1" })
        res.end("Restarting")
      })
      server.keepAliveTimeout = 5_000
      const ok = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false))
        server.listen(p, host, () => resolve(true))
      })
      if (ok) l = registry[LISTENER] = { server, url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${p}`, clients: new Set() }
      else {
        // Another OpenCode process may already serve it from the same database.
        const other = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(1000) })
          .then((r) => r.json() as Promise<{ app?: string; pid?: number }>)
          .catch(() => undefined)
        if (other?.app === "quota-router" && other.pid !== process.pid) {
          core.log.info("dashboard served by another process", { port: p, pid: other.pid })
          return { url: `http://127.0.0.1:${p}`, close: async () => {}, stop: async () => {} }
        }
      }
    }
    if (!l) {
      core.log.warn("dashboard could not bind a port", { port })
      return undefined
    }
  }
  const listener = l
  listener.unsubscribe?.()
  listener.unsubscribe = core.subscribe((kinds) => {
    for (const c of listener.clients) c.write(`event: change\ndata: ${JSON.stringify(kinds)}\n\n`)
  })
  listener.handler = makeHandler(core, listener.clients)
  core.log.info("dashboard", { url: listener.url })
  return {
    url: listener.url,
    // Detach this core; the listener stays up for the next one.
    close: async () => {
      if (registry[LISTENER] !== listener) return
      listener.unsubscribe?.()
      listener.unsubscribe = undefined
      listener.handler = undefined
    },
    // Plugin removed: release the port and every connection.
    stop: async () => {
      if (registry[LISTENER] !== listener) return
      registry[LISTENER] = undefined
      listener.unsubscribe?.()
      for (const c of listener.clients) c.end()
      const server = listener.server as http.Server & { closeAllConnections?: () => void }
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
        setTimeout(resolve, 2_000)
      })
    },
  }
}
