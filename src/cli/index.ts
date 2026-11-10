// `quota-router`: usage and limits from the command line. `usage` and `limits` read the logs that Claude Code, Codex
// and OpenCode keep on this machine; `status`, `prompt` and `doctor` ask the plugin's local dashboard while OpenCode
// runs. Nothing is sent anywhere.
import { execFile } from "node:child_process"
import { VERSION } from "../version.ts"
import { notedPort, reader, statusLine, type StatusFeed } from "../tui-feed.ts"
import { defaultPaths, readUsage, SOURCES, type Paths, type Source } from "./readers.ts"
import { GROUPS, loadPrices, RANGES, rangeStart, summarise, type GroupBy, type Row } from "./report.ts"

const HELP = `quota-router ${VERSION}: usage and limits for your AI coding tools

Usage: quota-router <command> [options]

Commands:
  usage      Tokens and their value at API prices, from Claude Code, Codex and OpenCode logs
  limits     Plan windows: Codex from its logs, others from the plugin while OpenCode runs
  status     What the plugin is doing: providers, limits and running sessions
  prompt     One short line for your shell prompt, such as "claude-agent 62%"
  doctor     The plugin's health check
  open       Open the dashboard

Options:
  --range <today|7d|30d|90d|all>              usage: period (default 7d)
  --by <day|model|source|project>             usage: grouping (default day)
  --source <claude-code|codex|opencode|all>   usage: which logs (default all; repeatable or comma-separated)
  --json                                      print JSON instead of a table
  --no-cache                                  usage: read every log in full
  --port <n>                                  the dashboard's port (default 47321, or QUOTA_ROUTER_PORT)
  --color / --no-color                        prompt: colour by state (default: when the output is a terminal)
  -h, --help, -v, --version

Reads, never writes: ~/.claude/projects, ~/.codex/sessions and OpenCode's database. A cache of what was read is
kept in ~/.cache/quota-router so later runs only read what is new.`

export type Args = { command?: string; flags: Map<string, string[]>; bad?: string }

const VALUE_FLAGS = new Set(["range", "by", "source", "port"])
const BOOL_FLAGS = new Set(["json", "no-cache", "color", "no-color", "help", "version"])

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string[]>()
  let command: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h") flags.set("help", ["1"])
    else if (a === "-v") flags.set("version", ["1"])
    else if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2)
      if (VALUE_FLAGS.has(name)) {
        const v = inline ?? argv[++i]
        if (v === undefined) return { command, flags, bad: `--${name} needs a value` }
        flags.set(name, [...(flags.get(name) ?? []), v])
      } else if (BOOL_FLAGS.has(name)) flags.set(name, ["1"])
      else return { command, flags, bad: `Unknown option --${name}` }
    } else if (!command) command = a
    else return { command, flags, bad: `Unexpected argument ${a}` }
  }
  return { command, flags }
}

// ---------- output ----------

const nf = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const tok = (n: number) => (n < 1000 ? String(Math.round(n)) : nf.format(n))
const usd = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n)
const time = (t: number) => {
  const d = new Date(t)
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return t - Date.now() < 20 * 3_600_000 ? hm : `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`
}
const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000))
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

/** A plain table: first column left-aligned, the rest right-aligned. */
export function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ").trimEnd()
  return [line(head), line(w.map((n) => "─".repeat(n))), ...rows.map(line)].join("\n")
}

// ---------- the dashboard ----------

const port = (args: Args) => Number(args.flags.get("port")?.[0] ?? process.env.QUOTA_ROUTER_PORT ?? 47321)
/** The dashboard: at the port given, or else where the plugin noted it is (it may have been set in opencode.jsonc). */
const dashboard = (args: Args) => reader(port(args), fetch, args.flags.has("port") || process.env.QUOTA_ROUTER_PORT ? () => undefined : notedPort)
const NOT_RUNNING = "The plugin isn't answering. Is OpenCode running with quota-router, and is the dashboard on?"
const OLDER = "The running plugin is older than this command and can't answer it. Update quota-router in OpenCode."

/** Ask the dashboard; when it doesn't answer, say whether the plugin is missing or just older than this command. */
async function ask<T>(args: Args, path: string, ok: (b: any) => boolean): Promise<{ body: T } | { error: string }> {
  const read = dashboard(args)
  const body = await read<T>(path, ok)
  if (body !== undefined) return { body }
  return { error: (await read("/api/ping", (b) => b?.app === "quota-router")) ? OLDER : NOT_RUNNING }
}

// ---------- commands ----------

type Out = { log: (s: string) => void; err: (s: string) => void }

