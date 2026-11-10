// Read models for the dashboard. Ranges longer than a day read daily rollups plus today's raw rows, so queries stay
// fast however much history accumulates. Lists are paginated with keyset cursors.
import { COPILOT_CREDITS_PER_USD } from "../engine/policy.ts"
import { localDay, type Store } from "../db.ts"
import { TOOLS_SELECT, USAGE_SELECT } from "../maintenance.ts"

export const RANGES = ["today", "24h", "7d", "30d", "90d", "1y", "all"] as const
const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 }

export type Range = { name: string; fromMs: number; fromDay: string; today: string; raw: boolean }

export function resolveRange(name: string, now = Date.now()): Range {
  const today = localDay(now)
  const midnight = new Date(new Date(now).setHours(0, 0, 0, 0))
  if (name === "today") return { name, fromMs: midnight.getTime(), fromDay: today, today, raw: true }
  if (name === "24h") return { name, fromMs: now - 86_400_000, fromDay: localDay(now - 86_400_000), today, raw: true }
  if (name === "all") return { name, fromMs: 0, fromDay: "0000-00-00", today, raw: false }
  const days = RANGE_DAYS[name] ?? 7
  const from = new Date(midnight)
  from.setDate(from.getDate() - (days - 1))
  return { name: RANGE_DAYS[name] ? name : "7d", fromMs: from.getTime(), fromDay: localDay(from.getTime()), today, raw: false }
}

/** Back-compat for callers that only need the start time. */
export const rangeStart = (name: string, now = Date.now()) => resolveRange(name, now).fromMs

const COLS = "day, provider, model, project, agent, kind, steps, failed, input, output, reasoning, cache_read, cache_write, equiv, actual, model_ms"
const GROUP = "GROUP BY 1, 2, 3, 4, 5, 6"

/** `u`: usage rows for the range, one per day × provider × model × project × agent × kind. */
function usage(r: Range): { cte: string; params: unknown[] } {
  if (r.raw)
    return r.name === "24h"
      ? { cte: `WITH u AS (${USAGE_SELECT} WHERE st.started_at >= ? ${GROUP})`, params: [r.fromMs] }
      : { cte: `WITH u AS (${USAGE_SELECT} WHERE st.day = ? ${GROUP})`, params: [r.today] }
  return {
    cte: `WITH u AS (SELECT ${COLS} FROM daily_usage WHERE day >= ? AND day < ? UNION ALL ${USAGE_SELECT} WHERE st.day = ? ${GROUP})`,
    params: [r.fromDay, r.today, r.today],
  }
}

const SUMS = `COALESCE(SUM(steps), 0) AS steps, COALESCE(SUM(failed), 0) AS failed, COALESCE(SUM(input), 0) AS input,
  COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning, COALESCE(SUM(cache_read), 0) AS cache_read,
  COALESCE(SUM(cache_write), 0) AS cache_write, COALESCE(SUM(input + output + reasoning + cache_read + cache_write), 0) AS tokens,
  COALESCE(SUM(equiv), 0) AS equiv, COALESCE(SUM(actual), 0) AS actual, COALESCE(SUM(model_ms), 0) AS model_ms`

export function summary(store: Store, r: Range) {
  const u = usage(r)
  const totals = store.get<Record<string, number>>(`${u.cte} SELECT ${SUMS} FROM u`, ...u.params) ?? {}
  const sessions = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE last_at >= ?", r.fromMs)?.n ?? 0
  const routing = store.all<{ trigger: string; n: number }>("SELECT trigger, COUNT(*) AS n FROM routing WHERE at >= ? AND dry = 0 GROUP BY trigger", r.fromMs)
  return {
    ...(totals as { tokens: number; input: number; output: number; reasoning: number; cache_read: number; cache_write: number; equiv: number; actual: number; steps: number; failed: number }),
    modelMs: totals.model_ms ?? 0,
    sessions,
    routing: Object.fromEntries(routing.map((x) => [x.trigger, x.n])),
  }
}

