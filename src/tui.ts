// Terminal part of quota-router: shows the plugin's notifications as toasts in the OpenCode TUI.
// It only reads the local dashboard's notification feed; it draws nothing of its own.

type Toast = { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number; sessionID?: string }
type Context = { options?: Record<string, any>; ui: { toast: { show(options: Toast): void } } }
type Alert = { id: number; kind: string; title: string; body?: string; sessionID?: string }
type Feed = { alerts: Alert[]; last: number }

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

export default {
  id: "quota-router",
  setup(context: Context) {
    const options = (context.options ?? {}) as { dashboard?: { port?: number; enabled?: boolean }; notifications?: { enabled?: boolean } }
    if (options.dashboard?.enabled === false || options.notifications?.enabled === false) return
    const basePort = options.dashboard?.port ?? 47321
    let base: string | undefined

    const read = async (after?: number): Promise<Feed | undefined> => {
      // The dashboard takes the next free port when its own is taken, so look at the next few as well.
      for (const port of base ? [Number(new URL(base).port)] : Array.from({ length: 5 }, (_, i) => basePort + i)) {
        const url = `http://127.0.0.1:${port}`
        try {
          const r = await fetch(`${url}/api/notifications${after === undefined ? "?limit=1" : `?after=${after}`}`, { signal: AbortSignal.timeout(2000) })
          if (!r.ok) continue
          const feed = (await r.json()) as Feed
          if (!Array.isArray(feed.alerts) || typeof feed.last !== "number") continue
          base = url
          return feed
        } catch {}
      }
      base = undefined
      return undefined
    }

    const poll = follower(read, (t) => context.ui.toast.show(t))
    const timer = setInterval(() => void poll(), 5_000)
    ;(timer as { unref?: () => void }).unref?.()
    void poll()
    return () => clearInterval(timer)
  },
}
