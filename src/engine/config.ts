import type { ModelRef, ProviderKind } from "./types.ts"

export type ProviderConfig = {
  priority: number
  kind: ProviderKind
  /** `never` keeps the provider out of automatic routing. */
  allow: "always" | "never"
  /** Cooldown when a window error carries no reset time. */
  windowCooldownMs: number
  /** Set by discovery: ranked by kind rather than by configuration. */
  discovered?: boolean
  /** The user set `kind`, so the connection method does not override it. */
  kindFromUser?: boolean
}

export type SpendCap = { dailyUsd: number; monthlyUsd: number }

export type Config = {
  enabled: boolean
  /** Record what routing would do without changing any session's model or retry. For trying the plugin out safely. */
  dryRun: boolean
  /** Providers the user configured explicitly; discovery never re-ranks these. */
  explicitProviders: string[]
  /** Rank and include every connected provider, not only configured ones. */
  discovery: { enabled: boolean }
  /** ChatGPT subscription (OpenAI signed in with ChatGPT): leave before a window is spent. */
  chatgpt: { cutoverAtPct: number; warnAtPct: number }
  providers: Record<string, ProviderConfig>
  /** Ordered equivalents, best first. Entries are `provider/model#variant`. */
  chains: Record<string, ModelRef[]>
  /** The chain an agent's sessions use, by agent name. Without an entry, the session's model decides the chain. */
  agents: Record<string, string>
  recovery: { skewMs: number }
  throttle: { maxWaitMs: number; inPlaceRetries: number; cooldownMs: number; maxCooldownMs: number }
  overload: { inPlaceRetries: number; cooldownMs: number; maxCooldownMs: number }
  billing: { probeAfterMs: number }
  onExhausted: { mode: "wait" | "fail"; maxWaitMs: number }
  contextFit: { safetyFactor: number }
  claude: {
    usageProbe: boolean
    /** Cut over before a window is spent, so usage credits are never drawn. */
    avoidUsageCredits: boolean
    cutoverAtPct: number
    warnAtPct: number
  }
  copilot: {
    usageProbe: boolean
    /** Cut over once included credits are spent, so additional paid credits are never drawn. */
    avoidAdditionalCredits: boolean
    /** Reserve kept back as a fraction of the monthly entitlement, to absorb in-flight requests. */
    reserveFraction: number
    /**
     * Included AI credits per month for this seat. 0 means use the plan's allowance (Business 1,900, Enterprise 3,900).
     * Business and Enterprise pool credits across the organisation; staying within your own share means your usage never
     * causes paid additional credits.
     */
    monthlyCredits: number
  }
  probes: { activeIntervalMs: number; idleIntervalMs: number; maxAgeAtTurnMs: number }
  headers: { observe: string[]; warnRemainingPct: number }
  /** `menubar` shows the macOS menu bar item (OpenCode Desktop only). */
  dashboard: { enabled: boolean; port: number; host: string; menubar: boolean }
  backfill: boolean
  /**
   * Limits on what pay-per-use providers may cost, in US dollars per local day and month. 0 means no limit. Once a
   * limit is reached, routing stops choosing that provider until the day or month ends.
   */
  spend: { dailyUsd: number; monthlyUsd: number; providers: Record<string, SpendCap> }
  /**
   * Things worth knowing about without watching the dashboard. They appear on the dashboard, in the menu bar and as
   * toasts in the terminal; `system` also posts them through the operating system. Each kind can be turned off.
   */
  notifications: { enabled: boolean; system: boolean; events: { fallback: boolean; return: boolean; allLimited: boolean; spendCap: boolean; usageCheck: boolean } }
  /**
   * Export to an OpenTelemetry collector (OTLP over HTTP, JSON). Off until `enabled` is true. Whatever is left empty
   * is read from the standard `OTEL_*` environment variables.
   */
  telemetry: {
    enabled: boolean
    /** Base URL of the collector; `/v1/metrics` and `/v1/logs` are added. */
    endpoint: string
    /** Only `http/json` is supported. Empty means: what the environment says, else `http/json`. */
    protocol: string
    /** Request headers, for example an API key. Values are never logged. */
    headers: Record<string, string>
    /** `totals` sends metrics only; `events` also sends one log record per limit, switch and recovery. */
    level: "totals" | "events"
    /** Whether usage is split by project: not at all, by a hash of its folder, or by its folder name. */
    projects: "off" | "hashed" | "names"
    /** Milliseconds between exports. 0 means OTEL_METRIC_EXPORT_INTERVAL, else one minute. */
    intervalMs: number
    /** `delta` or `cumulative`. Empty means OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, else `delta`. */
    temporality: string
    /** Who the data is about. All empty by default: nothing identifies you unless you ask for it. `email: "git"` reads `git config user.email`. */
    identity: { email: string; userId: string; organizationId: string; hostName: boolean }
    /** Extra resource attributes, for example `{ "team": "platform" }`. */
    attributes: Record<string, string>
  }
  /** Days of raw detail to keep. Daily rollups, steps, routing and sessions are kept for good. */
  retention: { toolsDays: number; executionsDays: number; snapshotsDays: number; poolLogDays: number }
  log: { level: "debug" | "info" | "warn" }
}

