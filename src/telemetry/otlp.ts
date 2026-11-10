// OpenTelemetry export, the pure part: working out where to send from the settings and the standard OTEL_*
// environment variables, and building OTLP/HTTP JSON payloads. No network, no clock, no store.
//
// The payloads are written by hand to the OTLP JSON encoding (lowerCamelCase fields, 64-bit integers as strings), so
// the plugin needs no OpenTelemetry SDK.
import type { Config } from "../engine/config.ts"

export type Attrs = Record<string, string | number | boolean | undefined | null>
export type Point = { attrs: Attrs; value: number }
export type Metric = { name: string; description: string; unit: string; type: "sum" | "gauge"; points: Point[]; integer?: boolean }
export type LogEvent = { at: number; name: string; attrs: Attrs }

export type Resolved = {
  /** Problems that stop the export. Empty when it can run. */
  problems: string[]
  metricsUrl?: string
  logsUrl?: string
  /** Header values are secrets: never logged, never shown. */
  headers: Record<string, string>
  resource: Attrs
  intervalMs: number
  temporality: "delta" | "cumulative"
  level: "totals" | "events"
  projects: "off" | "hashed" | "names"
}

type Env = Record<string, string | undefined>

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

/** `k=v,k2=v2` as used by OTEL_EXPORTER_OTLP_HEADERS and OTEL_RESOURCE_ATTRIBUTES. Values are percent-decoded. */
export function parsePairs(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (text ?? "").split(",")) {
    const i = part.indexOf("=")
    if (i <= 0) continue
    const key = part.slice(0, i).trim()
    let value = part.slice(i + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch {}
    if (key && key !== "__proto__") out[key] = value
  }
  return out
}

/** A URL that is safe to send to: HTTPS, or plain HTTP to this machine only, and with no credentials in it. */
export function checkEndpoint(raw: string): { url?: URL; problem?: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { problem: "the telemetry endpoint is not a valid URL" }
  }
  if (url.username || url.password) return { problem: "the telemetry endpoint must not contain a user name or password; use telemetry.headers" }
  if (url.protocol === "https:") return { url }
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return { url }
  return { problem: `the telemetry endpoint must use https (plain http is only accepted for a collector on this machine): ${describeUrl(url)}` }
}

/** A URL for display: no query string, where some services carry a key. */
export const describeUrl = (url: URL | string | undefined) => {
  if (!url) return ""
  try {
    const u = new URL(String(url))
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return "(invalid)"
  }
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`

/**
 * Where and what to export. Settings win over the environment; the environment fills in what the settings leave out,
 * so a company-managed OTEL_* setup works once `telemetry.enabled` is true. The environment alone never turns it on.
 */
export function resolveTelemetry(config: Config, env: Env, version: string, identity: { email?: string; hostName?: string } = {}): Resolved {
  const t = config.telemetry
  const problems: string[] = []
  const signal = (name: string, s: "METRICS" | "LOGS") => env[`OTEL_EXPORTER_OTLP_${s}_${name}`] ?? env[`OTEL_EXPORTER_OTLP_${name}`]

  if (env.OTEL_SDK_DISABLED?.toLowerCase() === "true") problems.push("OTEL_SDK_DISABLED is set, so nothing is exported")

  for (const s of ["METRICS", "LOGS"] as const) {
    const protocol = t.protocol || signal("PROTOCOL", s) || "http/json"
    if (protocol !== "http/json" && !problems.some((p) => p.startsWith("quota-router sends")))
      problems.push(`quota-router sends OTLP as http/json only, and ${t.protocol ? "telemetry.protocol" : "OTEL_EXPORTER_OTLP_PROTOCOL"} asks for ${protocol}. A collector's OTLP/HTTP receiver also accepts JSON: set "telemetry": { "protocol": "http/json" }`)
  }

  // A configured endpoint, or OTEL_EXPORTER_OTLP_ENDPOINT, is a base URL; the per-signal variables are used as they are.
  const endpoint = (s: "METRICS" | "LOGS", path: string) => {
    if (t.endpoint) return join(t.endpoint, path)
    const own = env[`OTEL_EXPORTER_OTLP_${s}_ENDPOINT`]
    if (own) return own
    return env.OTEL_EXPORTER_OTLP_ENDPOINT ? join(env.OTEL_EXPORTER_OTLP_ENDPOINT, path) : undefined
  }
  const urls: Record<string, string | undefined> = {}
  for (const [s, path] of [["METRICS", "/v1/metrics"], ["LOGS", "/v1/logs"]] as const) {
    const raw = endpoint(s, path)
    if (!raw) continue
    const checked = checkEndpoint(raw)
    if (checked.problem && !problems.includes(checked.problem)) problems.push(checked.problem)
    else if (checked.url) urls[s] = checked.url.href
  }
  if (!urls.METRICS && !problems.length) problems.push('no endpoint: set "telemetry": { "endpoint": "https://…" } or OTEL_EXPORTER_OTLP_ENDPOINT')

  const headers: Record<string, string> = { ...parsePairs(env.OTEL_EXPORTER_OTLP_HEADERS), ...t.headers }
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) {
      problems.push(`telemetry header ${HEADER_NAME.test(name) ? name : "name"} is not valid`)
      delete headers[name]
    }
  }

  const interval = t.intervalMs || Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 60_000
  const preference = (t.temporality || env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE || "delta").toLowerCase()

  const resource: Attrs = {
    ...parsePairs(env.OTEL_RESOURCE_ATTRIBUTES),
    ...t.attributes,
    "service.name": env.OTEL_SERVICE_NAME || "quota-router",
    "service.version": version,
  }
  // Who and where: only what was asked for.
  if (identity.email) resource["user.email"] = identity.email
  if (t.identity.userId) resource["user.id"] = t.identity.userId
  if (t.identity.organizationId) resource["organization.id"] = t.identity.organizationId
  if (identity.hostName) resource["host.name"] = identity.hostName

  return {
    problems,
    metricsUrl: urls.METRICS,
    logsUrl: urls.LOGS,
    headers,
    resource,
    intervalMs: Math.max(10_000, Math.min(interval, 3_600_000)),
    temporality: preference === "cumulative" ? "cumulative" : "delta",
    level: t.level,
    projects: t.projects,
  }
}

