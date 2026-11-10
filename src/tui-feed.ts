// What the terminal part of quota-router reads from the local dashboard: the notification feed, shown as toasts, and
// the status feed, shown as one line in the prompt footer. Nothing here draws; `tui.tsx` does, and tests use this file.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type Toast = { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number; sessionID?: string }
type Alert = { id: number; kind: string; title: string; body?: string; sessionID?: string }
export type Feed = { alerts: Alert[]; last: number }

const VARIANT: Record<string, Toast["variant"]> = { fallback: "warning", return: "success", allLimited: "error", spendCap: "warning", usageCheck: "warning" }

/**
 * Follow the feed and show each new alert once. The first read only notes where the feed is, so alerts raised before
 * the terminal opened are not replayed. Returns a function that reads once, for the timer and for tests.
 */
export function follower(read: (after?: number) => Promise<Feed | undefined>, show: (toast: Toast) => void) {
  let last: number | undefined
  return async () => {
    const feed = await read(last).catch(() => undefined)
    if (!feed) return
    if (last !== undefined) {
      for (const a of feed.alerts) show({ title: a.title, message: a.body || a.title, variant: VARIANT[a.kind] ?? "info", duration: 8000, ...(a.sessionID ? { sessionID: a.sessionID } : {}) })
    }
    // A smaller number means the database was replaced; start again from there.
    last = feed.last
  }
}

/** One provider as the status line shows it. Written by `buildStatus` on the server. */
export type StatusEntry = {
  provider: string
  /** Highest known use of the provider's windows, 0 to 100. Absent when the provider reports none. */
  pct?: number
  /** The provider is limited now, so the session is waiting for it. */
  limited?: boolean
  /** When a limited provider is expected back. */
  until?: number
  /** Set while the session runs on a fallback: the provider it left, and when that one is expected back. */
  from?: string
  fromUntil?: number
}
export type StatusFeed = {
  now: number
  /** False when `statusLine` is turned off, or the router itself is. */
  enabled: boolean
  paused: boolean
  dryRun: boolean
  /** The first provider in priority order that can be used now, for a prompt with no routed session. */
  top?: StatusEntry
  sessions: Record<string, StatusEntry>
}
export type Tone = "muted" | "warning" | "error"

const clock = (at: number, now: number) => {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return at - now < 20 * 3_600_000 ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`
}

/**
 * The footer text for one prompt: the provider the session is on and how full its window is. Undefined when there is
 * nothing to show (no feed, the line is turned off, or nothing is known about any provider).
 */
export function statusLine(feed: StatusFeed | undefined, sessionID?: string, time: (at: number, now: number) => string = clock): { text: string; tone: Tone } | undefined {
  if (!feed?.enabled) return
  const e = (sessionID && feed.sessions[sessionID]) || feed.top
  if (!e) return
  const now = feed.now
  const parts = [`${e.provider}${e.pct === undefined ? "" : ` ${Math.round(e.pct)}%`}`]
  if (e.limited) parts[0] += e.until && e.until > now ? ` limited until ${time(e.until, now)}` : " limited"
  if (e.from) parts.push(`${e.from} back ${e.fromUntil && e.fromUntil > now ? time(e.fromUntil, now) : "soon"}`)
  if (feed.paused) parts.push("paused")
  if (feed.dryRun) parts.push("dry run")
  return { text: parts.join(" · "), tone: e.limited ? "error" : e.from || (e.pct ?? 0) >= 90 ? "warning" : "muted" }
}

/**
 * The file where the server part notes its dashboard's address. The terminal part and the command line don't get the
 * plugin's options (a custom `dashboard.port`), so they look here first.
 */
export const dashboardFile = (env: Record<string, string | undefined> = process.env) => pluginFile("dashboard.json", env)

/** A file in the plugin's data folder, found the same way the plugin finds it. */
export const pluginFile = (name: string, env: Record<string, string | undefined> = process.env) =>
  path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode-quota-router", name)

/** The port in the dashboard file, when there is one and it is a local address. */
export function notedPort(file = dashboardFile()): number | undefined {
  try {
    const url = new URL(JSON.parse(fs.readFileSync(file, "utf8")).url)
    const port = Number(url.port)
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && port > 0 && port < 65536 ? port : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads one of the dashboard's feeds: at the port the dashboard file names, else at `basePort` and the next few (the
 * dashboard takes the next free port when its own is taken).
 */
export function reader(basePort: number, get: typeof fetch = fetch, noted: () => number | undefined = notedPort) {
  let base: string | undefined
  return async <T>(path: string, ok: (body: any) => boolean): Promise<T | undefined> => {
    const hint = base ? undefined : noted()
    const ports = base ? [Number(new URL(base).port)] : [...new Set([...(hint ? [hint] : []), ...Array.from({ length: 5 }, (_, i) => basePort + i)])]
    for (const port of ports) {
      const url = `http://127.0.0.1:${port}`
      try {
        const r = await get(`${url}${path}`, { signal: AbortSignal.timeout(2000) })
        if (!r.ok) continue
        const body = await r.json()
        if (!ok(body)) continue
        base = url
        return body as T
      } catch {}
    }
    base = undefined
    return undefined
  }
}