const HOUR = 3_600_000

export const DEFAULT_CHAINS: Record<string, string[]> = {
  // Opus 5.5 at medium effort is the reference. Each entry is the closest equivalent on that provider.
  // xAI: the SuperGrok / X subscription pool covers Grok 4.7, 4.6 and 4.5 (and Cursor's Composer, which is not on the
  // API). Grok 4.7 is xAI's top coding model; grok-build-0.1 is the cheapest pool option for the light tier. The 4.20 and
  // multi-agent models are never routed to.
  opus: [
    "claude-agent/opus#medium",
    "xai/grok-4.7#high",
    "github-copilot/claude-opus-5.5#medium",
    "anthropic/claude-opus-5-5#medium",
    "openai/gpt-6.1-sol#high",
  ],
  sonnet: [
    "claude-agent/sonnet#medium",
    "xai/grok-4.7#medium",
    "github-copilot/claude-sonnet-5.5#medium",
    "anthropic/claude-sonnet-5-5#medium",
    "openai/gpt-6.1-sol#medium",
  ],
  fable: [
    "claude-agent/fable#medium",
    "xai/grok-4.7#xhigh",
    "anthropic/claude-fable-5-1#medium",
    "openai/gpt-6-astra#medium",
  ],
  haiku: [
    "claude-agent/haiku#medium",
    "xai/grok-build-0.1",
    "github-copilot/claude-haiku-5.5#medium",
    "anthropic/claude-haiku-5-5#medium",
    "openai/gpt-6-luna#medium",
  ],
}

export const DEFAULTS: Config = {
  enabled: true,
  dryRun: false,
  explicitProviders: [],
  discovery: { enabled: true },
  chatgpt: { cutoverAtPct: 98, warnAtPct: 85 },
  providers: {
    "claude-agent": { priority: 1, kind: "subscription", allow: "always", windowCooldownMs: 15 * 60_000 },
    xai: { priority: 2, kind: "subscription", allow: "always", windowCooldownMs: 6 * HOUR },
    "github-copilot": { priority: 3, kind: "subscription", allow: "always", windowCooldownMs: 30 * 60_000 },
    anthropic: { priority: 4, kind: "metered", allow: "always", windowCooldownMs: 15 * 60_000 },
    openai: { priority: 5, kind: "metered", allow: "always", windowCooldownMs: 30 * 60_000 },
  },
  chains: Object.fromEntries(Object.entries(DEFAULT_CHAINS).map(([k, v]) => [k, v.map(parseRef)])),
  agents: {},
  recovery: { skewMs: 60_000 },
  throttle: { maxWaitMs: 20_000, inPlaceRetries: 2, cooldownMs: 60_000, maxCooldownMs: 10 * 60_000 },
  overload: { inPlaceRetries: 2, cooldownMs: 2 * 60_000, maxCooldownMs: 10 * 60_000 },
  billing: { probeAfterMs: 6 * HOUR },
  onExhausted: { mode: "wait", maxWaitMs: 30 * 60_000 },
  contextFit: { safetyFactor: 1.15 },
  claude: { usageProbe: false, avoidUsageCredits: true, cutoverAtPct: 98, warnAtPct: 85 },
  copilot: { usageProbe: false, avoidAdditionalCredits: true, reserveFraction: 0.01, monthlyCredits: 0 },
  probes: { activeIntervalMs: 3 * 60_000, idleIntervalMs: 15 * 60_000, maxAgeAtTurnMs: 60_000 },
  headers: { observe: ["anthropic", "github-copilot"], warnRemainingPct: 5 },
  dashboard: { enabled: true, port: 47321, host: "127.0.0.1", menubar: true },
  backfill: true,
  spend: { dailyUsd: 0, monthlyUsd: 0, providers: {} },
  telemetry: {
    enabled: false, endpoint: "", protocol: "", headers: {}, level: "totals", projects: "off", intervalMs: 0, temporality: "",
    identity: { email: "", userId: "", organizationId: "", hostName: false }, attributes: {},
  },
  notifications: { enabled: true, system: false, events: { fallback: true, return: true, allLimited: true, spendCap: true, usageCheck: true } },
  retention: { toolsDays: 400, executionsDays: 400, snapshotsDays: 90, poolLogDays: 730 },
  log: { level: "info" },
}

