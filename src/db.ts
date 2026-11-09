// Local SQLite store for the dashboard and for pool state. bun:sqlite inside OpenCode, node:sqlite in tests.
//
// Built to hold years of history:
// - Raw tables (steps, tools, routing, ...) are append-mostly and indexed by time.
// - Daily rollups (daily_usage, daily_tools) answer every range longer than a day; raw rows are only read for today.
// - Per-session totals are cached on the session row, so the session list is a plain indexed, paginated query.
// - Bulky detail (individual tool calls, frequent usage checks) is pruned after a retention period; rollups are kept.
// - Incremental auto-vacuum returns space from pruning; the WAL is capped.
type Row = Record<string, unknown>
type Statement = { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown }
type Driver = { exec(sql: string): void; prepare(sql: string): Statement; close(): void }

const BASE = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, directory TEXT, title TEXT, agent TEXT,
  created_at INTEGER, deleted_at INTEGER, source TEXT NOT NULL DEFAULT 'live');
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, kind TEXT NOT NULL DEFAULT 'primary',
  provider_id TEXT, model_id TEXT, variant TEXT, agent TEXT,
  started_at INTEGER, ended_at INTEGER, status TEXT, finish TEXT, error_type TEXT, error_message TEXT,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cost_reported REAL NOT NULL DEFAULT 0, cost_equiv REAL NOT NULL DEFAULT 0, cost_actual REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'live');
CREATE INDEX IF NOT EXISTS steps_started ON steps (started_at);
CREATE INDEX IF NOT EXISTS steps_session ON steps (session_id);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER, ended_at INTEGER, outcome TEXT, error_type TEXT, error_message TEXT);
CREATE INDEX IF NOT EXISTS executions_started ON executions (started_at);
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY, session_id TEXT, name TEXT, started_at INTEGER, ended_at INTEGER, status TEXT);
CREATE INDEX IF NOT EXISTS tools_started ON tools (started_at);
CREATE TABLE IF NOT EXISTS routing (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, session_id TEXT, trigger TEXT, kind TEXT,
  from_model TEXT, to_model TEXT, pool TEXT, until INTEGER, evidence TEXT);
CREATE INDEX IF NOT EXISTS routing_at ON routing (at);
CREATE TABLE IF NOT EXISTS pool_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, pool TEXT, status TEXT, kind TEXT, until INTEGER,
  utilization REAL, evidence TEXT, reason TEXT);
