// quota-router: quota-aware provider routing for OpenCode V2, with a local usage dashboard.
import { parseUntil } from "./engine/policy.ts"
import { backfill } from "./backfill.ts"
import { refLabel } from "./engine/config.ts"
import { onCodexResponse, onEvent, onHttpResponse, onPrompt, onRetry } from "./controller.ts"
import { Core, VERSION } from "./core.ts"
import { startDashboard } from "./dashboard/server.ts"
import { doctorText, runDoctor } from "./doctor.ts"
import { codexWindows, headroom } from "./engine/headers.ts"
import { orderedChain } from "./engine/router.ts"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Fingerprint of the plugin's source. OpenCode re-imports a plugin when its files change, but the shared core built
 * by the previous copy would keep running old code; a changed fingerprint rebuilds it.
 */
const CODE_HASH = (() => {
  const hash = createHash("sha1")
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".ts")) hash.update(entry.name).update(fs.readFileSync(full))
    }
  }
  try {
    walk(path.dirname(fileURLToPath(import.meta.url)))
  } catch {
    hash.update(String(Date.now()))
  }
  return hash.digest("hex")
})()

/** Open a URL in the default browser. Commands have no output channel, so status lives on the dashboard. */
const openURL = (url: string) =>
  new Promise<void>((resolve) => execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url], () => resolve()))

type Ctx = any
type Shared = {
  version?: string
  codeHash?: string
  core?: Promise<Core>
  dashboard?: { url: string; close: () => Promise<void>; stop: () => Promise<void> }
  shutdownTimer?: ReturnType<typeof setTimeout>
  seen: Set<string>
}

const KEY = Symbol.for("opencode-quota-router")
const shared = (): Shared => ((globalThis as Record<symbol, Shared>)[KEY] ??= { seen: new Set() })

/** Stop the core. `final` (plugin removed) also releases the dashboard port; a code reload keeps it for the next core. */
async function shutdown(g: Shared, final = false) {
  const core = await g.core?.catch(() => undefined)
  g.core = undefined
  core?.stopTimers()
  await (final ? g.dashboard?.stop() : g.dashboard?.close())?.catch(() => {})
  g.dashboard = undefined
  core?.log.info("stop")
  try {
    core?.store.close()
  } catch {}
}

async function boot(g: Shared, ctx: Ctx): Promise<Core> {
  const core = await Core.create(ctx.options)
  core.ctx = ctx
  await core.refreshModels(true)
  if (core.config.dashboard.enabled) {
    g.dashboard = await startDashboard(core).catch((error) => {
      core.log.error("dashboard failed", { error: String(error) })
      return undefined
    })
    core.dashboardURL = g.dashboard?.url
  }
  if (core.config.backfill && !core.store.meta("backfilled")) {
    void backfill(core.store, (p, m, t, r) => core.price(p, m, t, r), core.started)
      .then((r) => {
        core.store.setMeta("backfilled", new Date().toISOString())
        core.log.info("backfill", r)
        core.notify("usage")
      })
      .catch((error) => core.log.warn("backfill failed", { error: String(error) }))
  }
  core.startTimers()
  return core
}

const guard =
  <T,>(core: Core, name: string, fn: (e: T) => Promise<void> | void) =>
  async (e: T) => {
    try {
      await fn(e)
    } catch (error) {
      core.log.error(`${name} hook failed`, { error: String(error), stack: (error as Error)?.stack?.split("\n").slice(0, 4).join(" | ") })
    }
  }

function statusText(core: Core, sessionID: string): string {
  const s = core.sessions.get(sessionID)
  const lines = [`quota-router ${VERSION}${core.paused ? " (paused)" : ""}${core.config.dryRun ? " (dry run)" : ""}`]
  if (core.dashboardURL) lines.push(`Dashboard: ${core.dashboardURL}`)
  if (s?.preferred) {
    lines.push(`This session: ${s.current ? refLabel(s.current) : "?"} (preferred ${refLabel(s.preferred.model)}, chain ${s.preferred.chain}${s.byAgent ? ` from the ${s.agent} agent` : ""}${s.pinned ? ", pinned" : ""})`)
    lines.push(`Chain: ${orderedChain(core.config, s.preferred.chain).map(refLabel).join(" → ")}`)
  } else lines.push("This session's model is in no chain, so it is not routed.")
  for (const [id, until] of Object.entries(core.saved())) lines.push(`- ${id}: saved for later until ${new Date(until).toLocaleString()}`)
  for (const p of core.pools.all()) {
    const when = p.until ? ` until ${new Date(p.until).toLocaleString()}` : ""
    lines.push(`- ${p.id}: ${p.status}${when}${p.utilization !== undefined ? `, ${Math.round(p.utilization)}% used` : ""}${p.evidence ? ` (${p.evidence})` : ""}`)
  }
  return lines.join("\n")
}

