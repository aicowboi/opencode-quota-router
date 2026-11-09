// One-off import of usage already recorded by OpenCode, so the dashboard has history from day one.
// OpenCode's database is opened read-only.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { localDay, type Store } from "./db.ts"
import type { Pricer } from "./recorder.ts"

type Readonly = { prepare(sql: string): { all(...p: unknown[]): unknown[] }; close(): void }

async function openReadonly(file: string): Promise<Readonly> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const mod = (await import("bun:sqlite" as string)) as { Database: new (f: string, o?: object) => Readonly }
    return new mod.Database(file, { readonly: true })
  }
  const mod = (await import("node:sqlite" as string)) as { DatabaseSync: new (f: string, o?: object) => Readonly }
  return new mod.DatabaseSync(file, { readOnly: true })
}

export function opencodeDbPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode", "opencode.db")
}

export async function backfill(store: Store, price: Pricer, before: number, file = opencodeDbPath()): Promise<{ sessions: number; steps: number }> {
  if (!fs.existsSync(file)) return { sessions: 0, steps: 0 }
  const source = await openReadonly(file)
  try {
    const sessions = source
      .prepare("SELECT id, parent_id, project_id, directory, title, agent, time_created FROM session_v2")
      .all() as Array<Record<string, any>>
    const messages = source
      .prepare("SELECT id, session_id, data, time_created FROM session_message WHERE type = 'assistant' AND time_created < ?")
      .all(before) as Array<{ id: string; session_id: string; data: string; time_created: number }>
    let steps = 0
    store.transaction(() => {
      for (const s of sessions) {
        store.run(
          `INSERT INTO sessions (id, parent_id, project_id, directory, title, agent, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'backfill')
           ON CONFLICT(id) DO UPDATE SET title = COALESCE(title, excluded.title), directory = COALESCE(directory, excluded.directory),
           parent_id = COALESCE(parent_id, excluded.parent_id), created_at = COALESCE(created_at, excluded.created_at)`,
          s.id, s.parent_id, s.project_id, s.directory, s.title, s.agent, s.time_created,
        )
      }
      for (const m of messages) {
        let d: any
        try {
          d = JSON.parse(m.data)
        } catch {
          continue
        }
        if (!d?.model?.providerID) continue
        const t = d.tokens ?? {}
        const tokens = {
          input: Number(t.input ?? 0),
          output: Number(t.output ?? 0),
          reasoning: Number(t.reasoning ?? 0),
          cache: { read: Number(t.cache?.read ?? 0), write: Number(t.cache?.write ?? 0) },
        }
        const reported = Number(d.cost ?? 0)
        const cost = price(d.model.providerID, d.model.id, tokens, reported)
        const started = d.time?.created ?? m.time_created
        store.run(
          `INSERT OR IGNORE INTO steps (id, session_id, message_id, kind, provider_id, model_id, variant, agent, started_at, ended_at, status, finish,
           error_type, error_message, input, output, reasoning, cache_read, cache_write, cost_reported, cost_equiv, cost_actual, source, day)
           VALUES (?, ?, ?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill', ?)`,
          `bf_${m.id}`, m.session_id, m.id, d.model.providerID, d.model.id, d.model.variant, d.agent, started, d.time?.completed ?? started,
          d.error ? "failed" : "ok", d.finish, d.error?.type, d.error?.message?.slice?.(0, 500),
          tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write, reported, cost.equivalent, cost.actual,
          localDay(started),
        )
        steps++
      }
      store.exec("INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT day FROM steps WHERE source = 'backfill' AND day IS NOT NULL; UPDATE sessions SET dirty = 1;")
    })
    return { sessions: sessions.length, steps }
  } finally {
    source.close()
  }
}
