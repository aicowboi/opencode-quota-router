// Records OpenCode session events into the local store and keeps a live view of running work.
import { localDay, type Store } from "./db.ts"
import { markDirty } from "./maintenance.ts"
import type { ModelRef, Tokens } from "./types.ts"

type Event = { id: string; type: string; created: number; data: Record<string, any> }

export type LiveExecution = {
  sessionID: string
  startedAt: number
  step?: { id: string; model: ModelRef; startedAt: number; agent?: string }
  tools: Array<{ id: string; name: string; startedAt: number }>
  retry?: { attempt: number; at: number; error: string }
}

export type Pricer = (providerID: string, modelID: string, tokens: Tokens, reported: number) => { equivalent: number; actual: number }

const ZERO: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const tokensOf = (t: any): Tokens => ({
  input: Number(t?.input ?? 0),
  output: Number(t?.output ?? 0),
  reasoning: Number(t?.reasoning ?? 0),
  cache: { read: Number(t?.cache?.read ?? 0), write: Number(t?.cache?.write ?? 0) },
})

export class Recorder {
  readonly live = new Map<string, LiveExecution>()
  private seen = new Set<string>()
  private known = new Set<string>()
  private store: Store
  private price: Pricer
  private ensureSession: (id: string) => void
  private changed: (kind: string) => void

  constructor(store: Store, price: Pricer, ensureSession: (id: string) => void, changed: (kind: string) => void) {
    this.store = store
    this.price = price
    this.ensureSession = ensureSession
    this.changed = changed
  }

  /** Upsert session details fetched from OpenCode for sessions created before the plugin started. */
  upsertSession(s: { id: string; parentID?: string; projectID?: string; directory?: string; title?: string; agent?: string; created?: number }) {
    this.known.add(s.id)
    this.store.run(
      `INSERT INTO sessions (id, parent_id, project_id, directory, title, agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET parent_id = COALESCE(excluded.parent_id, parent_id), project_id = COALESCE(excluded.project_id, project_id),
       directory = COALESCE(excluded.directory, directory), title = COALESCE(excluded.title, title), agent = COALESCE(excluded.agent, agent),
       created_at = COALESCE(created_at, excluded.created_at)`,
      s.id, s.parentID, s.projectID, s.directory, s.title, s.agent, s.created,
    )
  }

  private touch(sessionID: string | undefined) {
    if (!sessionID || this.known.has(sessionID)) return
    this.known.add(sessionID)
    if (this.store.get("SELECT 1 FROM sessions WHERE id = ?", sessionID)) return
    this.store.run("INSERT OR IGNORE INTO sessions (id) VALUES (?)", sessionID)
    this.ensureSession(sessionID)
  }

  private exec(sessionID: string, at: number): LiveExecution {
    let e = this.live.get(sessionID)
    if (!e) this.live.set(sessionID, (e = { sessionID, startedAt: at, tools: [] }))
    return e
  }

  /** Close a running step as failed, e.g. when a retry restarts it without a step.failed event. */
  private failStep(stepID: string, sessionID: string, at: number, error?: { type?: string; message?: string }) {
    const row = this.store.get<{ started_at: number }>("SELECT started_at FROM steps WHERE id = ? AND status = 'running'", stepID)
    if (!row) return
    this.store.run(
      "UPDATE steps SET status = 'failed', ended_at = ?, error_type = COALESCE(?, error_type), error_message = COALESCE(?, error_message) WHERE id = ?",
      at, error?.type, error?.message?.slice(0, 500), stepID,
    )
    markDirty(this.store, sessionID, row.started_at)
  }