export default {
  id: "quota-router",
  async setup(ctx: Ctx) {
    const g = shared()
    if (g.core && (g.version !== VERSION || g.codeHash !== CODE_HASH)) await shutdown(g)
    g.version = VERSION
    g.codeHash = CODE_HASH
    if (g.shutdownTimer) clearTimeout(g.shutdownTimer)
    g.shutdownTimer = undefined
    g.core ??= boot(g, ctx)
    const core = await g.core
    core.setOptions(ctx.options)
    core.ctx = ctx
    core.instances.add(ctx)

    await ctx.session.hook("retry", guard(core, "retry", (e: any) => onRetry(core, e)))
    await ctx.session.hook("prompt", guard(core, "prompt", (e: any) => onPrompt(core, e)))
    for (const providerID of core.config.headers.observe) {
      await ctx.session.hook("http.response", guard(core, "http.response", (e: any) => onHttpResponse(core, e, headroom)), { providerID })
    }
    // ChatGPT reports its windows in headers. Only hook OpenAI while it is signed in with ChatGPT, which already uses
    // HTTP: hooking an API-key connection would turn off its WebSocket transport.
    let codexHooked = false
    const hookCodex = async () => {
      if (codexHooked || !core.chatgptActive()) return
      codexHooked = true
      await ctx.session.hook("http.response", guard(core, "http.response", (e: any) => onCodexResponse(core, e, codexWindows)), { providerID: "openai" })
      core.log.info("chatgpt", { message: "Reading ChatGPT plan windows from responses" })
    }
    core.onChatgpt.add(hookCodex)
    await hookCodex()

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "router",
        description: "quota-router: open the dashboard, or pin | unpin | reset <pool|all> | pause | resume | dry-run on|off | save <provider> [2h|17:00|off] | agent <name> <chain|off> | pace on|off | doctor | telemetry on|off",
        execute: async (input: { sessionID: string; prompt: { text?: string } }) => {
          const { sessionID, prompt } = input
          core.log.info("command", { sessionID, text: prompt?.text })
          const [verb = "status", arg, arg2] = (prompt?.text ?? "").trim().split(/\s+/).filter(Boolean)
          const s = core.session(sessionID)
          let text: string
          switch (verb) {
            case "pin":
              s.pinned = true
              core.savePrefs(s)
              text = "Routing is off for this session; it stays on its current model."
              break
            case "unpin":
              s.pinned = false
              core.savePrefs(s)
              text = "Routing is back on for this session."
              break
            case "reset":
              for (const p of core.pools.all()) if (!arg || arg === "all" || p.id === arg || p.id.startsWith(`${arg}:`)) core.pools.reset(p.id, "command")
              text = `Cleared ${arg && arg !== "all" ? arg : "all pools"}.`
              break
            case "pause":
              core.paused = true
              text = "Routing paused for every session."
              break
            case "resume":
              core.paused = false
              text = "Routing resumed."
              break
            case "dry-run": {
              const on = arg !== "off"
              const r = core.setSetting("dryRun", on)
              text = !r.ok ? r.error : on ? "Dry run is on: routing decisions are recorded on the dashboard, and no session is moved." : "Dry run is off: routing is live again."
              break
            }
            case "pace": {
              const on = arg !== "off"
              const r = core.setSetting("pace.enabled", on)
              const short = core.forecasts().filter((f) => f.beforeReset).map((f) => `${f.label} at ${new Date(f.runsOutAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)
              text = !r.ok ? r.error : on ? `The pace guard is on: subagents${core.config.pace.lightAgents.length ? ` and the ${core.config.pace.lightAgents.join(", ")} agent${core.config.pace.lightAgents.length > 1 ? "s" : ""}` : ""} pass over a plan that is on pace to run out before it resets. ${short.length ? `On pace to run out now: ${short.join("; ")}.` : "No plan is on pace to run out now."}` : "The pace guard is off."
              break
            }
            case "agent": {
              // `/router agent plan fast` runs the plan agent's sessions on the fast chain; `/router agent plan off` ends it.
              const rules = Object.entries(core.config.agents).map(([a, c]) => `${a} → ${c}`)
              if (!arg) {
                text = rules.length ? `Agent chains: ${rules.join("; ")}.` : `No agent has its own chain. Use /router agent <name> <chain>. Chains: ${Object.keys(core.config.chains).join(", ")}.`
                break
              }
              if (!/^[\w-]+$/.test(arg) || !arg2) {
                text = `Use /router agent <name> <chain|off>. Chains: ${Object.keys(core.config.chains).join(", ")}.`
                break
              }
              const r = core.setSetting(`agents.${arg}`, arg2 === "off" ? undefined : arg2)
              text = !r.ok ? r.error : arg2 === "off" ? `The ${arg} agent no longer has its own chain here. A rule in opencode.jsonc still applies.` : `Sessions run by the ${arg} agent now use the ${arg2} chain, unless you pick a model in the session.`
              break
            }
            case "save": {
              // `/router save claude 2h` keeps Claude for later; `/router save claude off` or `/router save off` ends it.
              const saved = core.saved()
              if (!arg) {
                const list = Object.entries(saved).map(([id, until]) => `${id} until ${new Date(until).toLocaleString()}`)
                text = list.length ? `Saved for later: ${list.join("; ")}.` : "Nothing is saved for later. Use /router save <provider> 2h."
                break
              }
              if (arg === "off") {
                for (const id of Object.keys(saved)) core.save(id)
                text = "Every provider is available to routing again."
                break
              }
              const id = core.findProvider(arg)
              if (!id) {
                text = `No provider matches "${arg}". Providers: ${Object.keys(core.config.providers).join(", ")}.`
                break
              }
              if (arg2 === "off") {
                core.save(id)
                text = `${id} is available to routing again.`
                break
              }
              const until = parseUntil(arg2 ?? "2h", Date.now())
              if (!until) {
                text = `"${arg2}" is not a time span. Use 90m, 2h, 1d or a time such as 17:00 (at most a week).`
                break
              }
              core.save(id, until)
              text = `${id} is saved for later: routing passes it over until ${new Date(until).toLocaleString()}. Sessions on it move at their next turn. /router save ${arg} off ends it early.`
              break
            }
            case "telemetry": {
              const on = arg !== "off"
              const r = core.setSetting("telemetry.enabled", on)
              const t = core.telemetry.status()
              text = !r.ok
                ? r.error
                : !on
                  ? "Telemetry export is off. Nothing leaves this machine."
                  : t.problems.length
                    ? `Telemetry export is on but cannot run: ${t.problems.join("; ")}`
                    : `Telemetry export is on: ${t.level === "events" ? "metrics and events" : "metrics"} go to ${t.endpoint} every ${Math.round(t.intervalMs / 1000)} s. No prompts, code or session titles are sent.`
              break
            }
            case "doctor":
              // The dashboard shows the checks straight away; the note repeats them in the session at its next turn.
              if (core.dashboardURL) void openURL(`${core.dashboardURL}/#doctor`)
              text = `quota-router health check\n${doctorText(runDoctor(core))}`
              break
            default:
              // status / dashboard: open the dashboard. A queued note would only appear on the next turn.
              if (core.dashboardURL) return openURL(core.dashboardURL)
              text = statusText(core, sessionID)
          }
          // Shown at the start of the session's next turn; synthetic notes cannot reply immediately.
          try {
            await ctx.session.synthetic({ sessionID, text, description: "quota-router", metadata: { quotaRouter: true }, resume: false })
          } catch (error) {
            core.log.error("command reply failed", { sessionID, error: String(error) })
          }
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            const e = ev as { id: string; type: string; created: number; data: Record<string, any> }
            if (!e?.id || g.seen.has(e.id)) continue
            g.seen.add(e.id)
            if (g.seen.size > 20_000) for (const id of [...g.seen].slice(0, 5_000)) g.seen.delete(id)
            if (!e.type.startsWith("session.") && !["credential.updated", "credential.switched", "integration.updated", "model.updated", "provider.updated"].includes(e.type)) continue
            if (e.type.endsWith(".delta") || e.type === "session.tool.progress") continue
            try {
              core.recorder.handle(e)
            } catch (error) {
              core.log.error("record failed", { type: e.type, error: String(error) })
            }
            await guard(core, "event", (x: typeof e) => onEvent(core, x))(e)
          }
        } catch (error) {
          if (controller.signal.aborted) break
          core.log.warn("event stream ended; resubscribing", { error: String(error) })
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    })()

    core.log.info("instance", { location: ctx.location?.directory, instances: core.instances.size, dashboard: core.dashboardURL })

    return () => {
      controller.abort()
      core.onChatgpt.delete(hookCodex)
      core.instances.delete(ctx)
      if (core.ctx === ctx) core.ctx = [...core.instances][0] ?? ctx
      if (core.instances.size === 0) g.shutdownTimer = setTimeout(() => void shutdown(g, true), 5_000)
    }
  },
}