/** Chart buckets: hours for a day, days up to 90 days, weeks up to a year or so, months beyond. */
export function bucketFor(r: Range, store: Store): "hour" | "day" | "week" | "month" {
  if (r.raw) return "hour"
  if (r.name === "7d" || r.name === "30d" || r.name === "90d") return "day"
  if (r.name === "1y") return "week"
  const first = store.get<{ day: string }>("SELECT MIN(day) AS day FROM daily_usage")?.day
  const span = first ? (Date.now() - Date.parse(`${first}T00:00:00`)) / 86_400_000 : 0
  return span > 400 ? "month" : span > 90 ? "week" : "day"
}

export function series(store: Store, r: Range) {
  const bucket = bucketFor(r, store)
  if (bucket === "hour") {
    const where = r.name === "24h" ? "started_at >= ?" : "day = ?"
    return {
      bucket,
      rows: store.all(
        `SELECT strftime('%Y-%m-%d %H:00', started_at / 1000, 'unixepoch', 'localtime') AS bucket, COALESCE(provider_id, 'other') AS provider,
           COALESCE(SUM(input + output + reasoning + cache_read + cache_write), 0) AS tokens, COALESCE(SUM(cost_equiv), 0) AS equiv,
           COALESCE(SUM(cost_actual), 0) AS actual, COUNT(*) AS steps
         FROM steps WHERE ${where} GROUP BY 1, 2 ORDER BY 1`,
        r.name === "24h" ? r.fromMs : r.today,
      ),
    }
  }
  const key = bucket === "day" ? "day" : bucket === "week" ? "date(day, 'weekday 1', '-7 days')" : "substr(day, 1, 7)"
  const u = usage(r)
  return {
    bucket,
    rows: store.all(`${u.cte} SELECT ${key} AS bucket, provider, ${SUMS} FROM u GROUP BY 1, 2 ORDER BY 1`, ...u.params),
  }
}

const BY: Record<string, string> = {
  provider: "provider",
  model: "provider || '/' || model",
  project: "project",
  agent: "agent",
}

/** Top rows by tokens, with the number of rows in total so the UI can offer "show all". */
export function breakdown(store: Store, r: Range, by: string, limit = 25) {
  const key = BY[by] ?? BY.model
  const u = usage(r)
  const rows = store.all(`${u.cte} SELECT ${key} AS key, ${SUMS}, CASE WHEN SUM(steps) > 0 THEN SUM(model_ms) / SUM(steps) ELSE 0 END AS avg_ms FROM u GROUP BY 1 ORDER BY tokens DESC LIMIT ?`, ...u.params, limit)
  const total = store.get<{ n: number }>(`${u.cte} SELECT COUNT(DISTINCT ${key}) AS n FROM u`, ...u.params)?.n ?? rows.length
  return { rows, total }
}

export function tools(store: Store, r: Range, limit = 25) {
  const t = r.raw
    ? { cte: `WITH t AS (${TOOLS_SELECT} WHERE ${r.name === "24h" ? "started_at >= ?" : "day = ?"} GROUP BY 1, 2)`, params: [r.name === "24h" ? r.fromMs : r.today] }
    : { cte: `WITH t AS (SELECT day, name, calls, failed, total_ms, timed FROM daily_tools WHERE day >= ? AND day < ? UNION ALL ${TOOLS_SELECT} WHERE day = ? GROUP BY 1, 2)`, params: [r.fromDay, r.today, r.today] }
  const rows = store.all(
    `${t.cte} SELECT name, SUM(calls) AS calls, SUM(failed) AS failed, SUM(total_ms) AS total_ms,
       CASE WHEN SUM(timed) > 0 THEN SUM(total_ms) / SUM(timed) ELSE 0 END AS avg_ms FROM t GROUP BY name ORDER BY calls DESC LIMIT ?`,
    ...t.params,
    limit,
  )
  const total = store.get<{ n: number }>(`${t.cte} SELECT COUNT(DISTINCT name) AS n FROM t`, ...t.params)?.n ?? rows.length
  return { rows, total }
}

