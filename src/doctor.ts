// A health check of the whole setup: what is connected, what would be used, and what is likely to go wrong.
// Read-only. Nothing here reads a credential, and paths are shown relative to the home directory.
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
  if (core.chatgptActive()) add(core.chatgpt.at ? { id: "probe-chatgpt", status: "ok", title: "ChatGPT plan windows are being read", detail: `Last seen ${minutes(now - core.chatgpt.at)} ago` } : { id: "probe-chatgpt", status: "info", title: "ChatGPT plan windows appear after the first request" })

  // Notifications
  const nf = config.notifications
  const off = Object.entries(nf.events).filter(([, on]) => !on).map(([k]) => k)
  if (!nf.enabled) add({ id: "notifications", status: "info", title: "Notifications are turned off" })
  else add({ id: "notifications", status: "ok", title: `Notifications are on${nf.system ? ", and also sent through the operating system" : ""}`, detail: off.length ? `Turned off: ${off.join(", ")}` : undefined })
  if (nf.enabled && nf.system && !["darwin", "linux"].includes(process.platform)) add({ id: "notifications-system", status: "warn", title: "System notifications are not supported on this platform", fix: 'Remove "system": true from notifications.' })

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