/** `provider/model#variant`. Model IDs may contain `/` (gateways), so only the first `/` splits. */
export function parseRef(text: string): ModelRef {
  const hash = text.lastIndexOf("#")
  const body = hash === -1 ? text : text.slice(0, hash)
  const variant = hash === -1 ? undefined : text.slice(hash + 1)
  const slash = body.indexOf("/")
  if (slash <= 0 || slash === body.length - 1) throw new Error(`Invalid model reference "${text}"`)
  return { providerID: body.slice(0, slash), id: body.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export const refKey = (ref: { providerID: string; id: string }) => `${ref.providerID}/${ref.id}`
export const refLabel = (ref: ModelRef) => `${refKey(ref)}${ref.variant && ref.variant !== "default" ? `#${ref.variant}` : ""}`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Settings that only take effect from `opencode.jsonc`: changing where the dashboard listens needs a restart and a
 * deliberate edit, and where telemetry is sent must not be changeable by anything that can reach the dashboard.
 */
export const LOCKED_SETTINGS = ["dashboard.host", "dashboard.port", "explicitProviders", "telemetry.endpoint", "telemetry.headers"]

/** Lay one options object over another. Objects merge key by key; anything else in `patch` replaces the base value. */
export function overlay(base: unknown, patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(base) ? { ...base } : {}
  if (!isObject(patch)) return out
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue
    out[key] = isObject(value) && isObject(out[key]) ? overlay(out[key], value) : value
  }
  return out
}

/** A copy of `settings` with the dotted `path` set to `value`, or removed when `value` is undefined. Empty parents are dropped. */
export function withSetting(settings: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".")
  const out = { ...settings }
  if (rest.length === 0) {
    if (value === undefined) delete out[head]
    else out[head] = value
    return out
  }
  const child = withSetting(isObject(out[head]) ? out[head] : {}, rest.join("."), value)
  if (Object.keys(child).length) out[head] = child
  else delete out[head]
  return out
}

/**
 * Check a change to the stored settings before it is saved. A change is refused when it touches a locked setting, or
 * when the resulting configuration would report a problem that was not there before.
 */
export function checkSetting(options: unknown, stored: Record<string, unknown>, path: string, value: unknown): { ok: true; stored: Record<string, unknown> } | { ok: false; error: string } {
  const parts = path.split(".")
  if (!path || parts.some((p) => !p || UNSAFE_KEYS.has(p))) return { ok: false, error: `"${path}" is not a setting` }
  if (LOCKED_SETTINGS.some((l) => path === l || path.startsWith(`${l}.`) || l.startsWith(`${path}.`))) return { ok: false, error: `${path} can only be changed in opencode.jsonc` }
  const bad = (v: unknown): boolean => (typeof v === "number" ? !Number.isFinite(v) || v < 0 : Array.isArray(v) ? v.some(bad) : isObject(v) ? Object.values(v).some(bad) : false)
  if (bad(value)) return { ok: false, error: `${path} must be a number of zero or more` }
  const next = withSetting(stored, path, value)
  const before = new Set(loadConfig(overlay(options, stored)).warnings)
  const problem = loadConfig(overlay(options, next)).warnings.find((w) => !before.has(w))
  return problem ? { ok: false, error: problem } : { ok: true, stored: next }
}

function merge<T>(base: T, patch: unknown, path: string, warnings: string[]): T {
  if (!isObject(patch)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    const current = UNSAFE_KEYS.has(key) ? undefined : out[key]
    if (current === undefined) {
      warnings.push(`Unknown option ${path}${key} ignored`)
      continue
    }
    if (isObject(current) && isObject(value)) out[key] = merge(current, value, `${path}${key}.`, warnings)
    else if (typeof current === typeof value || (Array.isArray(current) && Array.isArray(value))) out[key] = value
    else warnings.push(`Option ${path}${key} should be ${Array.isArray(current) ? "an array" : typeof current}; default kept`)
  }
  return out as T
}

