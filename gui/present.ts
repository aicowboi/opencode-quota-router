// What the menu bar shows, from the dashboard's /api/menubar payload. Pure, so it can be tested without Electron.

export type Tone = "ok" | "warn" | "bad" | "idle"
export type Item = { label: string; sublabel?: string; enabled?: boolean; action?: Action; submenu?: Item[]; checked?: boolean }
export type Action = { kind: "dashboard" } | { kind: "opencode" } | { kind: "probe" } | { kind: "pause" } | { kind: "resume" }
export type View = { title: string; tooltip: string; fraction: number; ring: Tone; dot?: Tone; sections: Item[][] }

export type Menubar = {
  now: number
  paused: boolean
  url?: string
  claude?: { windows: Array<{ pool: string; label: string; utilization: number; resetAt?: number }>; extra?: { enabled: boolean; used: number; limit?: number; currency?: string } }
  copilot?: { name: string; plan?: string; entitlement: number; used?: number; remaining: number; overageUsed: number; resetAt?: number }
  providers: Array<{ id: string; priority: number; kind: string; status: string; until?: number; evidence?: string; serving: number }>
  live: Array<{ title: string; project?: string; startedAt: number; model?: string; fallback?: string }>
  today: { tokens: number; equiv: number; actual: number; steps: number }
  alerts?: Array<{ id: number; at: number; kind: string; title: string; body?: string }>
  last?: { at: number; trigger: string; from_model?: string; to_model?: string; evidence?: string; title?: string }
}

const NAMES: Record<string, [string, string]> = {
  "claude-agent": ["Claude subscription", "Claude"],
  xai: ["xAI SuperGrok", "xAI"],
  "github-copilot": ["GitHub Copilot", "Copilot"],
  anthropic: ["Anthropic API", "Anthropic API"],
  openai: ["OpenAI API", "OpenAI API"],
}
const name = (id: string) => NAMES[id]?.[0] ?? id
const short = (id: string) => NAMES[id]?.[1] ?? id
const TRIGGERS: Record<string, string> = {
  failover: "Fell back", recovery: "Returned", preempt: "Moved early", route: "Routed", resume: "Continued", wait: "Waiting",
  deferred: "Scheduled", exhausted: "All limited", manual: "You switched", "gave-up": "Stopped",
}

export function fmtN(x: number): string {
  const a = Math.abs(x)
  return a >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : a >= 1e4 ? `${Math.round(x / 1e3)}K` : a >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : String(Math.round(x))
}
export const fmtUSD = (x: number) => (x >= 100 ? `$${Math.round(x)}` : x >= 1 ? `$${x.toFixed(2)}` : x > 0 ? `$${x.toFixed(3)}` : "$0")
export function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`
}
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
function when(t: number, now: number): string {
  const d = new Date(t)
  const n = new Date(now)
  if (d.toDateString() === n.toDateString()) return time(t)
  if (t - now < 6 * 86_400_000 && t > now) return `${d.toLocaleDateString([], { weekday: "short" })} ${time(t)}`
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time(t)}`
}
const money = (v: number, cur?: string) => {
  try {
    return new Intl.NumberFormat([], { style: "currency", currency: cur || "USD" }).format(v)
  } catch {
    return `${v.toFixed(2)} ${cur ?? ""}`
  }
}

