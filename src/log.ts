// JSONL log in the plugin's data directory. Never console.log: it corrupts the TUI.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  const dir = path.join(base, "opencode-quota-router")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type Level = keyof typeof LEVELS

export class Logger {
  private file: string
  private min: number

  constructor(file: string, level: Level = "info") {
    this.file = file
    this.min = LEVELS[level]
  }

  setLevel(level: Level) {
    this.min = LEVELS[level] ?? LEVELS.info
  }

  write(level: Level, message: string, data?: Record<string, unknown>) {
    if (LEVELS[level] < this.min) return
    try {
      const stat = fs.statSync(this.file, { throwIfNoEntry: false })
      if (stat && stat.size > 5_000_000) fs.renameSync(this.file, `${this.file}.1`)
      fs.appendFileSync(this.file, JSON.stringify({ t: new Date().toISOString(), level, message, ...data }) + "\n", { mode: 0o600 })
    } catch {}
  }

  debug = (m: string, d?: Record<string, unknown>) => this.write("debug", m, d)
  info = (m: string, d?: Record<string, unknown>) => this.write("info", m, d)
  warn = (m: string, d?: Record<string, unknown>) => this.write("warn", m, d)
  error = (m: string, d?: Record<string, unknown>) => this.write("error", m, d)
}