/** Merge plugin options over the defaults. Invalid entries are reported and skipped, never fatal. */
export function loadConfig(options: unknown): { config: Config; warnings: string[] } {
  const warnings: string[] = []
  const opts = isObject(options) ? { ...options } : {}
  const rawChains = opts.chains
  const rawProviders = opts.providers
  const rawAgents = opts.agents
  delete opts.chains
  delete opts.agents
  delete opts.providers
  delete opts.explicitProviders
  // Per-provider caps are keyed by provider ID, so they are read separately from the fixed options.
  const rawCaps = isObject(opts.spend) ? opts.spend.providers : undefined
  if (isObject(opts.spend)) opts.spend = { ...opts.spend, providers: {} }
  // Telemetry headers and attributes are free-form maps of strings.
  const rawTelemetry = isObject(opts.telemetry) ? opts.telemetry : undefined
  if (rawTelemetry) opts.telemetry = { ...rawTelemetry, headers: {}, attributes: {} }
  const config = merge(DEFAULTS, opts, "", warnings)

  config.providers = { ...DEFAULTS.providers }
  config.explicitProviders = isObject(rawProviders) ? Object.keys(rawProviders) : []
  if (isObject(rawProviders)) {
    for (const [id, value] of Object.entries(rawProviders)) {
      const base: ProviderConfig = DEFAULTS.providers[id] ?? { priority: 99, kind: "metered", allow: "always", windowCooldownMs: 15 * 60_000 }
      config.providers[id] = merge(base, value, `providers.${id}.`, warnings)
      if (isObject(value) && "kind" in value) config.providers[id].kindFromUser = true
    }
  }

  config.spend = { ...config.spend, providers: {} }
  if (isObject(rawCaps)) {
    for (const [id, value] of Object.entries(rawCaps)) {
      if (!UNSAFE_KEYS.has(id)) config.spend.providers[id] = merge({ dailyUsd: 0, monthlyUsd: 0 }, value, `spend.providers.${id}.`, warnings)
    }
  } else if (rawCaps !== undefined) warnings.push("spend.providers should be an object of provider: { dailyUsd, monthlyUsd }; ignored")

  config.telemetry = { ...config.telemetry, headers: {}, attributes: {} }
  for (const name of ["headers", "attributes"] as const) {
    const raw = rawTelemetry?.[name]
    if (raw === undefined) continue
    if (!isObject(raw)) warnings.push(`telemetry.${name} should be an object of name: value; ignored`)
    else
      for (const [key, value] of Object.entries(raw)) {
        if (UNSAFE_KEYS.has(key)) continue
        if (typeof value === "string") config.telemetry[name][key] = value
        else warnings.push(`telemetry.${name}.${key} should be a string; ignored`)
      }
  }
  const choice = <K extends "level" | "projects">(key: K, allowed: string[]) => {
    if (allowed.includes(config.telemetry[key])) return
    warnings.push(`telemetry.${key} should be one of ${allowed.join(", ")}; default kept`)
    config.telemetry[key] = DEFAULTS.telemetry[key]
  }
  choice("level", ["totals", "events"])
  choice("projects", ["off", "hashed", "names"])
  if (!["", "http/json", "http/protobuf", "grpc"].includes(config.telemetry.protocol)) {
    warnings.push("telemetry.protocol should be http/json; default kept")
    config.telemetry.protocol = ""
  }
  if (!["", "delta", "cumulative"].includes(config.telemetry.temporality)) {
    warnings.push("telemetry.temporality should be delta or cumulative; default kept")
    config.telemetry.temporality = ""
  }

  config.chains = { ...DEFAULTS.chains }
  if (isObject(rawChains)) {
    for (const [name, entries] of Object.entries(rawChains)) {
      if (entries === null || entries === false) {
        delete config.chains[name]
        continue
      }
      // `{ "<provider>": "<model#variant>" | null }` changes or removes one provider's entry and keeps the rest.
      if (isObject(entries)) {
        const chain = [...(config.chains[name] ?? [])]
        for (const [providerID, value] of Object.entries(entries)) {
          const at = chain.findIndex((r) => r.providerID === providerID)
          if (value === null || value === false) {
            if (at !== -1) chain.splice(at, 1)
            continue
          }
          try {
            const ref = parseRef(String(value).includes("/") ? String(value) : `${providerID}/${value}`)
            if (ref.providerID !== providerID) throw new Error(`"${value}" is not a ${providerID} model`)
            if (at === -1) chain.push(ref)
            else chain[at] = ref
          } catch (error) {
            warnings.push(`chains.${name}.${providerID}: ${(error as Error).message}`)
          }
        }
        config.chains[name] = chain
        continue
      }
      if (!Array.isArray(entries)) {
        warnings.push(`chains.${name} should be a list, or an object of provider: model; ignored`)
        continue
      }
      const refs: ModelRef[] = []
      for (const entry of entries) {
        try {
          refs.push(parseRef(String(entry)))
        } catch (error) {
          warnings.push(`chains.${name}: ${(error as Error).message}`)
        }
      }
      config.chains[name] = refs
    }
  }

  config.agents = {}
  if (isObject(rawAgents)) {
    for (const [agent, chain] of Object.entries(rawAgents)) {
      if (UNSAFE_KEYS.has(agent) || chain === null) continue
      if (typeof chain !== "string") warnings.push(`agents.${agent} should be the name of a chain; ignored`)
      else if (!Object.hasOwn(config.chains, chain)) warnings.push(`agents.${agent}: there is no chain named ${chain}; ignored`)
      else config.agents[agent] = chain
    }
  } else if (rawAgents !== undefined) warnings.push("agents should be an object of agent: chain; ignored")
  return { config, warnings }
}