async function usage(args: Args, out: Out, paths: Paths): Promise<number> {
  const range = args.flags.get("range")?.[0] ?? "7d"
  const by = (args.flags.get("by")?.[0] ?? "day") as GroupBy
  const wanted = (args.flags.get("source") ?? ["all"]).flatMap((s) => s.split(","))
  if (!Object.hasOwn(RANGES, range)) return fail(out, `--range should be one of ${Object.keys(RANGES).join(", ")}`)
  if (!GROUPS.includes(by)) return fail(out, `--by should be one of ${GROUPS.join(", ")}`)
  const bad = wanted.find((s) => s !== "all" && !SOURCES.includes(s as Source))
  if (bad) return fail(out, `Unknown source ${bad}; use ${SOURCES.join(", ")} or all`)
  const sources = wanted.includes("all") ? SOURCES : (wanted as Source[])
  const { usage } = await readUsage(sources, paths, { cache: !args.flags.has("no-cache") })
  const prices = loadPrices()
  const { rows, total } = summarise(usage, by, prices, rangeStart(range))
  if (args.flags.has("json")) {
    out.log(JSON.stringify({ range, by, sources, rows, total }, null, 2))
    return 0
  }
  if (!rows.length) {
    out.log(`No usage found ${range === "all" ? "" : `for ${range} `}in ${sources.join(", ")}.`)
    return 0
  }
  const cells = (r: Row) => [r.key, String(r.requests), tok(r.input), tok(r.output + r.reasoning), tok(r.cacheRead + r.cacheWrite), tok(r.tokens), prices.size ? `${usd(r.value)}${r.priced ? "" : "*"}` : "–"]
  out.log(table([by === "day" ? "Day" : by === "model" ? "Model" : by === "source" ? "Source" : "Project", "Requests", "Input", "Output", "Cached", "Tokens", "Value"], [...rows.map(cells), cells(total)]))
  if (!prices.size) out.log("\nValue needs list prices: run OpenCode with quota-router once, or keep OpenCode's model catalogue (~/.cache/opencode/models.json).")
  else if (!total.priced) out.log("\n* Some models have no list price; their value is left out.")
  return 0
}

async function limits(args: Args, out: Out, paths: Paths): Promise<number> {
  const [{ codexLimits }, menubar] = await Promise.all([readUsage([], paths, { cache: !args.flags.has("no-cache") }), dashboard(args)<any>("/api/menubar", (b) => typeof b?.now === "number")])
  if (args.flags.has("json")) {
    out.log(JSON.stringify({ codex: codexLimits ?? null, claude: menubar?.claude ?? null, chatgpt: menubar?.chatgpt ?? null, copilot: menubar?.copilot ?? null }, null, 2))
    return 0
  }
  const blocks: string[] = []
  const now = Date.now()
  const windows = (title: string, at: number | undefined, ws: Array<{ label: string; pct: number; resetAt?: number }>) => {
    const w = Math.max(...ws.map((x) => x.label.length))
    // A window whose reset time has passed since the reading was taken has started again; its old figure means nothing.
    const row = (x: (typeof ws)[number]) =>
      x.resetAt !== undefined && x.resetAt <= now ? `  ${x.label.padEnd(w)}     –   reset since this was read` : `  ${x.label.padEnd(w)}  ${`${Math.round(x.pct)}%`.padStart(4)}${x.resetAt ? `   resets ${time(x.resetAt)}` : ""}`
    blocks.push(`${title}${at ? ` (checked ${ago(at)})` : ""}\n` + ws.map(row).join("\n"))
  }
  if (codexLimits) windows(`Codex${codexLimits.plan ? ` ${codexLimits.plan}` : ""}, from its logs`, codexLimits.at, codexLimits.windows.map((w) => ({ label: w.label, pct: w.usedPct, resetAt: w.resetAt })))
  if (menubar?.claude?.windows?.length) windows("Claude", menubar.claude.at, menubar.claude.windows.map((w: any) => ({ label: String(w.label), pct: Number(w.utilization), resetAt: w.resetAt })))
  if (menubar?.chatgpt?.windows?.length) windows("ChatGPT", menubar.chatgpt.at, menubar.chatgpt.windows.map((w: any) => ({ label: String(w.label), pct: Number(w.usedPct), resetAt: w.resetAt })))
  const cp = menubar?.copilot
  if (cp?.entitlement) windows("Copilot", cp.at, [{ label: "Premium requests", pct: (Number(cp.used ?? cp.entitlement - cp.remaining) / cp.entitlement) * 100, resetAt: cp.resetAt }])
  if (!blocks.length) out.log(menubar ? "No plan windows known yet. Turn on the usage checks in the plugin's settings, or use Codex once." : `No Codex logs with limits found. ${NOT_RUNNING}`)
  else out.log(blocks.join("\n\n") + (menubar ? "" : `\n\nClaude, ChatGPT and Copilot need the plugin: ${NOT_RUNNING}`))
  return 0
}

