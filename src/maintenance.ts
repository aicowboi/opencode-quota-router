// Background upkeep that keeps the store fast over years: daily rollups, cached session totals, retention.
import { localDay, type Store } from "./db.ts"

export type Retention = { toolsDays: number; executionsDays: number; snapshotsDays: number; poolLogDays: number }

/** One day's usage grouped the way the dashboard slices it. Shared by the rollup and by live reads of today. */
export const USAGE_SELECT = `
  SELECT st.day AS day, COALESCE(st.provider_id, 'other') AS provider, COALESCE(st.model_id, st.kind) AS model,
    COALESCE(se.directory, 'unknown') AS project, COALESCE(st.agent, se.agent, 'unknown') AS agent, st.kind AS kind,
    COUNT(*) AS steps, COALESCE(SUM(st.status = 'failed'), 0) AS failed,
    COALESCE(SUM(st.input), 0) AS input, COALESCE(SUM(st.output), 0) AS output, COALESCE(SUM(st.reasoning), 0) AS reasoning,
    COALESCE(SUM(st.cache_read), 0) AS cache_read, COALESCE(SUM(st.cache_write), 0) AS cache_write,
    COALESCE(SUM(st.cost_equiv), 0) AS equiv, COALESCE(SUM(st.cost_actual), 0) AS actual,
    COALESCE(SUM(CASE WHEN st.ended_at >= st.started_at THEN st.ended_at - st.started_at ELSE 0 END), 0) AS model_ms
  FROM steps st LEFT JOIN sessions se ON se.id = st.session_id`

export const TOOLS_SELECT = `
  SELECT day, COALESCE(name, 'unknown') AS name, COUNT(*) AS calls, COALESCE(SUM(status = 'failed'), 0) AS failed,
    COALESCE(SUM(CASE WHEN ended_at >= started_at THEN ended_at - started_at ELSE 0 END), 0) AS total_ms,
    COALESCE(SUM(ended_at IS NOT NULL), 0) AS timed
  FROM tools`

const GROUP = "GROUP BY 1, 2, 3, 4, 5, 6"

/** Mark a day's rollup and a session's cached totals as stale. Cheap; called on every write that changes usage. */
export function markDirty(store: Store, sessionID: string | undefined, at: number | undefined) {
  if (at) store.run("INSERT OR IGNORE INTO dirty_days (day) VALUES (?)", localDay(at))
  if (sessionID) store.run("UPDATE sessions SET dirty = 1 WHERE id = ? AND dirty = 0", sessionID)
}

/** Recompute the rollups of every day touched since the last run. Idempotent: each day is rebuilt from raw rows. */
export function rollupDirty(store: Store): number {
  const days = store.all<{ day: string }>("SELECT day FROM dirty_days LIMIT 400").map((r) => r.day)
  if (days.length === 0) return 0
  store.transaction(() => {
    for (const day of days) {
      store.run("DELETE FROM daily_usage WHERE day = ?", day)
      store.run(`INSERT INTO daily_usage ${USAGE_SELECT} WHERE st.day = ? ${GROUP}`, day)
      store.run("DELETE FROM daily_tools WHERE day = ?", day)
      store.run(`INSERT INTO daily_tools ${TOOLS_SELECT} WHERE day = ? GROUP BY 1, 2`, day)
      store.run("DELETE FROM dirty_days WHERE day = ?", day)
    }
  })
  return days.length
}

/** Refresh cached totals on session rows marked dirty, in batches. */
export function refreshSessions(store: Store, batch = 500): number {
  const ids = store.all<{ id: string }>("SELECT id FROM sessions WHERE dirty = 1 LIMIT ?", batch).map((r) => r.id)
  if (ids.length === 0) return 0
  const list = JSON.stringify(ids)
  store.transaction(() => {
    store.run(
      `UPDATE sessions SET first_at = a.first_at, last_at = a.last_at, tokens = a.tokens, equiv = a.equiv, actual = a.actual,
         steps = a.steps, failed = a.failed, models = a.models
       FROM (SELECT session_id, MIN(started_at) AS first_at, MAX(COALESCE(ended_at, started_at)) AS last_at,
               SUM(input + output + reasoning + cache_read + cache_write) AS tokens, SUM(cost_equiv) AS equiv, SUM(cost_actual) AS actual,
               COUNT(*) AS steps, SUM(status = 'failed') AS failed,
               GROUP_CONCAT(DISTINCT provider_id || '/' || model_id) AS models
             FROM steps WHERE session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id) AS a
       WHERE sessions.id = a.session_id`,
      list,
    )
    store.run(
      `UPDATE sessions SET fallbacks = (SELECT COUNT(*) FROM routing r WHERE r.session_id = sessions.id AND r.trigger IN ('failover', 'resume', 'wait', 'deferred')),
         busy_ms = (SELECT COALESCE(SUM(COALESCE(e.ended_at, e.started_at) - e.started_at), 0) FROM executions e WHERE e.session_id = sessions.id),
         dirty = 0
       WHERE id IN (SELECT value FROM json_each(?))`,
      list,
    )
  })
  return ids.length
}

/**
 * Drop bulky raw detail past its retention. Daily rollups keep the totals, so charts and breakdowns over long ranges
 * are unaffected. Steps, routing and sessions are kept for good: they are small and carry the history.
 */
export function prune(store: Store, now: number, r: Retention) {
  const day = 86_400_000
  const before = (days: number) => now - days * day
  store.transaction(() => {
    // Make sure the days about to lose raw tool rows are rolled up first.
    store.run("INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT day FROM tools WHERE started_at < ? AND day NOT IN (SELECT day FROM daily_tools)", before(r.toolsDays))
  })
  rollupDirty(store)
  store.transaction(() => {
    store.run("DELETE FROM tools WHERE started_at < ?", before(r.toolsDays))
    store.run("DELETE FROM executions WHERE started_at < ? AND ended_at IS NOT NULL", before(r.executionsDays))
    store.run("DELETE FROM pool_log WHERE at < ?", before(r.poolLogDays))
    // Old usage checks thin out to one per provider per hour.
    store.run(
      `DELETE FROM usage_snapshots WHERE at < ? AND id NOT IN (
         SELECT MAX(id) FROM usage_snapshots WHERE at < ? GROUP BY provider, at / 3600000)`,
      before(r.snapshotsDays),
      before(r.snapshotsDays),
    )
  })
}

/** Housekeeping SQLite recommends for long-lived databases. */
export function optimize(store: Store) {
  store.exec("PRAGMA optimize")
  store.exec("PRAGMA incremental_vacuum(2000)")
  store.exec("PRAGMA wal_checkpoint(TRUNCATE)")
}
