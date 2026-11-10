// Readers for the usage that coding tools record on this machine. Each turns its tool's own log into the same
// `Usage` records. All read-only and local: nothing is sent anywhere.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { jsonlFiles, scan, type Parser } from "./scan.ts"

export type Source = "claude-code" | "codex" | "opencode"
export const SOURCES: Source[] = ["claude-code", "codex", "opencode"]

/** One model request. Token kinds are disjoint: `input` excludes cached input, `output` excludes reasoning. */
export type Usage = {
  source: Source
  id: string
  at: number
  providerID: string
  model: string
  project?: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** What the tool itself says the request cost, when it says. */
  cost?: number
  /** Claude Code only: what started the session (`claude-desktop`, `cli`, or `sdk-ts` for the Agent SDK). */
  via?: string
  /** Claude Code only: the session the request belongs to. */
  session?: string
}

/** A plan window as Codex last reported it. */
export type CodexLimit = { label: string; usedPct: number; windowMinutes?: number; resetAt?: number }
export type CodexLimits = { at: number; plan?: string; windows: CodexLimit[] }

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

// ---------- Claude Code ----------

/**
 * `~/.claude/projects/<project>/<session>.jsonl`, and subagents' logs in folders below. Only assistant lines carry
 * usage. One reply is written over several lines with the same message and request ID, and later lines can carry a
 * larger output count, so each field keeps its largest value.
 */
export const claudeParser: Parser<Usage, Record<string, never>> = {
  version: 2,
  initial: () => ({}),
  line(text) {
    if (!text.includes('"usage"') || !text.includes('"assistant"')) return
    let o: any
    try {
      o = JSON.parse(text)
    } catch {
      return
    }
    const m = o?.message
    if (o?.type !== "assistant" || !m?.usage || typeof m.model !== "string" || m.model === "<synthetic>") return
    const at = Date.parse(o.timestamp)
    if (!Number.isFinite(at)) return
    const u = m.usage
    return {
      source: "claude-code",
      id: `${m.id ?? ""}:${o.requestId ?? ""}`,
      at,
      providerID: "anthropic",
      model: m.model,
      project: str(o.cwd),
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      reasoning: 0,
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      ...(str(o.entrypoint) ? { via: str(o.entrypoint) } : {}),
      ...(str(o.sessionId) ? { session: str(o.sessionId) } : {}),
    }
  },
  key: (r) => r.id,
  merge: (a, b) => ({ ...a, input: Math.max(a.input, b.input), output: Math.max(a.output, b.output), cacheRead: Math.max(a.cacheRead, b.cacheRead), cacheWrite: Math.max(a.cacheWrite, b.cacheWrite) }),
}

// ---------- Codex ----------

type CodexState = { model?: string; cwd?: string; prev?: number[]; limits?: CodexLimits }
const CODEX_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]

/**
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each `token_count` event carries the session's running total; a
 * request's usage is the change since the last one, which also ignores events repeated without new tokens. OpenAI
 * counts cached input inside `input_tokens` and reasoning inside `output_tokens`; both are taken out here.
 */
export const codexParser: Parser<Usage, CodexState> = {
  version: 1,
  initial: () => ({}),
  line(text, state, file) {
    if (!text.includes('"turn_context"') && !text.includes('"session_meta"') && !text.includes('"token_count"')) return
    let o: any
    try {
      o = JSON.parse(text)
    } catch {
      return
    }
    const p = o?.payload
    if (o?.type === "session_meta") state.cwd = str(p?.cwd) ?? state.cwd
    if (o?.type === "turn_context") {
      state.model = str(p?.model) ?? state.model
      state.cwd = str(p?.cwd) ?? state.cwd
    }
    if (o?.type !== "event_msg" || p?.type !== "token_count") return
    const at = Date.parse(o.timestamp)
    if (!Number.isFinite(at)) return
    const rl = p.rate_limits
    if (rl && typeof rl === "object") {
      const windows: CodexLimit[] = []
      for (const [key, label] of [["primary", "5-hour"], ["secondary", "Weekly"]] as const) {
        const w = rl[key]
        if (!w || typeof w.used_percent !== "number") continue
        const minutes = num(w.window_minutes) || undefined
        windows.push({
          label: minutes === 300 ? "5-hour" : minutes === 10080 ? "Weekly" : minutes ? `${Math.round(minutes / 60)}-hour` : label,
          usedPct: w.used_percent,
          windowMinutes: minutes,
          resetAt: num(w.resets_at) ? w.resets_at * 1000 : undefined,
        })
      }
      if (windows.length && (!state.limits || at >= state.limits.at)) state.limits = { at, plan: str(rl.plan_type), windows }
    }
    const total = p.info?.total_token_usage
    if (!total || typeof total !== "object") return
    const now = CODEX_FIELDS.map((f) => num(total[f]))
    const prev = state.prev ?? CODEX_FIELDS.map(() => 0)
    state.prev = now
    // A smaller total means a new count (a resumed or compacted session): count it from zero.
    const d = now.map((v, i) => (now[5] >= prev[5] ? v - prev[i] : v))
    if (d[5] <= 0) return
    const [input, cached, cacheWrite, output, reasoning] = d.map((v) => Math.max(0, v))
    return {
      source: "codex",
      id: `${file}:${at}:${now[5]}`,
      at,
      providerID: "openai",
      model: state.model ?? "unknown",
      project: state.cwd,
      input: Math.max(0, input - cached),
      output: Math.max(0, output - reasoning),
      reasoning,
      cacheRead: cached,
      cacheWrite,
    }
  },
}