/** Sessions active in the range, newest first. Totals are the session's lifetime totals (cached on the row). */
export function sessions(store: Store, r: Range, opts: { cursor?: string; q?: string; limit?: number; project?: string; day?: string } = {}) {
  const limit = Math.min(opts.limit ?? 25, 100)
  const params: unknown[] = [r.fromMs]
  let where = "last_at >= ? AND deleted_at IS NULL"
  if (opts.project !== undefined) {
    where += " AND COALESCE(directory, '') = ?"
    params.push(opts.project)
  }
  if (opts.day) {
    where += " AND last_at >= ? AND last_at < ?"
    const start = new Date(`${opts.day}T00:00:00`).getTime()
    const next = new Date(`${opts.day}T00:00:00`)
    next.setDate(next.getDate() + 1)
    params.push(start, next.getTime())
  }
  if (opts.q) {
    where += " AND (title LIKE ? ESCAPE '\\' OR directory LIKE ? ESCAPE '\\' OR id = ? OR models LIKE ? ESCAPE '\\')"
    const like = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    params.push(like, like, opts.q, like)
  }
  if (opts.cursor) {
    const [at, id] = opts.cursor.split("|")
    where += " AND (last_at < ? OR (last_at = ? AND id < ?))"
    params.push(Number(at), Number(at), id)
  }
  const rows = store.all<Record<string, any>>(
    `SELECT id, title, directory, parent_id, agent, first_at, last_at, tokens, equiv, actual, steps, failed, models, fallbacks, busy_ms
     FROM sessions WHERE ${where} ORDER BY last_at DESC, id DESC LIMIT ?`,
    ...params,
    limit + 1,
  )
  const more = rows.length > limit
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return { rows: page, next: more && last ? `${last.last_at}|${last.id}` : undefined }
}

/** Sessions active in the range, grouped by project or by day of last activity, with totals per group. */
export function sessionGroups(store: Store, r: Range, by: "project" | "day", q?: string) {
  const key = by === "day" ? "strftime('%Y-%m-%d', last_at / 1000, 'unixepoch', 'localtime')" : "COALESCE(directory, '')"
  const params: unknown[] = [r.fromMs]
  let where = "last_at >= ? AND deleted_at IS NULL"
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where += " AND (title LIKE ? ESCAPE '\\' OR directory LIKE ? ESCAPE '\\' OR id = ? OR models LIKE ? ESCAPE '\\')"
    params.push(like, like, q, like)
  }
  return store.all(
    `SELECT ${key} AS key, COUNT(*) AS sessions, SUM(tokens) AS tokens, SUM(equiv) AS equiv, SUM(actual) AS actual, SUM(steps) AS steps,
       SUM(fallbacks) AS fallbacks, SUM(busy_ms) AS busy_ms, MAX(last_at) AS last_at
     FROM sessions WHERE ${where} GROUP BY 1 ORDER BY last_at DESC LIMIT 400`,
    ...params,
  )
}

const TRIGGER_FILTERS: Record<string, string[]> = {
  fallback: ["failover", "resume", "wait", "deferred", "exhausted", "gave-up"],
  return: ["recovery"],
  moved: ["preempt", "route"],
  manual: ["manual"],
}

/** Dry-run rows read as their own kind of change (`dry:failover`), so they are never mixed with what really happened. */
const TRIGGER = "CASE WHEN dry = 1 THEN 'dry:' || trigger ELSE trigger END"

export function routingSummary(store: Store, r: Range) {
  const rows = store.all<{ trigger: string; n: number }>(`SELECT ${TRIGGER} AS trigger, COUNT(*) AS n FROM routing WHERE at >= ? GROUP BY 1`, r.fromMs)
  const by = Object.fromEntries(rows.map((x) => [x.trigger, x.n]))
  const count = (k: string) => TRIGGER_FILTERS[k].reduce((s, t) => s + (by[t] ?? 0), 0)
  const dry = rows.filter((x) => x.trigger.startsWith("dry:")).reduce((s, x) => s + x.n, 0)
  return { all: rows.reduce((s, x) => s + x.n, 0), fallback: count("fallback"), return: count("return"), moved: count("moved"), manual: count("manual"), dry }
}