// ---------- OTLP JSON ----------

const nanos = (ms: number) => `${Math.round(ms)}000000`

function anyValue(v: string | number | boolean) {
  if (typeof v === "boolean") return { boolValue: v }
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  return { stringValue: v }
}

export function attributes(attrs: Attrs) {
  return Object.entries(attrs)
    .filter((e): e is [string, string | number | boolean] => e[1] !== undefined && e[1] !== null && e[1] !== "")
    .map(([key, value]) => ({ key, value: anyValue(value) }))
}

const scope = (version: string) => ({ name: "quota-router", version })

/** One ExportMetricsServiceRequest. Sums cover `start` to `end`; gauges are read at `end`. */
export function metricsPayload(metrics: Metric[], o: { resource: Attrs; version: string; start: number; end: number; temporality: "delta" | "cumulative" }) {
  const point = (p: Point, m: Metric) => ({
    attributes: attributes(p.attrs),
    ...(m.type === "sum" ? { startTimeUnixNano: nanos(o.start) } : {}),
    timeUnixNano: nanos(o.end),
    ...(m.integer ? { asInt: String(Math.round(p.value)) } : { asDouble: p.value }),
  })
  return {
    resourceMetrics: [
      {
        resource: { attributes: attributes(o.resource) },
        scopeMetrics: [
          {
            scope: scope(o.version),
            metrics: metrics
              .filter((m) => m.points.length)
              .map((m) => ({
                name: m.name,
                description: m.description,
                unit: m.unit,
                ...(m.type === "sum"
                  ? { sum: { aggregationTemporality: o.temporality === "delta" ? 1 : 2, isMonotonic: true, dataPoints: m.points.map((p) => point(p, m)) } }
                  : { gauge: { dataPoints: m.points.map((p) => point(p, m)) } }),
              })),
          },
        ],
      },
    ],
  }
}

/** One ExportLogsServiceRequest: each event is a log record named by `eventName`. */
export function logsPayload(events: LogEvent[], o: { resource: Attrs; version: string; observed: number }) {
  return {
    resourceLogs: [
      {
        resource: { attributes: attributes(o.resource) },
        scopeLogs: [
          {
            scope: scope(o.version),
            logRecords: events.map((e) => ({
              timeUnixNano: nanos(e.at),
              observedTimeUnixNano: nanos(o.observed),
              severityNumber: 9,
              severityText: "INFO",
              eventName: e.name,
              body: { stringValue: e.name },
              attributes: attributes({ "event.name": e.name, ...e.attrs }),
            })),
          },
        ],
      },
    ],
  }
}

/** The key of one series: its metric and its attributes, in a fixed order. */
export const seriesKey = (name: string, attrs: Attrs) =>
  JSON.stringify([name, Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== "").sort(([a], [b]) => (a < b ? -1 : 1))])
