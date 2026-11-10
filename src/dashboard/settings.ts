// The dashboard's settings page: which settings it offers, what they are now, and the checks a change must pass.
// Changes are stored by the plugin on top of opencode.jsonc (see `Core.setSetting`); the file itself is never written.
import crypto from "node:crypto"
import type http from "node:http"
import { LOCKED_SETTINGS, loadConfig } from "../engine/config.ts"
import type { Core } from "../core.ts"

type Base = { path: string; label: string; help?: string }
export type Field = Base &
  (
    | { type: "bool" }
    | { type: "choice"; options: Array<[value: string, label: string]> }
    | { type: "text"; max?: number; placeholder?: string }
    /** Stored as `value * scale`: minutes are shown for milliseconds, percent for fractions. */
    | { type: "number"; unit?: string; min?: number; max?: number; step?: number; scale?: number }
  )
export type Group = { id: string; title: string; help?: string; fields: Field[] }

const MIN = 60_000
const pct = (path: string, label: string, help?: string): Field => ({ path, label, help, type: "number", unit: "%", min: 0, max: 100, step: 1 })
const usd = (path: string, label: string, help?: string): Field => ({ path, label, help, type: "number", unit: "USD", min: 0, step: 0.5 })
const bool = (path: string, label: string, help?: string): Field => ({ path, label, help, type: "bool" })

/** Only these can be changed from the dashboard. Everything else, and every locked setting, stays in opencode.jsonc. */
export const GROUPS: Group[] = [
  {
    id: "routing",
    title: "Routing",
    fields: [
      bool("enabled", "Route between providers", "Off leaves every session on the model it was given."),
      bool("dryRun", "Dry run", "Record and announce what routing would do, without moving any session."),
      { path: "onExhausted.mode", label: "When every provider is limited", type: "choice", options: [["wait", "Wait for the first one back"], ["fail", "Stop with an error"]] },
      { path: "onExhausted.maxWaitMs", label: "Longest wait", type: "number", unit: "minutes", min: 1, max: 24 * 60, step: 1, scale: MIN },
      { path: "switching.minStayMs", label: "Stay on a provider at least", help: "Keeps a session from moving back and forth.", type: "number", unit: "minutes", min: 0, max: 120, step: 1, scale: MIN },
      bool("health.enabled", "Pass over providers that keep failing", "A provider whose recent error rate is too high is skipped for a while."),
      bool("pace.enabled", "Pace guard", "Subagents pass over a plan that is on pace to run out, keeping it for the main session."),
    ],
  },
  {
    id: "plans",
    title: "Plans and usage checks",
    fields: [
      bool("claude.usageProbe", "Check Claude usage", "Reads the plan's windows with Claude Code's login."),
      pct("claude.cutoverAtPct", "Leave Claude at", "Routing moves away when a window reaches this."),
      pct("claude.warnAtPct", "Warn about Claude at"),
      bool("claude.avoidUsageCredits", "Leave Claude before usage credits are drawn"),
      pct("chatgpt.cutoverAtPct", "Leave ChatGPT at"),
      bool("copilot.usageProbe", "Check Copilot usage"),
      { path: "copilot.reserveFraction", label: "Keep this much of Copilot in reserve", type: "number", unit: "%", min: 0, max: 50, step: 0.5, scale: 0.01 },
      bool("copilot.avoidAdditionalCredits", "Leave Copilot before paid requests start"),
      pct("copilot.economyAtPct", "Copilot economy from", "Above this share used, Copilot is kept for cheaper models. 0 is off."),
      bool("openrouter.usageProbe", "Check OpenRouter credit"),
      usd("openrouter.reserveUsd", "Leave OpenRouter with", "Routing moves away when this much credit is left."),
      bool("local.healthCheck", "Check that local servers are running", "Ollama and LM Studio, on this machine only."),
    ],
  },
  {
    id: "spend",
    title: "Spending caps",
    help: "Pay-per-use providers only. 0 is no cap.",
    fields: [usd("spend.dailyUsd", "Daily cap"), usd("spend.monthlyUsd", "Monthly cap")],
  },
  {
    id: "notify",
    title: "Notifications",
    fields: [
      bool("notifications.enabled", "Notifications", "On the dashboard, in the menu bar and as terminal toasts."),
      bool("notifications.system", "Also as system notifications", "macOS and Linux."),
      bool("notifications.events.fallback", "When a session falls back"),
      bool("notifications.events.return", "When it returns"),
      bool("notifications.events.allLimited", "When every provider is limited"),
      bool("notifications.events.spendCap", "When a spending cap is reached"),
      bool("notifications.events.usageCheck", "When a usage check keeps failing"),
      bool("statusLine", "Status line in the terminal", "The session's provider and window use, under the prompt."),
      bool("dashboard.menubar", "Menu bar item", "OpenCode Desktop on macOS."),
    ],
  },
  {
    id: "telemetry",
    title: "Telemetry export",
    help: "Sent only to the collector set in opencode.jsonc, which can't be changed here. Nothing that identifies you is sent unless you fill it in below.",
    fields: [
      bool("telemetry.enabled", "Export to the collector"),
      { path: "telemetry.level", label: "What to send", type: "choice", options: [["totals", "Totals only"], ["events", "Totals and one record per fallback"]] },
      { path: "telemetry.projects", label: "Split by project", type: "choice", options: [["off", "No"], ["hashed", "By a hash of the folder"], ["names", "By folder name"]] },
      { path: "telemetry.identity.email", label: "Email", help: "\"git\" uses git config user.email.", type: "text", max: 254 },
      { path: "telemetry.identity.userId", label: "User ID", type: "text", max: 128 },
      { path: "telemetry.identity.organizationId", label: "Organisation ID", type: "text", max: 128 },
      bool("telemetry.identity.hostName", "Send this computer's name"),
    ],
  },
  {
    id: "data",
    title: "Stored data",
    help: "Days of detail to keep. Daily totals, requests, routing and sessions are kept for good.",
    fields: [
      { path: "retention.toolsDays", label: "Tool calls", type: "number", unit: "days", min: 1, max: 3650, step: 1 },
      { path: "retention.executionsDays", label: "Executions", type: "number", unit: "days", min: 1, max: 3650, step: 1 },
      { path: "retention.snapshotsDays", label: "Usage checks", type: "number", unit: "days", min: 1, max: 3650, step: 1 },
      { path: "retention.poolLogDays", label: "Provider state changes", type: "number", unit: "days", min: 1, max: 3650, step: 1 },
      { path: "log.level", label: "Log detail", type: "choice", options: [["warn", "Problems only"], ["info", "Normal"], ["debug", "Everything"]] },
    ],
  },
]