export function present(data: Menubar | undefined, cutoverAtPct = 98): View {
  if (!data) {
    return {
      title: "",
      tooltip: "Quota Router: OpenCode's plugin is not reachable",
      fraction: 0,
      ring: "idle",
      sections: [[{ label: "Quota Router is not reachable", sublabel: "Waiting for the OpenCode server", enabled: false }], [{ label: "Open OpenCode", action: { kind: "opencode" } }]],
    }
  }
  const now = data.now
  const session = data.claude?.windows.find((w) => w.pool === "claude-agent" && w.label.startsWith("5-hour"))
  const pct = session ? Math.round(session.utilization) : undefined
  const top = data.providers[0]
  const topLimited = top && (top.status === "cooling" || top.status === "blocked") && (top.until ?? 0) > now ? top : undefined
  const serving = data.providers.filter((p) => p.serving > 0)
  const onFallback = data.live.filter((l) => l.fallback)

  // Menu bar text: short enough to sit next to the clock.
  let title: string
  let ring: Tone
  if (data.paused) {
    title = "Paused"
    ring = "idle"
  } else if (topLimited) {
    const now2 = serving.find((p) => p.id !== top.id) ?? data.providers.find((p) => p.status === "available")
    title = `${now2 ? short(now2.id) : "Limited"} · ${short(top.id)} in ${fmtDur((topLimited.until ?? now) - now)}`
    ring = "bad"
  } else {
    title = pct !== undefined ? `${pct}%` : ""
    ring = pct === undefined ? "idle" : pct >= cutoverAtPct ? "bad" : pct >= 85 ? "warn" : "ok"
  }
  const dot: Tone | undefined = onFallback.length ? "warn" : data.live.length ? "ok" : undefined

  // Headline, as on the dashboard.
  let headline: string
  if (data.paused) headline = "Routing is paused"
  else if (topLimited) headline = `${name(top.id)} is limited until ${when(topLimited.until!, now)}`
  else if (serving.length) headline = serving.map((p) => `${name(p.id)} is serving ${p.serving}`).join(", ")
  else headline = "Nothing running"
  const headSub = topLimited?.evidence ?? (pct !== undefined && session?.resetAt ? `5-hour window ${pct}% used, resets ${time(session.resetAt)}` : undefined)

  const allowances: Item[] = []
  for (const w of data.claude?.windows ?? []) {
    const label = w.label === "5-hour session" ? "Claude 5-hour" : w.label === "Weekly (all models)" ? "Claude weekly" : `Claude ${w.label.replace("Weekly (", "").replace(")", "")} weekly`
    allowances.push({ label: `${label} — ${Math.round(w.utilization)}%`, sublabel: w.resetAt ? `Resets ${when(w.resetAt, now)}` : undefined, enabled: false })
  }
  const e = data.claude?.extra
  if (e?.enabled) allowances.push({ label: `Usage credits — ${money(e.used, e.currency)}${e.limit !== undefined ? ` of ${money(e.limit, e.currency)}` : ""}`, sublabel: "Routing moves on before these are drawn", enabled: false })
  const cp = data.copilot
  if (cp) {
    const used = cp.used ?? cp.entitlement - cp.remaining
    const d = new Date(now)
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    const end = cp.resetAt ?? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    const pace = used / Math.max(0.03, (now - start) / (end - start))
    allowances.push({
      label: `Copilot ${cp.name === "ai_credits" ? "credits" : "requests"} — ${Math.round(used).toLocaleString()} / ${Math.round(cp.entitlement).toLocaleString()}`,
      sublabel: `${Math.round(Math.max(0, cp.entitlement - used)).toLocaleString()} left · on pace for ${Math.round(pace).toLocaleString()} by ${new Date(end - 1).toLocaleDateString([], { day: "numeric", month: "short" })}`,
      enabled: false,
    })
  }

  const route: Item[] = data.providers.map((p) => {
    const state =
      (p.status === "cooling" || p.status === "blocked") && (p.until ?? 0) > now
        ? `Limited until ${when(p.until!, now)}`
        : p.serving
          ? `Serving ${p.serving}`
          : p.status === "degraded"
            ? "Near its limit"
            : "Available"
    return { label: `${p.priority}  ${name(p.id)}`, sublabel: p.evidence && state.startsWith("Limited") ? `${state} · ${p.evidence}` : state, enabled: false, checked: p.serving > 0 }
  })
  const running: Item[] = data.live.map((l) => ({
    label: l.title.length > 60 ? `${l.title.slice(0, 57)}…` : l.title,
    sublabel: `${l.model ?? "?"} · ${fmtDur(now - l.startedAt)}${l.fallback ? ` · fallback from ${l.fallback}` : ""}`,
    enabled: false,
  }))

  const activity: Item[] = [
    { label: "Route", submenu: route },
    running.length ? { label: `Running — ${running.length}`, submenu: running } : { label: "Nothing running", enabled: false },
    { label: `Today — ${fmtN(data.today.tokens)} tokens`, sublabel: `${fmtUSD(data.today.equiv)} at API prices · ${fmtUSD(data.today.actual)} spent`, enabled: false },
  ]
  if (data.last)
    activity.push({
      label: `${TRIGGERS[data.last.trigger] ?? data.last.trigger} ${data.last.to_model ? `to ${data.last.to_model}` : ""} · ${when(data.last.at, now)}`,
      sublabel: data.last.evidence ?? data.last.title,
      enabled: false,
    })

  // Notifications from the last day, newest first.
  const alerts: Item[] = (data.alerts ?? []).map((a) => ({ label: `${a.title} · ${when(a.at, now)}`, sublabel: a.body, enabled: false }))
  if (alerts.length) activity.push({ label: `Notifications — ${alerts.length}`, submenu: alerts })

  return {
    title,
    tooltip: [headline, headSub].filter(Boolean).join(" — "),
    fraction: pct !== undefined ? pct / 100 : 0,
    ring,
    dot,
    sections: ([
      [{ label: headline, sublabel: headSub, enabled: false }],
      allowances,
      activity,
      [
        { label: "Open Dashboard", action: { kind: "dashboard" } },
        { label: "Open OpenCode", action: { kind: "opencode" } },
        { label: "Check Usage Now", action: { kind: "probe" } },
        data.paused ? { label: "Resume Routing", action: { kind: "resume" } } : { label: "Pause Routing", action: { kind: "pause" } },
      ],
    ] as Item[][]).filter((s) => s.length > 0),
  }
}
