// Notifications: things worth knowing about without watching the dashboard. Each is stored once, rate-limited per
// kind, and read by the dashboard, the menu bar and the terminal through one feed.
import { execFile } from "node:child_process"
import type { Config } from "./engine/config.ts"
import type { Store } from "./db.ts"

export type AlertKind = "fallback" | "return" | "allLimited" | "spendCap" | "usageCheck"
export type Alert = { id: number; at: number; kind: AlertKind; title: string; body?: string; sessionID?: string }
export type AlertInput = { kind: AlertKind; title: string; body?: string; sessionID?: string; /** What the alert is about; the same kind and key is not repeated within the kind's gap. */ key?: string }

/** Shortest time between two alerts of the same kind about the same thing. */
const GAP_MS: Record<AlertKind, number> = { fallback: 2 * 60_000, return: 2 * 60_000, allLimited: 15 * 60_000, spendCap: 86_400_000, usageCheck: 6 * 3_600_000 }
/** No more than this many alerts an hour in total, whatever their kind. */
const HOURLY_MAX = 20
const KEEP_DAYS = 30

type Run = (file: string, args: string[]) => void
const run: Run = (file, args) => void execFile(file, args, { timeout: 5_000 }, () => {})

/**
 * Show a notification through the operating system. The text is passed as arguments, never built into a script or a
 * shell command, so nothing in it can be run.
 */
export function systemNotify(title: string, body: string, platform: string = process.platform, exec: Run = run): boolean {
  if (platform === "darwin") {
    exec("/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body])
    return true
  }
  if (platform === "linux") {
    exec("notify-send", ["--app-name=quota-router", "--", title, body])
    return true
  }
  return false
}

/** Record an alert unless its kind is turned off or it would repeat a recent one. Returns the stored alert. */
export function raise(store: Store, config: Config, a: AlertInput, now = Date.now(), notify = systemNotify): Alert | undefined {
  const n = config.notifications
  if (!n.enabled || !n.events[a.kind]) return undefined
  const key = a.key ?? ""
  if (store.get("SELECT 1 AS x FROM notifications WHERE kind = ? AND key = ? AND at > ? LIMIT 1", a.kind, key, now - GAP_MS[a.kind])) return undefined
  if ((store.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE at > ?", now - 3_600_000)?.n ?? 0) >= HOURLY_MAX) return undefined
  store.run("INSERT INTO notifications (at, kind, key, title, body, session_id) VALUES (?, ?, ?, ?, ?, ?)", now, a.kind, key, a.title, a.body, a.sessionID)
  const id = Number(store.get<{ id: number }>("SELECT MAX(id) AS id FROM notifications")?.id ?? 0)
  if (n.system) {
    try {
      notify(a.title, a.body ?? "")
    } catch {}
  }
  return { id, at: now, kind: a.kind, title: a.title, body: a.body, sessionID: a.sessionID }
}

/** The feed: alerts after `after`, oldest first, or the newest `limit` when `after` is not given. */
export function feed(store: Store, opts: { after?: number; limit?: number } = {}): { alerts: Alert[]; last: number } {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const cols = "id, at, kind, title, body, session_id AS sessionID"
  const rows =
    opts.after !== undefined
      ? store.all<Alert>(`SELECT ${cols} FROM notifications WHERE id > ? ORDER BY id LIMIT ?`, opts.after, limit)
      : store.all<Alert>(`SELECT ${cols} FROM notifications ORDER BY id DESC LIMIT ?`, limit).reverse()
  const last = Number(store.get<{ id: number }>("SELECT COALESCE(MAX(id), 0) AS id FROM notifications")?.id ?? 0)
  return { alerts: rows.map((r) => ({ ...r, body: r.body ?? undefined, sessionID: r.sessionID ?? undefined })), last }
}

export function pruneAlerts(store: Store, now: number) {
  store.run("DELETE FROM notifications WHERE at < ?", now - KEEP_DAYS * 86_400_000)
}