  handle(ev: Event) {
    if (!ev?.id || this.seen.has(ev.id)) return
    this.seen.add(ev.id)
    if (this.seen.size > 20_000) for (const id of [...this.seen].slice(0, 5_000)) this.seen.delete(id)
    const d = ev.data ?? {}
    const sid: string | undefined = d.sessionID
    const at = ev.created ?? Date.now()

    switch (ev.type) {
      case "session.created":
        this.upsertSession({ id: sid!, parentID: d.parentID, projectID: d.projectID, directory: d.location?.directory, title: d.title, agent: d.agent, created: at })
        return this.changed("session")
      case "session.renamed":
        this.touch(sid)
        this.store.run("UPDATE sessions SET title = ? WHERE id = ?", d.title, sid)
        return this.changed("session")
      case "session.agent.selected":
        this.touch(sid)
        this.store.run("UPDATE sessions SET agent = ? WHERE id = ?", d.agent, sid)
        return
      case "session.deleted":
        this.store.run("UPDATE sessions SET deleted_at = ? WHERE id = ?", at, sid)
        this.live.delete(sid!)
        return this.changed("session")

      case "session.execution.started":
        this.touch(sid)
        this.store.run("INSERT OR IGNORE INTO executions (id, session_id, started_at) VALUES (?, ?, ?)", ev.id, sid, at)
        this.live.set(sid!, { sessionID: sid!, startedAt: at, tools: [] })
        return this.changed("live")
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const outcome = ev.type.split(".").pop()
        this.store.run(
          "UPDATE executions SET ended_at = ?, outcome = ?, error_type = ?, error_message = ? WHERE session_id = ? AND ended_at IS NULL",
          at, outcome, d.error?.type ?? d.reason, d.error?.message, sid,
        )
        for (const s of this.store.all<{ id: string; started_at: number }>("SELECT id, started_at FROM steps WHERE session_id = ? AND status = 'running'", sid)) {
          this.store.run("UPDATE steps SET status = 'interrupted', ended_at = ? WHERE id = ?", at, s.id)
          markDirty(this.store, sid, s.started_at)
        }
        this.store.run("UPDATE tools SET status = 'interrupted', ended_at = ? WHERE session_id = ? AND ended_at IS NULL", at, sid)
        markDirty(this.store, sid, at)
        this.live.delete(sid!)
        return this.changed("live")
      }

      case "session.step.started": {
        this.touch(sid)
        // A retry restarts the step without a step.failed event; close the attempt it replaces.
        const prev = this.live.get(sid!)?.step
        if (prev) this.failStep(prev.id, sid!, at)
        const model = d.model as ModelRef
        const started = d.started ?? at
        this.store.run(
          `INSERT OR IGNORE INTO steps (id, session_id, message_id, kind, provider_id, model_id, variant, agent, started_at, status, day)
           VALUES (?, ?, ?, 'primary', ?, ?, ?, ?, ?, 'running', ?)`,
          ev.id, sid, d.assistantMessageID, model?.providerID, model?.id, model?.variant, d.agent, started, localDay(started),
        )
        const e = this.exec(sid!, at)
        e.step = { id: ev.id, model, startedAt: started, agent: d.agent }
        e.retry = undefined
        return this.changed("live")
      }
      case "session.step.ended":
      case "session.step.failed": {
        const e = this.live.get(sid!)
        const stepID =
          e?.step?.id ??
          this.store.get<{ id: string }>("SELECT id FROM steps WHERE session_id = ? AND message_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1", sid, d.assistantMessageID)?.id
        if (!stepID) return
        const row = this.store.get<{ provider_id: string; model_id: string; started_at: number }>("SELECT provider_id, model_id, started_at FROM steps WHERE id = ?", stepID)
        const tokens = d.tokens ? tokensOf(d.tokens) : ZERO
        const reported = Number(d.cost ?? 0)
        const cost = row ? this.price(row.provider_id, row.model_id, tokens, reported) : { equivalent: reported, actual: reported }
        this.store.run(
          `UPDATE steps SET ended_at = ?, status = ?, finish = ?, error_type = ?, error_message = ?, input = ?, output = ?, reasoning = ?,
           cache_read = ?, cache_write = ?, cost_reported = ?, cost_equiv = ?, cost_actual = ? WHERE id = ?`,
          at, ev.type === "session.step.ended" ? "ok" : "failed", d.finish ?? null, d.error?.type, d.error?.message?.slice(0, 500),
          tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write, reported, cost.equivalent, cost.actual, stepID,
        )
        markDirty(this.store, sid, row?.started_at ?? at)
        if (e) e.step = undefined
        return this.changed("usage")
      }
      case "session.retry.scheduled": {
        const e = this.exec(sid!, at)
        e.retry = { attempt: d.attempt, at: d.at, error: d.error?.message ?? d.error?.type ?? "" }
        if (e.step) {
          this.failStep(e.step.id, sid!, at, d.error)
          e.step = undefined
        }
        return this.changed("live")
      }

      case "session.tool.input.started":
      case "session.tool.called": {
        if (!d.id) return
        const key = `${sid}:${d.id}`
        this.store.run(
          `INSERT INTO tools (id, session_id, name, started_at, status, day) VALUES (?, ?, ?, ?, 'running', ?)
           ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name)`,
          key, sid, d.name ?? null, at, localDay(at),
        )
        const e = this.exec(sid!, at)
        if (!e.tools.some((t) => t.id === key)) {
          const name = d.name ?? this.store.get<{ name: string }>("SELECT name FROM tools WHERE id = ?", key)?.name ?? "tool"
          e.tools.push({ id: key, name, startedAt: at })
        }
        return this.changed("live")
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const key = `${sid}:${d.id}`
        this.store.run("UPDATE tools SET ended_at = ?, status = ? WHERE id = ?", at, ev.type.endsWith("success") ? "ok" : "failed", key)
        markDirty(this.store, undefined, this.store.get<{ started_at: number }>("SELECT started_at FROM tools WHERE id = ?", key)?.started_at ?? at)
        const e = this.live.get(sid!)
        if (e) e.tools = e.tools.filter((t) => t.id !== key)
        return this.changed("live")
      }

      case "session.compaction.ended": {
        if (!d.tokens) return
        const model = d.model as ModelRef | undefined
        const tokens = tokensOf(d.tokens)
        const reported = Number(d.cost ?? 0)
        const cost = model ? this.price(model.providerID, model.id, tokens, reported) : { equivalent: reported, actual: reported }
        this.store.run(
          `INSERT OR IGNORE INTO steps (id, session_id, kind, provider_id, model_id, variant, started_at, ended_at, status, input, output, reasoning,
           cache_read, cache_write, cost_reported, cost_equiv, cost_actual, day) VALUES (?, ?, 'compaction', ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ev.id, sid, model?.providerID, model?.id, model?.variant, at, at, tokens.input, tokens.output, tokens.reasoning,
          tokens.cache.read, tokens.cache.write, reported, cost.equivalent, cost.actual, localDay(at),
        )
        markDirty(this.store, sid, at)
        return this.changed("usage")
      }
      case "session.usage.recorded": {
        if (d.source !== "title") return
        const tokens = tokensOf(d.tokens)
        this.store.run(
          `INSERT OR IGNORE INTO steps (id, session_id, kind, started_at, ended_at, status, input, output, reasoning, cache_read, cache_write,
           cost_reported, cost_equiv, cost_actual, day) VALUES (?, ?, 'title', ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ev.id, sid, at, at, tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write, Number(d.cost ?? 0), Number(d.cost ?? 0), 0, localDay(at),
        )
        markDirty(this.store, sid, at)
        return
      }
    }
  }
}
