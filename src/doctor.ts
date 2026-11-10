// A health check of the whole setup: what is connected, what would be used, and what is likely to go wrong.
// Read-only. Nothing here reads a credential, and paths are shown relative to the home directory.
import { describeSchedule, describeWhen } from "./engine/schedule.ts"
import { ruledOut } from "./engine/rules.ts"
import { unreliable } from "./engine/health.ts"
import { LOCAL_NAMES, localNote } from "./probes/local.ts"
import { claudePlan } from "./engine/plans.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { refKey, refLabel } from "./engine/config.ts"
import { VERSION, type Core, type ProbeStatus } from "./core.ts"
import { dataDir } from "./log.ts"
import { orderedChain } from "./engine/router.ts"

export type Check = {
  id: string
  status: "ok" | "warn" | "fail" | "info"
  title: string
  detail?: string
  /** What to do about it, in one line. */
  fix?: string
}

const tilde = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p)
const minutes = (ms: number) => (ms < 90_000 ? "a minute" : ms < 5_400_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 3_600_000)} hours`)

export function runDoctor(core: Core, now = Date.now()): Check[] {
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)
  const config = core.config

  add({ id: "version", status: "info", title: `quota-router ${VERSION}`, detail: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}` })

  if (!config.enabled) add({ id: "routing", status: "warn", title: "Routing is turned off", fix: 'Remove "enabled": false from the plugin options.' })
  else if (core.paused) add({ id: "routing", status: "warn", title: "Routing is paused", detail: "Sessions stay on whatever model they are on.", fix: "Run /router resume." })
  else if (config.dryRun) add({ id: "routing", status: "warn", title: "Dry run is on", detail: "Decisions are recorded, and no session is moved.", fix: "Run /router dry-run off to make routing live." })
  else add({ id: "routing", status: "ok", title: "Routing is on" })

  for (const [i, w] of core.warnings.entries()) add({ id: `config-${i}`, status: "warn", title: "Configuration problem", detail: w, fix: "Correct the option in opencode.jsonc." })
  if (core.warnings.length === 0) add({ id: "config", status: "ok", title: "Configuration is valid" })

  // Providers and chains
  const connected = [...new Set([...core.models.values()].map((m) => m.providerID))]
  if (core.models.size === 0) {
    add({ id: "providers", status: "fail", title: "No models found", detail: "OpenCode returned no models, so nothing can be routed.", fix: "Connect a provider in OpenCode (/connect)." })
  } else {
    const ranked = connected.filter((id) => config.providers[id]).sort((a, b) => config.providers[a].priority - config.providers[b].priority)
    add({ id: "providers", status: "ok", title: `${connected.length} connected ${connected.length === 1 ? "provider" : "providers"}`, detail: ranked.map((id) => `${config.providers[id].priority}. ${id} (${config.providers[id].kind})`).join(" · ") })
  }
  const inChains = new Set(Object.values(config.chains).flat().map((r) => r.providerID))
  const unused = connected.filter((id) => !inChains.has(id) && config.providers[id]?.allow !== "never")
  if (unused.length) add({ id: "unused", status: "warn", title: `Connected but in no chain: ${unused.join(", ")}`, detail: "A provider is only used when one of its models is in a chain.", fix: "Add a suggested entry under Route on the dashboard, or set it in chains." })

  for (const name of Object.keys(config.chains)) {
    const chain = orderedChain(config, name)
    const usable = chain.filter((r) => core.models.has(refKey(r)) && config.providers[r.providerID]?.allow !== "never")
    const missing = chain.filter((r) => !core.models.has(refKey(r)) && connected.includes(r.providerID))
    if (usable.length === 0) add({ id: `chain-${name}`, status: "info", title: `Chain ${name}: no connected model`, detail: "Sessions on this chain's models are not routed." })
    else if (usable.length === 1) add({ id: `chain-${name}`, status: "warn", title: `Chain ${name}: no fallback`, detail: `Only ${refLabel(usable[0])} is connected, so a limit there has nowhere to go.`, fix: "Connect a second provider, or add another entry to this chain." })
    else add({ id: `chain-${name}`, status: "ok", title: `Chain ${name}: ${usable.length} providers`, detail: usable.map(refLabel).join(" → ") })
    // The provider is connected but does not offer this model: usually a renamed or retired model.
    if (missing.length) add({ id: `chain-${name}-missing`, status: "warn", title: `Chain ${name}: model not offered`, detail: missing.map(refLabel).join(", "), fix: "Change the entry to a model that provider lists, in chains." })
  }

  // Spend caps
  const metered = connected.filter((id) => inChains.has(id) && config.providers[id]?.kind === "metered" && config.providers[id]?.allow !== "never")
  const capped = config.spend.dailyUsd > 0 || config.spend.monthlyUsd > 0
  const blocks = core.spendBlocks(now)
  for (const [id, b] of Object.entries(blocks)) add({ id: `spend-${id}`, status: "warn", title: id === "*" ? "Spend cap reached for pay-per-use providers" : `Spend cap reached for ${id}`, detail: `${b.reason}; routing passes ${id === "*" ? "them" : "it"} over until ${new Date(b.until ?? now).toLocaleString()}` })
  if (metered.length && !capped && metered.some((id) => !config.spend.providers[id]))
    add({ id: "spend", status: "info", title: "No spend cap on pay-per-use providers", detail: `${metered.join(", ")} can be used without limit when every subscription is limited.`, fix: 'Set "spend": { "dailyUsd": 10 } to cap what routing may spend.' })
  else if (metered.length && !Object.keys(blocks).length) add({ id: "spend", status: "ok", title: "Spend caps are set", detail: [config.spend.dailyUsd && `$${config.spend.dailyUsd} a day`, config.spend.monthlyUsd && `$${config.spend.monthlyUsd} a month`, ...Object.entries(config.spend.providers).map(([id, c]) => `${id}: ${[c.dailyUsd && `$${c.dailyUsd} a day`, c.monthlyUsd && `$${c.monthlyUsd} a month`].filter(Boolean).join(", ")}`)].filter(Boolean).join(" · ") })

  // Limits in force
  const limited = core.pools.all().filter((p) => (p.status === "cooling" || p.status === "blocked") && (p.until ?? 0) > now)
  for (const p of limited) add({ id: `pool-${p.id}`, status: "info", title: `${p.id} is limited for ${minutes((p.until ?? now) - now)}`, detail: p.evidence, fix: `If that is wrong, run /router reset ${p.id}.` })

  // Usage checks
  const probe = (id: string, name: string, enabled: boolean, has: boolean, status: ProbeStatus<unknown>, option: string) => {
    if (!has) return
    if (!enabled) return add({ id, status: "info", title: `${name} usage check is off`, detail: "Without it, a limit is only seen when a request fails.", fix: `Set "${option}": true to move before the limit.` })
    if (!status.at) return add({ id, status: "info", title: `${name} usage check has not run yet` })
    if (!status.ok) return add({ id, status: "warn", title: `${name} usage check is failing`, detail: status.message })
    add({ id, status: "ok", title: `${name} usage check is working`, detail: `Last checked ${minutes(now - status.at)} ago${status.message ? ` · ${status.message}` : ""}` })
  }
  probe("probe-claude", "Claude", config.claude.usageProbe, core.hasProvider("claude-agent"), core.claude, "claude.usageProbe")
  probe("probe-copilot", "Copilot", config.copilot.usageProbe, core.hasProvider("github-copilot"), core.copilot, "copilot.usageProbe")
  probe("probe-openrouter", "OpenRouter", config.openrouter.usageProbe, core.hasProvider("openrouter"), core.openrouter, "openrouter.usageProbe")
  const activeNow = core.schedules(now)
  for (const [i, sc] of config.schedules.entries()) {
    const on = activeNow.find((a) => a.name === sc.name)
    add({ id: `schedule-${i}`, status: "info", title: `Schedule ${sc.name}: ${on ? `applies now${on.until ? ` until ${new Date(on.until).toLocaleString()}` : ""}` : "not now"}`, detail: `${describeWhen(sc)} · ${describeSchedule(sc)}` })
    const known = new Set([...Object.keys(config.providers), "subscription", "metered", "local"])
    const unknown = [...sc.deny, ...(sc.allow ?? []), ...sc.first].filter((x) => !known.has(x))
    if (unknown.length) add({ id: `schedule-${i}-names`, status: "warn", title: `Schedule ${sc.name} names a provider that is not known`, detail: `${unknown.join(", ")} matches no provider, so that part does nothing.`, fix: "Check the spelling against the provider IDs on the dashboard." })
  }
  // Project rules, for the projects with a session open
  const seenDirs = new Set<string>()
  for (const s of core.sessions.values()) {
    const dir = core.directoryOf(s)
    if (!dir) continue
    const rules = core.rulesFor(s)
    if (!seenDirs.has(dir)) {
      seenDirs.add(dir)
      for (const [i, w] of core.projectFile(dir).warnings.entries()) add({ id: `rules-file-${seenDirs.size}-${i}`, status: "warn", title: "Problem in a project's rules", detail: w })
      if (rules) add({ id: `rules-${seenDirs.size}`, status: "info", title: `Project rules apply in ${path.basename(dir)}`, detail: [rules.deny.length ? `Never routed to: ${rules.deny.join(", ")}` : "", rules.denyKinds.length ? `No ${rules.denyKinds.join(" or ")} providers` : "", rules.allow ? `Only: ${rules.allow.join(", ") || "nothing"}` : "", rules.chain ? `Chain: ${rules.chain}` : "", `From ${rules.source}`].filter(Boolean).join(" · ") })
    }
    const out = rules && s.current ? ruledOut(config, rules, s.current.providerID) : undefined
    if (out && core.recorder.live.has(s.id)) add({ id: `rules-session-${s.id}`, status: "warn", title: "A session is on a provider its project shuts out", detail: `${out}.`, fix: s.pinned ? "The session is pinned; /router unpin lets routing move it." : "Pick a model that is in a chain, so routing can move it." })
  }
  for (const [id, h] of Object.entries(core.health(now)))
    if (config.health.enabled && unreliable(config, h)) add({ id: `health-${id}`, status: "warn", title: `${id} is unreliable right now`, detail: `${h.failed} of its last ${h.requests} requests failed without a limit being the cause. Routing passes it over while another entry can run, and comes back as the failures age out.` })
  for (const [kind, l] of core.local) {
    const name = LOCAL_NAMES[kind]
    if (!l.data) continue
    if (!l.data.running) add({ id: `local-${kind}`, status: "warn", title: `${name} is not running`, detail: `Nothing answered at ${kind === "ollama" ? config.local.ollamaUrl : config.local.lmstudioUrl}. Routing passes it over until it does.`, fix: `Start ${name}, or set local.${kind}Url if it listens elsewhere.` })
    else {
      const loaded = l.data.models.filter((m) => m.loaded)
      add({ id: `local-${kind}`, status: "ok", title: `${name} is running`, detail: loaded.length ? `In memory: ${loaded.map((m) => m.id).join(", ")}` : `${l.data.models.length} models installed, none in memory; the first request loads one, which takes a while.` })
      for (const m of l.data.models) {
        const note = localNote(m, core.totalMemory)
        if (note && [...core.models.values()].some((x) => x.providerID === kind && x.id === m.id)) add({ id: `local-${kind}-${m.id}`, status: "warn", title: `${m.id} may be too large for this machine`, detail: `${note[0].toUpperCase()}${note.slice(1)}.`, fix: "Use a smaller model or quantisation, or take it out of the chain." })
      }
    }
  }
  const xai = core.learned(now).xai
  if (xai) add({ id: "learned-xai", status: "info", title: `xAI weekly pool: about ${Math.round(xai.pct)}% used (estimated)`, detail: `xAI publishes no usage figures. From the ${xai.samples === 1 ? "one time" : `${xai.samples} times`} it ran out, the pool holds about $${xai.capacityUsd.toFixed(2)} of usage at list prices a week. Routing does not act on this estimate, except through the pace guard.` })
  if (core.chatgptActive()) add(core.chatgpt.at ? { id: "probe-chatgpt", status: "ok", title: "ChatGPT plan windows are being read", detail: `Last seen ${minutes(now - core.chatgpt.at)} ago` } : { id: "probe-chatgpt", status: "info", title: "ChatGPT plan windows appear after the first request" })

  // Plans
  const plan = core.hasProvider("claude-agent") ? claudePlan(config.claude.plan || core.claude.plan?.type, core.claude.plan?.tier) : undefined
  if (plan) add({ id: "plan-claude", status: "info", title: `Claude plan: ${plan.name}`, detail: config.claude.plan ? "From claude.plan in your settings." : "As Claude Code's login reports it.", fix: "/router advice says whether it fits how you use it." })

  // Pace guard
  if (config.pace.enabled) {
    const fed = (config.claude.usageProbe && core.hasProvider("claude-agent")) || (config.copilot.usageProbe && core.hasProvider("github-copilot")) || core.chatgptActive()
    if (!fed) add({ id: "pace", status: "warn", title: "The pace guard has nothing to measure", detail: "It works from the usage checks, and none is on.", fix: "Turn on claude.usageProbe or copilot.usageProbe, or sign in to OpenAI with ChatGPT." })
    else add({ id: "pace", status: "ok", title: "The pace guard is on", detail: `Subagents${config.pace.lightAgents.length ? ` and ${config.pace.lightAgents.join(", ")}` : ""} pass over a plan that is on pace to run out before it resets.` })
  }
  for (const f of core.forecasts(now)) if (f.beforeReset) add({ id: `pace-${f.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, status: "info", title: `${f.label} is on pace to run out before it resets`, detail: `At ${Math.round(f.pct)}% and rising ${f.ratePerHour.toFixed(1)} points an hour: it reaches ${Math.round(f.limitPct)}% around ${new Date(f.runsOutAt).toLocaleString()}${f.resetAt ? `, and resets ${new Date(f.resetAt).toLocaleString()}` : ""}.`, fix: config.pace.enabled ? undefined : "/router pace on keeps subagents off it until it resets." })

  // Agents with their own chain
  for (const [agent, chain] of Object.entries(config.agents)) add({ id: `agent-${agent}`, status: "info", title: `The ${agent} agent uses the ${chain} chain`, detail: "Its sessions prefer that chain's first entry, unless you pick a model in the session." })

  // Providers set aside
  for (const [id, until] of Object.entries(core.saved(now))) add({ id: `saved-${id}`, status: "info", title: `${id} is saved for later`, detail: `Routing passes it over until ${new Date(until).toLocaleString()}.`, fix: `/router save ${id} off ends it early.` })

  // Notifications
  const nf = config.notifications
  const off = Object.entries(nf.events).filter(([, on]) => !on).map(([k]) => k)
  if (!nf.enabled) add({ id: "notifications", status: "info", title: "Notifications are turned off" })
  else add({ id: "notifications", status: "ok", title: `Notifications are on${nf.system ? ", and also sent through the operating system" : ""}`, detail: off.length ? `Turned off: ${off.join(", ")}` : undefined })
  if (nf.enabled && nf.system && !["darwin", "linux"].includes(process.platform)) add({ id: "notifications-system", status: "warn", title: "System notifications are not supported on this platform", fix: 'Remove "system": true from notifications.' })

  // Telemetry export
  const tm = core.telemetry.status()
  if (tm.enabled) {
    const what = `${tm.level === "events" ? "Metrics and events" : "Metrics"} every ${Math.round(tm.intervalMs / 1000)} s to ${tm.endpoint}${tm.headerNames.length ? ` · headers: ${tm.headerNames.join(", ")}` : ""}${tm.identity.length ? ` · identifies you by ${tm.identity.join(", ")}` : " · no identity attributes"}${tm.projects !== "off" ? ` · projects ${tm.projects}` : ""}`
    for (const [i, p] of tm.problems.entries()) add({ id: `telemetry-${i}`, status: "fail", title: "Telemetry export cannot run", detail: p })
    if (!tm.problems.length) {
      if (tm.lastError) add({ id: "telemetry", status: "warn", title: "Telemetry export is failing", detail: `${tm.lastError} · ${tm.queued} queued`, fix: "Check the endpoint and headers under telemetry in opencode.jsonc." })
      else add({ id: "telemetry", status: tm.lastOk ? "ok" : "info", title: tm.lastOk ? "Telemetry export is working" : "Telemetry export is on; nothing sent yet", detail: `${what}${tm.lastOk ? ` · last sent ${minutes(now - tm.lastOk)} ago` : ""}` })
    }
  } else add({ id: "telemetry", status: "info", title: "Telemetry export is off", detail: "Nothing leaves this machine." })

  // Dashboard
  if (!config.dashboard.enabled) add({ id: "dashboard", status: "info", title: "Dashboard is turned off" })
  else if (!core.dashboardURL) add({ id: "dashboard", status: "fail", title: "Dashboard could not start", detail: `Ports ${config.dashboard.port}–${config.dashboard.port + 4} were all taken.`, fix: "Set dashboard.port to a free port." })
  else if (!["127.0.0.1", "localhost", "::1"].includes(config.dashboard.host)) add({ id: "dashboard", status: "warn", title: "Dashboard is reachable from other machines", detail: `It listens on ${config.dashboard.host}.`, fix: 'Remove dashboard.host to listen on 127.0.0.1 only.' })
  else add({ id: "dashboard", status: "ok", title: "Dashboard is running", detail: core.dashboardURL })

  // Storage
  const dir = dataDir()
  const db = path.join(dir, "router.db")
  try {
    const size = fs.statSync(db).size + (fs.statSync(`${db}-wal`, { throwIfNoEntry: false })?.size ?? 0)
    const steps = core.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM steps")?.n ?? 0
    const last = Number(core.store.meta("last_maintenance") ?? 0)
    add({
      id: "storage",
      status: last && now - last > 3 * 86_400_000 ? "warn" : "ok",
      title: `Database: ${(size / 1e6).toFixed(1)} MB, ${steps.toLocaleString()} requests`,
      detail: `${tilde(db)} · schema ${core.store.meta("schema_version")} · ${last ? `tidied ${minutes(now - last)} ago` : "not tidied yet"}`,
    })
  } catch (error) {
    add({ id: "storage", status: "fail", title: "Database cannot be read", detail: String(error) })
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    const mode = fs.statSync(dir).mode & 0o777
    if (process.platform !== "win32" && mode & 0o077) add({ id: "data-dir", status: "warn", title: "Data folder is readable by other users", detail: `${tilde(dir)} has mode ${mode.toString(8)}.`, fix: `Run chmod 700 ${tilde(dir)}.` })
    else add({ id: "data-dir", status: "ok", title: "Data folder is private and writable", detail: tilde(dir) })
  } catch {
    add({ id: "data-dir", status: "fail", title: "Data folder is not writable", detail: tilde(dir) })
  }

  // Menu bar
  if (config.dashboard.menubar && process.platform === "darwin") {
    const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "gui-experimental.cjs")
    add(fs.existsSync(bundle) ? { id: "menubar", status: "ok", title: "Menu bar bundle is present", detail: "Shown in OpenCode Desktop only." } : { id: "menubar", status: "warn", title: "Menu bar bundle is missing", fix: "Run npm run build in the plugin folder, then restart OpenCode." })
  }
  return checks
}

/** The checks as plain text, for the session note and the command line. */
export function doctorText(checks: Check[]): string {
  const mark = { ok: "✓", warn: "!", fail: "✗", info: "·" }
  return checks.map((c) => `${mark[c.status]} ${c.title}${c.detail ? ` (${c.detail})` : ""}${c.fix && c.status !== "ok" ? `\n    → ${c.fix}` : ""}`).join("\n")
}