const FIELDS = new Map(GROUPS.flatMap((g) => g.fields.map((f) => [f.path, f] as const)))

const get = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined), obj)

/** Every field with its value now, the value opencode.jsonc gives (or the default), and whether the dashboard changed it. */
export function buildSettings(core: Core) {
  const stored = core.storedSettings()
  const configured = (path: string) => get(core.options, path)
  return {
    groups: GROUPS.map((g) => ({
      ...g,
      fields: g.fields.map((f) => ({ ...f, value: get(core.config, f.path), configured: configured(f.path), changed: get(stored, f.path) !== undefined })),
    })),
    locked: LOCKED_SETTINGS,
  }
}

/**
 * Check a value from the page against its field, then store it. `null` puts the setting back to what opencode.jsonc
 * says. Returns an error to show next to the field when the value is refused.
 */
export function applySetting(core: Core, path: unknown, raw: unknown): { ok: true } | { ok: false; error: string } {
  const f = typeof path === "string" ? FIELDS.get(path) : undefined
  if (!f) return { ok: false, error: "That setting can't be changed from the dashboard" }
  if (raw === null) return core.setSetting(f.path, undefined)
  let value: unknown
  switch (f.type) {
    case "bool":
      if (typeof raw !== "boolean") return { ok: false, error: "Should be on or off" }
      value = raw
      break
    case "choice":
      if (!f.options.some(([v]) => v === raw)) return { ok: false, error: "Not one of the choices" }
      value = raw
      break
    case "text":
      if (typeof raw !== "string" || raw.length > (f.max ?? 256) || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: `Should be text of at most ${f.max ?? 256} characters` }
      value = raw.trim()
      break
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, error: "Should be a number" }
      if ((f.min !== undefined && raw < f.min) || (f.max !== undefined && raw > f.max)) return { ok: false, error: `Should be between ${f.min ?? 0} and ${f.max ?? "any"}${f.unit ? ` ${f.unit}` : ""}` }
      value = f.scale ? Math.round(raw * f.scale * 1e6) / 1e6 : raw
      break
    }
  }
  // Set back to what opencode.jsonc gives: drop the override rather than store a copy of it.
  if (get(loadConfig(core.options).config, f.path) === value) return core.setSetting(f.path, undefined)
  return core.setSetting(f.path, value)
}

/** A secret for this process. The page gets it with the HTML; a page from anywhere else can't read it. */
export const TOKEN = crypto.randomBytes(24).toString("base64url")

/**
 * Writes must come from the dashboard page itself. Browsers send `Origin` (and `Sec-Fetch-Site`) on every cross-site
 * POST, and a page elsewhere can neither read the token nor send a JSON body without a preflight this server never
 * answers. The Host check that every request passes already stops DNS rebinding.
 */
export function writeAllowed(req: http.IncomingMessage, token?: boolean): boolean {
  if (req.method !== "POST" || req.headers["x-quota-router"] !== "1") return false
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return false
  const site = req.headers["sec-fetch-site"]
  if (site !== undefined && site !== "same-origin" && site !== "none") return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `http://${req.headers.host}`) return false
  if (token) {
    const given = Buffer.from(String(req.headers["x-quota-router-token"] ?? ""))
    const want = Buffer.from(TOKEN)
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false
  }
  return true
}