/** One row per day with counts of each kind of change, newest first, paginated by day. */
export function routingDays(store: Store, r: Range, opts: { filter?: string; before?: string; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 14, 60)
  const t = triggerWhere(opts.filter)
  const day = "strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime')"
  const rows = store.all<{ day: string; trigger: string; n: number; sessions: number }>(
    `SELECT ${day} AS day, ${TRIGGER} AS trigger, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions FROM routing
     WHERE at >= ?${t.sql} ${opts.before ? `AND ${day} < ?` : ""} GROUP BY 1, 2 ORDER BY 1 DESC`,
    r.fromMs,
    ...t.params,
    ...(opts.before ? [opts.before] : []),
  )
  const days: Array<{ day: string; total: number; counts: Record<string, number> }> = []
  for (const row of rows) {
    let d = days.at(-1)
    if (!d || d.day !== row.day) {
      if (days.length === limit) break
      days.push((d = { day: row.day, total: 0, counts: {} }))
    }
    d.total += row.n
    d.counts[row.trigger] = row.n
  }
  const more = rows.some((row) => days.length === limit && row.day < days[limit - 1]?.day)
  return { days, next: more ? days.at(-1)?.day : undefined }
}

const triggerWhere = (filter?: string) => {
  if (filter === "dry") return { sql: " AND dry = 1", params: [] as unknown[] }
  const list = filter ? TRIGGER_FILTERS[filter] : undefined
  return list ? { sql: ` AND dry = 0 AND trigger IN (${list.map(() => "?").join(", ")})`, params: [...list] as unknown[] } : { sql: "", params: [] as unknown[] }
}

/**
 * Routing changes grouped by day, kind of change, and from → to: "Fallback claude-agent/opus → xai/grok ×7 in 3 sessions".
 * Paginated by the group's latest time.
 */
export function routingGroups(store: Store, r: Range, opts: { filter?: string; before?: number; limit?: number; day?: string } = {}) {
  const limit = Math.min(opts.limit ?? 20, 100)
  const t = triggerWhere(opts.filter)
  if (opts.day) {
    // The range narrows the index scan; the day expression makes the cut exact across daylight-saving changes.
    const start = new Date(`${opts.day}T00:00:00`).getTime()
    t.sql += " AND at >= ? AND at < ? AND strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') = ?"
    t.params = [...t.params, start, start + 25 * 3_600_000, opts.day]
  }
  const groups = store.all<Record<string, any>>(
    `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS day, ${TRIGGER} AS trigger, COALESCE(from_model, '') AS from_model,
       COALESCE(to_model, '') AS to_model, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions, MIN(at) AS first_at, MAX(at) AS last_at,
       MAX(id) AS last_id, MAX(until) AS until
     FROM routing WHERE at >= ?${t.sql} GROUP BY 1, 2, 3, 4 ${opts.before ? "HAVING MAX(at) < ?" : ""} ORDER BY last_at DESC LIMIT ?`,
    r.fromMs,
    ...t.params,
    ...(opts.before ? [opts.before] : []),
    limit + 1,
  )
  const more = groups.length > limit
  const page = groups.slice(0, limit)
  for (const g of page) {
    const last = store.get<{ evidence: string; title: string; session_id: string }>(
      "SELECT r.evidence, r.session_id, se.title FROM routing r LEFT JOIN sessions se ON se.id = r.session_id WHERE r.id = ?",
      g.last_id,
    )
    g.evidence = last?.evidence
    g.title = last?.title
    g.session_id = last?.session_id
  }
  return { groups: page, next: more ? page.at(-1)?.last_at : undefined }
}

