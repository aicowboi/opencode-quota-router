// Claude subscription usage, as shown by Claude Code's /usage. The endpoint is undocumented.
// We only read Claude Code's stored login; we never refresh it, because refreshing rotates the token
// and could sign Claude Code out. An expired token just means no probe until Claude Code next runs.
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseTimestamp } from "../engine/resets.ts"

export type ClaudeWindow = { pool: string; label: string; utilization: number; resetAt?: number }
export type ClaudeUsage = {
  windows: ClaudeWindow[]
  extra?: { enabled: boolean; used: number; limit?: number; currency?: string; spendLimitReached: boolean }
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 4000, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  )

export async function readClaudeToken(): Promise<{ token: string; expiresAt?: number } | undefined> {
  let raw: string | undefined
  if (process.platform === "darwin") {
    raw = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]).catch(() => undefined)
  }
  if (!raw) {
    const file = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), ".credentials.json")
    raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined
  }
  if (!raw) return undefined
  try {
    const oauth = JSON.parse(raw.trim()).claudeAiOauth
    if (typeof oauth?.accessToken !== "string") return undefined
    return { token: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined }
  } catch {
    return undefined
  }
}

export async function fetchClaudeUsage(token: string, signal?: AbortSignal): Promise<{ status: number; json?: unknown }> {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "opencode-quota-router",
      accept: "application/json",
    },
    signal: signal ?? AbortSignal.timeout(8000),
  })
  if (!response.ok) return { status: response.status }
  return { status: response.status, json: await response.json() }
}

type Limit = { kind?: string; percent?: number; resets_at?: string; scope?: { model?: { display_name?: string | null } } | null }
type Legacy = { utilization?: number; resets_at?: string } | null

/** Turn the usage payload into per-pool windows. Prefers the `limits` list; falls back to the older fields. */
export function interpretClaudeUsage(json: unknown, now: number): ClaudeUsage {
  const data = (json ?? {}) as Record<string, unknown>
  const windows: ClaudeWindow[] = []
  const limits = Array.isArray(data.limits) ? (data.limits as Limit[]) : []
  for (const l of limits) {
    if (typeof l.percent !== "number") continue
    const resetAt = parseTimestamp(l.resets_at, now)
    const model = l.scope?.model?.display_name
    if (l.kind === "session") windows.push({ pool: "claude-agent", label: "5-hour session", utilization: l.percent, resetAt })
    else if (l.kind === "weekly_all") windows.push({ pool: "claude-agent", label: "Weekly (all models)", utilization: l.percent, resetAt })
    else if (model) windows.push({ pool: `claude-agent:${model.toLowerCase()}`, label: `Weekly (${model})`, utilization: l.percent, resetAt })
  }
  if (windows.length === 0) {
    const legacy: Array<[string, string, string]> = [
      ["five_hour", "claude-agent", "5-hour session"],
      ["seven_day", "claude-agent", "Weekly (all models)"],
      ["seven_day_opus", "claude-agent:opus", "Weekly (Opus)"],
      ["seven_day_sonnet", "claude-agent:sonnet", "Weekly (Sonnet)"],
    ]
    for (const [key, pool, label] of legacy) {
      const w = data[key] as Legacy
      if (w && typeof w.utilization === "number") windows.push({ pool, label, utilization: w.utilization, resetAt: parseTimestamp(w.resets_at, now) })
    }
  }
  const e = data.extra_usage as Record<string, unknown> | null | undefined
  // Amounts arrive in minor units (pence, cents) with the number of decimal places alongside.
  const scale = e && typeof e.decimal_places === "number" ? 10 ** e.decimal_places : 1
  const extra = e
    ? {
        enabled: e.is_enabled === true,
        used: typeof e.used_credits === "number" ? e.used_credits / scale : 0,
        limit: typeof e.monthly_limit === "number" ? e.monthly_limit / scale : undefined,
        currency: typeof e.currency === "string" ? e.currency : undefined,
        spendLimitReached: e.spend_limit_reached === true,
      }
    : undefined
  return { windows, ...(extra ? { extra } : {}) }
}
