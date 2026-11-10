/** @jsxImportSource @opentui/solid */
// Terminal part of quota-router: shows the plugin's notifications as toasts in the OpenCode TUI, and the provider a
// session is on, with how full its window is, in the prompt footer. It only reads the local dashboard's feeds.
// The pragma above names the JSX runtime: OpenCode compiles this file with Bun, which reads no tsconfig.json from an
// installed package. The terminal part does not get the plugin's options; the dashboard's port comes from the file
// the server part writes (see `notedPort`).
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { follower, reader, statusLine, type Feed, type StatusFeed } from "./tui-feed.ts"

export default Plugin.define({
  id: "quota-router",
  setup(context) {
    const options = context.options as { dashboard?: { port?: number; enabled?: boolean }; notifications?: { enabled?: boolean }; statusLine?: boolean }
    if (options.dashboard?.enabled === false) return
    const read = reader(options.dashboard?.port ?? 47321)
    const stop: Array<() => void> = []
    const every = (ms: number, run: () => unknown) => {
      const timer = setInterval(() => void run(), ms)
      ;(timer as { unref?: () => void }).unref?.()
      stop.push(() => clearInterval(timer))
      void run()
    }

    if (options.notifications?.enabled !== false) {
      const feed = (after?: number) => read<Feed>(`/api/notifications${after === undefined ? "?limit=1" : `?after=${after}`}`, (b) => Array.isArray(b?.alerts) && typeof b.last === "number")
      every(5_000, follower(feed, (t) => context.ui.toast.show(t)))
    }

    if (options.statusLine !== false) {
      const [status, setStatus] = createSignal<StatusFeed | undefined>()
      // An older server part has no status feed; the line then stays empty.
      every(5_000, async () => setStatus(await read<StatusFeed>("/api/status", (b) => typeof b?.sessions === "object" && b.sessions !== null)))
      const colour = { muted: () => context.theme.text.muted, warning: () => context.theme.text.feedback.warning.base, error: () => context.theme.text.feedback.error.base }
      const line = (sessionID?: string) => (
        <Show when={statusLine(status(), sessionID)}>{(l) => <text fg={colour[l().tone]()}>{l().text}</text>}</Show>
      )
      // The prompt footer is on the home screen too, with no session, where the line shows where a new session would start.
      stop.push(context.ui.slot({ append: "prompt.footer.status", render: (input) => line(input.sessionID) }))
    }

    return () => {
      for (const s of stop) s()
    }
  },
})