// ---------- OpenCode ----------

/** OpenCode's own database, opened read-only: assistant messages with token counts, and their session's folder. */
export async function readOpenCode(file: string): Promise<Usage[]> {
  if (!fs.existsSync(file)) return []
  // node:sqlite announces itself as experimental on every run; that note is not for the person running the command.
  const emit = process.emitWarning
  process.emitWarning = ((w: string | Error, ...rest: any[]) => (String(w).includes("SQLite") ? undefined : emit.call(process, w as any, ...rest))) as typeof process.emitWarning
  const { DatabaseSync } = await import("node:sqlite")
  process.emitWarning = emit
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db
      .prepare("SELECT m.id, m.data, s.directory FROM session_message m LEFT JOIN session_v2 s ON s.id = m.session_id WHERE m.type = 'assistant' AND json_extract(m.data, '$.tokens') IS NOT NULL")
      .all() as Array<{ id: string; data: string; directory: string | null }>
    const out: Usage[] = []
    for (const r of rows) {
      let d: any
      try {
        d = JSON.parse(r.data)
      } catch {
        continue
      }
      const t = d?.tokens
      const at = num(d?.time?.completed) || num(d?.time?.created)
      if (!t || !at || typeof d?.model?.providerID !== "string" || typeof d?.model?.id !== "string") continue
      out.push({
        source: "opencode",
        id: r.id,
        at,
        providerID: d.model.providerID,
        model: d.model.id,
        project: r.directory ?? undefined,
        input: num(t.input),
        output: num(t.output),
        reasoning: num(t.reasoning),
        cacheRead: num(t.cache?.read),
        cacheWrite: num(t.cache?.write),
        cost: num(d.cost) || undefined,
      })
    }
    return out
  } catch {
    // An OpenCode version with another schema: nothing to read rather than a crash.
    return []
  } finally {
    db.close()
  }
}

// ---------- counted once ----------

/**
 * OpenCode's Claude subscription provider (`claude-agent`) runs Claude Code through the Agent SDK, which also writes
 * each request to Claude Code's logs, marked `sdk-ts`. Those are counted once, as OpenCode's. A Claude Code SDK session
 * is OpenCode's when at least half its requests have an OpenCode `claude-agent` request in the same folder within two
 * minutes; then the whole session is left out. Matching whole sessions rather than single requests copes with the two
 * logs splitting a request's tokens slightly differently. Claude Code sessions you start yourself are never touched,
 * and nor is an SDK session of another program.
 */
export function withoutSdkCopies(usage: Usage[]): Usage[] {
  const agent = usage.filter((u) => u.source === "opencode" && u.providerID === "claude-agent").sort((a, b) => a.at - b.at)
  const sessions = new Map<string, Usage[]>()
  for (const u of usage) if (u.source === "claude-code" && u.via === "sdk-ts" && u.session) sessions.set(u.session, [...(sessions.get(u.session) ?? []), u])
  if (!agent.length || !sessions.size) return usage
  // The OpenCode requests within two minutes of `at`, found by binary search.
  const nearby = (u: Usage) => {
    let lo = 0, hi = agent.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (agent[mid].at < u.at - 120_000) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < agent.length && agent[i].at <= u.at + 120_000; i++) if (agent[i].project === u.project) return true
    return false
  }
  const copies = new Set<string>()
  for (const [id, reqs] of sessions) if (reqs.filter(nearby).length * 2 >= reqs.length) copies.add(id)
  return copies.size ? usage.filter((u) => !(u.source === "claude-code" && u.via === "sdk-ts" && u.session && copies.has(u.session))) : usage
}

// ---------- all of them ----------

export type Paths = { claude: string; codex: string; opencode: string; cache?: string }

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = os.homedir()
  return {
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects"),
    codex: path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions"),
    opencode: path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode", "opencode.db"),
  }
}

export async function readUsage(sources: Source[], paths: Paths, opts: { cache?: boolean } = {}): Promise<{ usage: Usage[]; codexLimits?: CodexLimits }> {
  const usage: Usage[] = []
  let codexLimits: CodexLimits | undefined
  const o = { cache: opts.cache, dir: paths.cache }
  if (sources.includes("claude-code")) {
    // Lines repeated across files (a resumed session copies earlier replies) are counted once.
    const by = new Map<string, Usage>()
    for (const e of (await scan("claude-code", jsonlFiles(paths.claude), claudeParser, o)).values())
      for (const r of e.records) by.set(r.id, by.has(r.id) ? claudeParser.merge!(by.get(r.id)!, r) : r)
    usage.push(...by.values())
  }
  if (sources.includes("codex") || sources.length === 0) {
    for (const e of (await scan("codex", jsonlFiles(paths.codex), codexParser, o)).values()) {
      if (sources.includes("codex")) usage.push(...e.records)
      if (e.state.limits && (!codexLimits || e.state.limits.at > codexLimits.at)) codexLimits = e.state.limits
    }
  }
  if (sources.includes("opencode")) usage.push(...(await readOpenCode(paths.opencode)))
  return { usage: sources.includes("claude-code") && sources.includes("opencode") ? withoutSdkCopies(usage) : usage, codexLimits }
}