CREATE INDEX IF NOT EXISTS pool_log_at ON pool_log (at);
CREATE TABLE IF NOT EXISTS pools (id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, provider TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS usage_snapshots_at ON usage_snapshots (provider, at);
CREATE TABLE IF NOT EXISTS session_prefs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER);
`

/** Local calendar day, `YYYY-MM-DD`. Days are bucketed in local time, matching SQLite's 'localtime'. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

async function openDriver(file: string): Promise<Driver> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const mod = (await import("bun:sqlite" as string)) as { Database: new (f: string, o?: object) => Driver }
    return new mod.Database(file, { create: true })
  }
  const mod = (await import("node:sqlite" as string)) as { DatabaseSync: new (f: string) => Driver }
  return new mod.DatabaseSync(file)
}

const clean = (params: unknown[]) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p))

export class Store {
  private driver: Driver
  private cache = new Map<string, Statement>()
  /** True when a migration ran that requires rollups to be rebuilt from raw rows. */
  rebuildNeeded = false

  private constructor(driver: Driver) {
    this.driver = driver
  }

  static async open(file: string): Promise<Store> {
    const driver = await openDriver(file)
    const store = new Store(driver)
    // Must be set before the first table exists to take effect without a VACUUM.
    if (Number(store.get<{ page_count: number }>("PRAGMA page_count")?.page_count ?? 0) === 0) driver.exec("PRAGMA auto_vacuum = INCREMENTAL")
    driver.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA journal_size_limit = 67108864;",
    )
    driver.exec(BASE)
    store.migrate()
    return store
  }

  private columns(table: string): Set<string> {
    return new Set(this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name))
  }

  private addColumn(table: string, column: string, type: string) {
    if (!this.columns(table).has(column)) this.driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  /** Ordered, idempotent schema migrations. `meta.schema_version` records the last one applied. */
  private migrate() {
    const version = Number(this.meta("schema_version") ?? 1)
    if (version < 2) {
      this.transaction(() => {
        this.addColumn("steps", "day", "TEXT")
        this.addColumn("tools", "day", "TEXT")
        for (const [col, type] of [
          ["first_at", "INTEGER"], ["last_at", "INTEGER"], ["tokens", "INTEGER NOT NULL DEFAULT 0"], ["equiv", "REAL NOT NULL DEFAULT 0"],
          ["actual", "REAL NOT NULL DEFAULT 0"], ["steps", "INTEGER NOT NULL DEFAULT 0"], ["failed", "INTEGER NOT NULL DEFAULT 0"],
          ["models", "TEXT"], ["fallbacks", "INTEGER NOT NULL DEFAULT 0"], ["busy_ms", "INTEGER NOT NULL DEFAULT 0"],
          ["dirty", "INTEGER NOT NULL DEFAULT 1"],
        ] as const)
          this.addColumn("sessions", col, type)
        this.driver.exec(`
          UPDATE steps SET day = strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') WHERE day IS NULL AND started_at IS NOT NULL;
          UPDATE tools SET day = strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') WHERE day IS NULL AND started_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS steps_day ON steps (day);
          DROP INDEX IF EXISTS steps_session;
          CREATE INDEX IF NOT EXISTS steps_session_started ON steps (session_id, started_at);
          CREATE INDEX IF NOT EXISTS steps_running ON steps (session_id) WHERE status = 'running';
          CREATE INDEX IF NOT EXISTS tools_day ON tools (day);
          CREATE INDEX IF NOT EXISTS tools_session ON tools (session_id);
          CREATE INDEX IF NOT EXISTS executions_session ON executions (session_id, started_at);
          CREATE INDEX IF NOT EXISTS routing_session ON routing (session_id, at);
          CREATE INDEX IF NOT EXISTS routing_trigger_at ON routing (trigger, at);
          CREATE INDEX IF NOT EXISTS sessions_last ON sessions (last_at);
          CREATE INDEX IF NOT EXISTS sessions_dirty ON sessions (dirty) WHERE dirty = 1;
          CREATE TABLE IF NOT EXISTS daily_usage (
            day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL,
            steps INTEGER NOT NULL, failed INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
            cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, equiv REAL NOT NULL, actual REAL NOT NULL, model_ms INTEGER NOT NULL,
            PRIMARY KEY (day, provider, model, project, agent, kind)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS daily_tools (
            day TEXT NOT NULL, name TEXT NOT NULL, calls INTEGER NOT NULL, failed INTEGER NOT NULL, total_ms INTEGER NOT NULL, timed INTEGER NOT NULL,
            PRIMARY KEY (day, name)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS dirty_days (day TEXT PRIMARY KEY) WITHOUT ROWID;
          INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT day FROM steps WHERE day IS NOT NULL;
          INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT day FROM tools WHERE day IS NOT NULL;
          UPDATE sessions SET dirty = 1;
        `)
        this.setMeta("schema_version", "2")
      })
      this.rebuildNeeded = true
      // Databases created before incremental auto-vacuum need one VACUUM to switch. Cheap while they are small.
      if (Number(this.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")?.auto_vacuum) !== 2) {
        this.driver.exec("PRAGMA auto_vacuum = INCREMENTAL")
        this.driver.exec("VACUUM")
      }
    }
  }

  private stmt(sql: string): Statement {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.driver.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  run(sql: string, ...params: unknown[]) {
    this.stmt(sql).run(...clean(params))
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...clean(params)) as T[]
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return (this.stmt(sql).get(...clean(params)) ?? undefined) as T | undefined
  }

  exec(sql: string) {
    this.driver.exec(sql)
  }

  transaction(fn: () => void) {
    this.driver.exec("BEGIN IMMEDIATE")
    try {
      fn()
      this.driver.exec("COMMIT")
    } catch (error) {
      this.driver.exec("ROLLBACK")
      throw error
    }
  }

  meta(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value
  }

  setMeta(key: string, value: string) {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
  }

  close() {
    try {
      this.driver.exec("PRAGMA optimize")
    } catch {}
    this.cache.clear()
    this.driver.close()
  }
}