/** The individual events of one group, newest first. */
export function routingEvents(store: Store, q: { day: string; trigger: string; from: string; to: string; beforeId?: number; limit?: number }) {
  const limit = Math.min(q.limit ?? 20, 100)
  const start = new Date(`${q.day}T00:00:00`).getTime()
  const end = start + 86_400_000 + 3_600_000 // daylight-saving days can be 25 hours
  const rows = store.all<Record<string, any>>(
    `SELECT r.id, r.at, r.session_id, r.evidence, r.until, r.pool, se.title FROM routing r LEFT JOIN sessions se ON se.id = r.session_id
     WHERE r.at >= ? AND r.at < ? AND ${TRIGGER} = ? AND COALESCE(r.from_model, '') = ? AND COALESCE(r.to_model, '') = ?
       AND strftime('%Y-%m-%d', r.at / 1000, 'unixepoch', 'localtime') = ? ${q.beforeId ? "AND r.id < ?" : ""}
     ORDER BY r.id DESC LIMIT ?`,
    start,
    end,
    q.trigger,
    q.from,
    q.to,
    q.day,
    ...(q.beforeId ? [q.beforeId] : []),
    limit + 1,
  )
  const more = rows.length > limit
  const page = rows.slice(0, limit)
  return { rows: page, next: more ? page.at(-1)?.id : undefined }
}

/** Copilot AI credits by model since a time, estimated from recorded tokens at each model's list price. */
export function copilotCredits(store: Store, fromMs: number, limit = 4) {
  return store
    .all<{ model: string; usd: number }>("SELECT model_id AS model, SUM(cost_equiv) AS usd FROM steps WHERE provider_id = 'github-copilot' AND started_at >= ? GROUP BY model_id HAVING usd > 0 ORDER BY usd DESC LIMIT ?", fromMs, limit)
    .map((r) => ({ model: r.model, credits: Math.round(r.usd * COPILOT_CREDITS_PER_USD) }))
}

export function usageHistory(store: Store, provider: string, fromMs: number) {
  // At most ~400 points: thin evenly over long ranges.
  const n = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_snapshots WHERE provider = ? AND at >= ?", provider, fromMs)?.n ?? 0
  const step = Math.max(1, Math.ceil(n / 400))
  return store
    .all<{ at: number; data: string }>(
      `SELECT at, data FROM (SELECT at, data, ROW_NUMBER() OVER (ORDER BY at) AS rn FROM usage_snapshots WHERE provider = ? AND at >= ?) WHERE rn % ? = 0 OR rn = 1 ORDER BY at`,
      provider,
      fromMs,
      step,
    )
    .map((row) => ({ at: row.at, data: JSON.parse(row.data) }))
}

export function poolHistory(store: Store, fromMs: number) {
  return store.all("SELECT * FROM pool_log WHERE at >= ? ORDER BY at DESC LIMIT 500", fromMs)
}

/** CSV export, streamed in pages so a years-long export never loads the whole table into memory. */
export function* csv(store: Store, table: string, fromMs: number): Generator<string> {
  const specs: Record<string, { sql: string; time: string }> = {
    steps: { sql: "SELECT * FROM steps", time: "started_at" },
    routing: { sql: "SELECT * FROM routing", time: "at" },
    executions: { sql: "SELECT * FROM executions", time: "started_at" },
    sessions: { sql: "SELECT id, parent_id, project_id, directory, title, agent, created_at, first_at, last_at, tokens, equiv, actual, steps, failed, models, fallbacks, busy_ms FROM sessions", time: "COALESCE(last_at, created_at, 0)" },
    daily: { sql: "SELECT * FROM daily_usage", time: "CAST(strftime('%s', day) AS INTEGER) * 1000" },
  }
  const spec = specs[table] ?? specs.steps
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  let offset = 0
  let header = true
  for (;;) {
    const rows = store.all<Record<string, unknown>>(`${spec.sql} WHERE ${spec.time} >= ? ORDER BY ${spec.time} LIMIT 5000 OFFSET ?`, fromMs, offset)
    if (rows.length === 0) return
    const cols = Object.keys(rows[0])
    if (header) {
      yield cols.join(",") + "\n"
      header = false
    }
    yield rows.map((row) => cols.map((c) => esc(row[c])).join(",")).join("\n") + "\n"
    offset += rows.length
  }
}
