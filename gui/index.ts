// OpenCode Desktop part of quota-router: a macOS menu bar item with live routing and allowance status.
// Runs in the desktop app's Electron main process; it reads the plugin's local dashboard API.
import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from "electron"
import { Plugin } from "@opencode/plugin/gui"
import { ringIcon, type Rgb } from "./icon.ts"
import { present, type Item, type Menubar, type Tone } from "./present.ts"

const TONES: Record<Tone, Rgb> = { ok: [127, 174, 139], warn: [214, 162, 74], bad: [208, 100, 79], idle: [140, 140, 140] }
const CLAUDE: Rgb = [210, 120, 90]

export default Plugin.define({
  os: ["macos", "windows", "linux"],
  main(ctx) {
    const options = (ctx.options ?? {}) as { dashboard?: { port?: number; enabled?: boolean; menubar?: boolean }; claude?: { cutoverAtPct?: number } }
    if (options.dashboard?.enabled === false || options.dashboard?.menubar === false) return
    const basePort = options.dashboard?.port ?? 47321
    const cutover = options.claude?.cutoverAtPct ?? 98
    let base: string | undefined
    let data: Menubar | undefined
    let stopped = false

    const tray = new Tray(nativeImage.createEmpty())
    tray.setToolTip("Quota Router")
    const log = (message: string, extra?: Record<string, unknown>) => ctx.log.write("info", `quota-router menubar: ${message}`, extra)

    /** Find the dashboard: the configured port, or the next few if it moved. Skips listeners that answer with errors. */
    async function locate(): Promise<string | undefined> {
      for (let p = basePort; p < basePort + 5; p++) {
        const url = `http://127.0.0.1:${p}`
        const ok = await fetch(`${url}/api/menubar`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.ok)
          .catch(() => false)
        if (ok) return url
      }
      return undefined
    }

    async function refresh() {
      if (stopped) return
      try {
        base ??= await locate()
        if (!base) throw new Error("not found")
        const r = await fetch(`${base}/api/menubar`, { signal: AbortSignal.timeout(3000) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        data = (await r.json()) as Menubar
      } catch {
        data = undefined
        base = undefined
      }
      render()
    }

    function render() {
      if (stopped || tray.isDestroyed()) return
      const view = present(data, cutover)
      const icon = nativeImage.createFromBuffer(
        ringIcon(36, view.fraction, view.ring === "ok" ? CLAUDE : TONES[view.ring], [128, 128, 128], 0.45, view.dot ? TONES[view.dot] : undefined),
        { scaleFactor: 2 },
      )
      tray.setImage(icon)
      tray.setTitle(view.title ? ` ${view.title}` : "", { fontType: "monospacedDigit" })
      tray.setToolTip(view.tooltip)
      const toItem = (i: Item): MenuItemConstructorOptions => ({
        label: i.label,
        sublabel: i.sublabel,
        enabled: i.enabled ?? true,
        ...(i.checked !== undefined ? { type: "checkbox" as const, checked: i.checked } : {}),
        ...(i.submenu ? { submenu: i.submenu.map(toItem) } : {}),
        ...(i.action ? { click: () => void run(i.action!) } : {}),
      })
      const template: MenuItemConstructorOptions[] = []
      view.sections.forEach((section, i) => {
        if (i) template.push({ type: "separator" })
        template.push(...section.map(toItem))
      })
      tray.setContextMenu(Menu.buildFromTemplate(template))
    }

    async function run(action: NonNullable<Item["action"]>) {
      if (action.kind === "opencode") {
        const w = ctx.windows.focused() ?? ctx.windows.list()[0]
        if (w) {
          if (w.isMinimized()) w.restore()
          w.show()
          w.focus()
        }
        app.focus({ steal: true })
        return
      }
      base ??= await locate()
      if (!base) return
      if (action.kind === "dashboard") return void shell.openExternal(data?.url ?? base)
      await fetch(`${base}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-quota-router": "1" },
        body: JSON.stringify({ action: action.kind }),
      }).catch(() => {})
      await refresh()
    }

    // Live updates: follow the dashboard's change stream, refreshing at most once a second; poll as a fallback.
    let pending: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
      if (!pending) pending = setTimeout(() => ((pending = undefined), void refresh()), 1000)
    }
    async function follow() {
      while (!stopped) {
        try {
          base ??= await locate()
          if (!base) throw new Error("not found")
          const r = await fetch(`${base}/api/stream`, { signal: ctx.signal })
          if (!r.body) throw new Error("no stream")
          const reader = r.body.getReader()
          const decoder = new TextDecoder()
          let buf = ""
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const events = buf.split("\n\n")
            buf = events.pop() ?? ""
            if (events.some((e) => e.includes("event: change"))) soon()
          }
        } catch {
          if (stopped) return
          base = undefined
        }
        await new Promise((r) => setTimeout(r, 5000))
      }
    }

    const timer = setInterval(() => void refresh(), 20_000)
    void refresh()
    void follow()
    log("started")

    return () => {
      stopped = true
      clearInterval(timer)
      if (pending) clearTimeout(pending)
      if (!tray.isDestroyed()) tray.destroy()
    }
  },
})