async function status(args: Args, out: Out): Promise<number> {
  const r = await ask<any>(args, "/api/menubar", (b) => typeof b?.now === "number" && Array.isArray(b?.providers))
  if ("error" in r) return fail(out, r.error)
  const m = r.body
  if (args.flags.has("json")) {
    out.log(JSON.stringify(m, null, 2))
    return 0
  }
  const lines = [`quota-router${m.paused ? ", paused" : ""}${m.dryRun ? ", dry run" : ""}${m.url ? ` · ${m.url}` : ""}`, ""]
  lines.push(
    table(
      ["Provider", "State", "Sessions"],
      m.providers.map((p: any) => [
        String(p.id),
        p.saved ? `saved until ${time(p.saved)}` : p.status === "available" ? "available" : `${p.status}${p.until ? ` until ${time(p.until)}` : ""}`,
        String(p.serving ?? 0),
      ]),
    ),
  )
  if (m.live?.length) lines.push("", "Running:", ...m.live.map((l: any) => `  ${l.title} · ${l.model ?? "?"}${l.fallback ? ` (fell back from ${l.fallback})` : ""}`))
  if (m.today) lines.push("", `Today: ${tok(m.today.tokens)} tokens in ${m.today.steps} requests, worth ${usd(m.today.equiv)} at API prices, ${usd(m.today.actual)} spent.`)
  out.log(lines.join("\n"))
  return 0
}

const ANSI = { muted: "\x1b[2m", warning: "\x1b[33m", error: "\x1b[31m" }

/** For shell prompts: quick, quiet, never an error. Prints nothing when there's nothing to say. */
async function prompt(args: Args, out: Out): Promise<number> {
  const feed = await Promise.race([dashboard(args)<StatusFeed>("/api/status", (b) => typeof b?.sessions === "object" && b.sessions !== null), new Promise<undefined>((r) => (setTimeout(r, 400) as { unref?: () => void }).unref?.())])
  const line = statusLine(feed)
  if (!line) return 0
  const color = args.flags.has("color") || (!args.flags.has("no-color") && process.stdout.isTTY && !process.env.NO_COLOR)
  out.log(color ? `${ANSI[line.tone]}${line.text}\x1b[0m` : line.text)
  return 0
}

async function doctor(args: Args, out: Out): Promise<number> {
  const r = await ask<any>(args, "/api/doctor", (b) => Array.isArray(b?.checks))
  if ("error" in r) return fail(out, r.error)
  const d = r.body
  if (args.flags.has("json")) {
    out.log(JSON.stringify(d, null, 2))
    return 0
  }
  const mark: Record<string, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" }
  out.log(d.checks.map((c: any) => `${mark[c.status] ?? "·"} ${c.title}${c.detail ? `\n    ${c.detail}` : ""}`).join("\n"))
  return d.checks.some((c: any) => c.status === "fail") ? 1 : 0
}

async function open(args: Args, out: Out): Promise<number> {
  // Where the plugin noted it is, then the port given and the next few (it takes the next free one when its own is taken).
  const explicit = args.flags.has("port") || process.env.QUOTA_ROUTER_PORT
  const noted = explicit ? undefined : notedPort()
  for (const p of new Set([...(noted ? [noted] : []), ...Array.from({ length: 5 }, (_, i) => port(args) + i)])) {
    const ok = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.json())
      .then((b: any) => b?.app === "quota-router")
      .catch(() => false)
    if (!ok) continue
    const url = `http://127.0.0.1:${p}/`
    execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url]).unref()
    out.log(url)
    return 0
  }
  return fail(out, NOT_RUNNING)
}

function fail(out: Out, message: string): number {
  out.err(message)
  return 1
}

export async function main(argv: string[], out: Out = { log: (s) => console.log(s), err: (s) => console.error(s) }, paths: Paths = defaultPaths()): Promise<number> {
  const args = parseArgs(argv)
  if (args.bad) return fail(out, `${args.bad}\n\nRun quota-router --help for the commands.`)
  if (args.flags.has("version")) {
    out.log(VERSION)
    return 0
  }
  if (args.flags.has("help") || !args.command || args.command === "help") {
    out.log(HELP)
    return 0
  }
  const run: Record<string, () => Promise<number>> = {
    usage: () => usage(args, out, paths),
    limits: () => limits(args, out, paths),
    status: () => status(args, out),
    prompt: () => prompt(args, out),
    doctor: () => doctor(args, out),
    open: () => open(args, out),
  }
  if (!Object.hasOwn(run, args.command)) return fail(out, `Unknown command ${args.command}\n\nRun quota-router --help for the commands.`)
  return run[args.command]()
}
