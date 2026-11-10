// Reads append-only JSONL logs incrementally. Each file's byte offset, parser state and records are kept in a cache
// file, so a second run only reads what was appended since. Read-only on the logs themselves; the cache is written
// with owner-only permissions because it holds project paths and model names.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** One file's progress: where reading stopped, the parser's state there, and the records found so far. */
export type Entry<R, S> = { size: number; mtimeMs: number; offset: number; state: S; records: R[] }
type CacheFile<R, S> = { version: number; files: Record<string, Entry<R, S>> }

export type Parser<R, S> = {
  /** Bump when the record shape or parsing changes, so old caches are read again from the start. */
  version: number
  initial: () => S
  /** Parse one complete line. May update `state` (it is kept between runs) and return a record. */
  line: (text: string, state: S, file: string) => R | undefined
  /** Records with the same key within a file are merged; for logs that write one message over several lines. */
  key?: (r: R) => string
  merge?: (a: R, b: R) => R
}

export const cacheDir = (env: NodeJS.ProcessEnv = process.env) => path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "quota-router")

/** Every `*.jsonl` file under `root`, at any depth. Missing folders give none. */
export function jsonlFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p)
    }
  }
  walk(root, 0)
  return out.sort()
}

/** Read the lines after `offset`, stopping before a final line that has no newline yet (still being written). */
async function readFrom(file: string, offset: number, onLine: (line: string) => void): Promise<number> {
  let pending: Buffer = Buffer.alloc(0)
  let consumed = offset
  for await (const chunk of fs.createReadStream(file, { start: offset, highWaterMark: 1 << 20 })) {
    let buf = pending.length ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer)
    let start = 0
    for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
      const line = buf.toString("utf8", start, nl)
      if (line.trim()) onLine(line)
      consumed += nl + 1 - start
      start = nl + 1
    }
    pending = buf.subarray(start)
    buf = Buffer.alloc(0)
  }
  return consumed
}

function dedupe<R>(records: R[], key: (r: R) => string, merge: (a: R, b: R) => R): R[] {
  const by = new Map<string, R>()
  for (const r of records) {
    const k = key(r)
    const prev = by.get(k)
    by.set(k, prev === undefined ? r : merge(prev, r))
  }
  return [...by.values()]
}

/**
 * Scan `files` with `parser`, reading each from where the cache left off. Returns every file's entry. The cache is
 * named `name`; pass `cache: false` to read everything without one (tests, `--no-cache`).
 */
export async function scan<R, S>(name: string, files: string[], parser: Parser<R, S>, opts: { cache?: boolean; dir?: string } = {}): Promise<Map<string, Entry<R, S>>> {
  const useCache = opts.cache !== false
  const dir = opts.dir ?? cacheDir()
  const cachePath = path.join(dir, `${name}.json`)
  let cached: CacheFile<R, S> = { version: parser.version, files: {} }
  if (useCache) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CacheFile<R, S>
      if (c?.version === parser.version && c.files && typeof c.files === "object") cached = c
    } catch {}
  }
  const out = new Map<string, Entry<R, S>>()
  let changed = false
  for (const file of files) {
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    const prev = Object.hasOwn(cached.files, file) ? cached.files[file] : undefined
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      out.set(file, prev)
      continue
    }
    // A file that shrank was rewritten, not appended to: read it again from the start.
    const resume = prev && st.size >= prev.offset ? prev : undefined
    const entry: Entry<R, S> = resume ? { ...resume, records: [...resume.records] } : { size: 0, mtimeMs: 0, offset: 0, state: parser.initial(), records: [] }
    try {
      entry.offset = await readFrom(file, entry.offset, (line) => {
        const r = parser.line(line, entry.state, file)
        if (r !== undefined) entry.records.push(r)
      })
    } catch {
      continue
    }
    if (parser.key && parser.merge) entry.records = dedupe(entry.records, parser.key, parser.merge)
    entry.size = st.size
    entry.mtimeMs = st.mtimeMs
    out.set(file, entry)
    changed = true
  }
  if (useCache && (changed || Object.keys(cached.files).length !== out.size)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${cachePath}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: parser.version, files: Object.fromEntries(out) }), { mode: 0o600 })
      fs.renameSync(tmp, cachePath)
    } catch {}
  }
  return out
}
