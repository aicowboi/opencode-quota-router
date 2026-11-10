// The command line and its log readers, on invented logs written to a temporary folder.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { claudeParser, codexParser, readOpenCode, readUsage, type Usage } from "../src/cli/readers.ts"
import { scan, jsonlFiles } from "../src/cli/scan.ts"
import { loadPrices, rangeStart, summarise, valueOf } from "../src/cli/report.ts"
import { main, parseArgs, table } from "../src/cli/index.ts"
import { dashboardFile, notedPort, reader } from "../src/tui-feed.ts"
import { VERSION } from "../src/version.ts"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-cli-"))
// Nothing from this machine: the plugin's files and OpenCode's catalogue are looked for under the temporary folder.
process.env.XDG_DATA_HOME = path.join(tmp, "data")
process.env.XDG_CACHE_HOME = path.join(tmp, "cache")
const T0 = Date.parse("2026-11-09T10:00:00Z")
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const write = (file: string, lines: unknown[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n")
}
const assistant = (id: string, minutes: number, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: iso(minutes),
  requestId: `req_${id}`,
  cwd: "/work/storefront",
  message: { id: `msg_${id}`, model: "claude-opus-5-5", usage },
  ...extra,
})

test("Claude Code: one reply over several lines counts once with its largest figures, subagent logs are included, synthetic replies are not", async () => {
  const root = path.join(tmp, "claude", "projects")
  write(path.join(root, "-work-storefront", "ses1.jsonl"), [
    { type: "user", timestamp: iso(0), message: { content: "invented" } },
    assistant("a", 1, { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
    assistant("a", 1, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
    assistant("b", 3, { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }),
    { ...assistant("s", 4, { input_tokens: 0, output_tokens: 0 }), message: { id: "msg_s", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } },
    "not json at all",
  ])
  // A resumed session repeats reply b; a subagent's log sits two folders down.
  write(path.join(root, "-work-storefront", "ses2.jsonl"), [assistant("b", 3, { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2000 })])
  write(path.join(root, "-work-storefront", "ses1", "subagents", "agent-1.jsonl"), [assistant("c", 5, { input_tokens: 1, output_tokens: 9, cache_read_input_tokens: 300 }, { isSidechain: true })])
  assert.equal(jsonlFiles(root).length, 3)
  const { usage } = await readUsage(["claude-code"], { claude: root, codex: path.join(tmp, "none"), opencode: path.join(tmp, "none.db"), cache: path.join(tmp, "cache1") })
  const by = Object.fromEntries(usage.map((u) => [u.id, u]))
  assert.deepEqual(Object.keys(by).sort(), ["msg_a:req_a", "msg_b:req_b", "msg_c:req_c"])
  assert.deepEqual([by["msg_a:req_a"].output, by["msg_a:req_a"].cacheRead, by["msg_a:req_a"].cacheWrite], [40, 1000, 50])
  assert.equal(by["msg_a:req_a"].project, "/work/storefront")
  assert.equal(by["msg_a:req_a"].providerID, "anthropic")
})

test("the scan reads only what was appended, and leaves a line that is still being written for next time", async () => {
  const file = path.join(tmp, "inc", "p", "s.jsonl")
  const cache = path.join(tmp, "cache2")
  write(file, [assistant("x", 1, { input_tokens: 1, output_tokens: 1 })])
  let entries = await scan("t", [file], claudeParser, { dir: cache })
  assert.equal(entries.get(file)!.records.length, 1)
  assert.equal((fs.statSync(path.join(cache, "t.json")).mode & 0o777).toString(8), "600")
  // Append one whole line and half of another.
  const half = JSON.stringify(assistant("z", 3, { input_tokens: 3, output_tokens: 3 }))
  fs.appendFileSync(file, JSON.stringify(assistant("y", 2, { input_tokens: 2, output_tokens: 2 })) + "\n" + half.slice(0, 20))
  entries = await scan("t", [file], claudeParser, { dir: cache })
  assert.deepEqual(entries.get(file)!.records.map((r) => r.id), ["msg_x:req_x", "msg_y:req_y"])
  fs.appendFileSync(file, half.slice(20) + "\n")
  // Parsing from the start again would find the same three; the cache must not double-count the first two.
  let lines = 0
  entries = await scan("t", [file], { ...claudeParser, line: (t, s, f) => (lines++, claudeParser.line(t, s, f)) }, { dir: cache })
  assert.equal(lines, 1)
  assert.deepEqual(entries.get(file)!.records.map((r) => r.id), ["msg_x:req_x", "msg_y:req_y", "msg_z:req_z"])
  // A file that was rewritten shorter is read again from the start.
  write(file, [assistant("w", 1, { input_tokens: 1, output_tokens: 1 })])
  entries = await scan("t", [file], claudeParser, { dir: cache })
  assert.deepEqual(entries.get(file)!.records.map((r) => r.id), ["msg_w:req_w"])
})

test("Codex: usage is the change in the running total, cached input and reasoning are taken out, and the newest limits are kept", async () => {
  const root = path.join(tmp, "codex", "sessions")
  const total = (input: number, cached: number, output: number, reasoning: number) => ({
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
  })
  const count = (minutes: number, t: unknown, used: number) => ({
    timestamp: iso(minutes),
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: t }, rate_limits: { plan_type: "plus", primary: { used_percent: used, window_minutes: 300, resets_at: (T0 + 3 * 3_600_000) / 1000 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: (T0 + 5 * 86_400_000) / 1000 } } },
  })
  write(path.join(root, "2026", "11", "09", "rollout-a.jsonl"), [
    { timestamp: iso(0), type: "session_meta", payload: { cwd: "/work/billing" } },
    { timestamp: iso(0), type: "turn_context", payload: { model: "gpt-5.6", cwd: "/work/billing" } },
    count(1, total(1000, 800, 50, 10), 4),
    count(2, total(1000, 800, 50, 10), 4), // repeated, nothing new
    count(3, total(3000, 2600, 120, 30), 6),
  ])
  const { usage, codexLimits } = await readUsage(["codex"], { claude: path.join(tmp, "none"), codex: root, opencode: path.join(tmp, "none.db"), cache: path.join(tmp, "cache3") })
  assert.equal(usage.length, 2)
  assert.deepEqual(usage.map((u) => [u.model, u.project, u.input, u.cacheRead, u.output, u.reasoning]), [
    ["gpt-5.6", "/work/billing", 200, 800, 40, 10],
    ["gpt-5.6", "/work/billing", 200, 1800, 50, 20],
  ])
  assert.equal(codexLimits!.plan, "plus")
  assert.deepEqual(codexLimits!.windows.map((w) => [w.label, w.usedPct]), [["5-hour", 6], ["Weekly", 3]])
  assert.equal(codexParser.version, 1)
})

test("OpenCode: assistant messages with tokens, read from its database without changing it", async () => {
  const file = path.join(tmp, "opencode.db")
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE session_v2 (id TEXT, directory TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT)")
  db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("ses_1", "/work/storefront")
  const msg = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)")
  msg.run("m1", "ses_1", "assistant", JSON.stringify({ time: { created: T0, completed: T0 + 5000 }, model: { providerID: "xai", id: "grok-4.7" }, cost: 0.02, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } } }))
  msg.run("m2", "ses_1", "assistant", JSON.stringify({ time: { created: T0 }, model: { providerID: "xai", id: "grok-4.7" } })) // still streaming
  msg.run("m3", "ses_1", "user", JSON.stringify({ tokens: { input: 1 } }))
  db.close()
  const before = fs.readFileSync(file)
  const usage = await readOpenCode(file)
  assert.deepEqual(usage.map((u) => [u.id, u.providerID, u.model, u.input, u.output, u.reasoning, u.cacheRead, u.cost, u.project, u.at]), [["m1", "xai", "grok-4.7", 100, 20, 5, 1000, 0.02, "/work/storefront", T0 + 5000]])
  assert.ok(before.equals(fs.readFileSync(file)))
  assert.deepEqual(await readOpenCode(path.join(tmp, "missing.db")), [])
})

test("usage totals: grouped, limited to the range, and valued at list price from the catalogue", () => {
  const catalogue = path.join(tmp, "models.json")
  fs.writeFileSync(catalogue, JSON.stringify({ anthropic: { models: { "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } } } }, openai: { models: { "gpt-5.6": { cost: { input: 2, output: 10, cache_read: 0.2, tiers: [{ input: 4, output: 20, cache_read: 0.4, tier: { type: "context", size: 272000 } }] } } } } }))
  const prices = loadPrices(catalogue, path.join(tmp, "no-snapshot.json"))
  const u = (over: Partial<Usage>): Usage => ({ source: "claude-code", id: "x", at: T0, providerID: "anthropic", model: "claude-opus-5-5", input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...over })
  assert.equal(valueOf(prices, u({})), 4)
  assert.equal(valueOf(prices, u({ providerID: "claude-agent", model: "opus" })), 4)
  assert.equal(valueOf(prices, u({ providerID: "openai", model: "gpt-5.6", input: 300_000 })), 1.2) // above 272K context: the higher tier
  assert.equal(valueOf(prices, u({ providerID: "xai", model: "grok-4.7", cost: 0.5 })), 0.5)
  assert.equal(valueOf(prices, u({ providerID: "xai", model: "grok-4.7" })), undefined)
  const all = [u({ id: "1" }), u({ id: "2", at: T0 - 10 * 86_400_000, project: "/work/billing" }), u({ id: "3", providerID: "xai", model: "grok-4.7", project: "/work/billing" })]
  const { rows, total } = summarise(all, "project", prices, rangeStart("7d", T0))
  assert.deepEqual(rows.map((r) => [r.key, r.requests]), [["(none)", 1], ["billing", 1]])
  assert.equal(total.requests, 2)
  assert.equal(total.priced, false)
  assert.equal(total.value, 4)
  assert.equal(new Date(rangeStart("today", T0)).getHours(), 0)
  assert.equal(rangeStart("all", T0), 0)

  // The plugin's copy of OpenCode's live prices wins over the catalogue file, which can be weeks old.
  const snapshot = path.join(tmp, "prices.json")
  fs.writeFileSync(snapshot, JSON.stringify({ at: T0, prices: { "anthropic/claude-fable-5-2": [{ input: 8, output: 40, cache: { read: 0.2, write: 10 } }], "anthropic/claude-opus-5-5": [{ input: 4, output: 20 }], bad: [{ input: 1, output: 1 }], "x/neg": [{ input: -1, output: 1 }] } }))
  const both = loadPrices(catalogue, snapshot)
  assert.equal(valueOf(both, u({ model: "claude-fable-5-2" })), 8)
  assert.equal(valueOf(both, u({ providerID: "claude-agent", model: "claude-fable-5-2" })), 8)
  assert.equal(valueOf(both, u({ providerID: "openai", model: "gpt-5.6", input: 300_000 })), 1.2) // still from the catalogue
  assert.equal(both.has("bad") || both.has("x/neg"), false)
  assert.equal(loadPrices(path.join(tmp, "no-catalogue.json"), snapshot).size, 2)
  fs.writeFileSync(snapshot, "{ broken")
  assert.equal(loadPrices(catalogue, snapshot).size, prices.size)
})

test("command line: arguments, help, errors, and a usage table from invented logs", async () => {
  assert.deepEqual([...parseArgs(["usage", "--by", "model", "--source=codex,opencode", "--json"]).flags], [["by", ["model"]], ["source", ["codex,opencode"]], ["json", ["1"]]])
  assert.match(parseArgs(["usage", "--bogus"]).bad!, /Unknown option --bogus/)
  assert.match(parseArgs(["usage", "--range"]).bad!, /needs a value/)
  assert.equal(table(["A", "B"], [["x", "1"], ["yy", "22"]]), "A    B\n──  ──\nx    1\nyy  22")

  const run = async (...argv: string[]) => {
    const log: string[] = [], err: string[] = []
    const code = await main(argv, { log: (s) => log.push(s), err: (s) => err.push(s) }, { claude: path.join(tmp, "claude", "projects"), codex: path.join(tmp, "codex", "sessions"), opencode: path.join(tmp, "opencode.db"), cache: path.join(tmp, "cache4") })
    return { code, out: log.join("\n"), err: err.join("\n") }
  }
  assert.equal((await run("--version")).out, VERSION)
  assert.match((await run()).out, /Commands:/)
  assert.equal((await run("nope")).code, 1)
  assert.match((await run("usage", "--range", "3d")).err, /--range should be one of/)
  assert.match((await run("usage", "--source", "cursor")).err, /Unknown source cursor/)
  const json = JSON.parse((await run("usage", "--range", "all", "--by", "source", "--json")).out)
  assert.deepEqual(json.rows.map((r: any) => [r.key, r.requests]).sort(), [["claude-code", 3], ["codex", 2], ["opencode", 1]])
  const text = (await run("usage", "--range", "all", "--by", "model", "--source", "claude-code")).out
  assert.match(text, /^Model\s+Requests/)
  assert.match(text, /anthropic\/claude-opus-5-5\s+3/)
  // With no plugin listening, the prompt line is empty and never an error.
  const port = String(48_100 + Math.floor(Math.random() * 500))
  assert.deepEqual(await run("prompt", "--port", port), { code: 0, out: "", err: "" })
  assert.match((await run("status", "--port", port)).err, /isn't answering/)
})

test("the built command matches the source version", () => {
  const out = execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "dist", "cli.mjs"), "--version"], { encoding: "utf8" }).trim()
  assert.equal(out, VERSION, "dist/cli.mjs is stale: run npm run build")
})

test("the dashboard's address: noted by the plugin, read first by the terminal part and the command line, and only if local", async () => {
  const env = { XDG_DATA_HOME: path.join(tmp, "xdg") }
  const file = dashboardFile(env)
  assert.equal(file, path.join(tmp, "xdg", "opencode-quota-router", "dashboard.json"))
  assert.equal(notedPort(file), undefined)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (const [url, port] of [["http://127.0.0.1:47450", 47450], ["http://localhost:47451", 47451], ["http://evil.example:47452", undefined], ["https://127.0.0.1:1", undefined], ["not a url", undefined]] as const) {
    fs.writeFileSync(file, JSON.stringify({ url }))
    assert.equal(notedPort(file), port, url)
  }
  fs.writeFileSync(file, "{ broken")
  assert.equal(notedPort(file), undefined)

  // The noted port is asked first; without an answer there, the usual ports follow.
  const asked: number[] = []
  const get = (async (url: string) => {
    asked.push(Number(new URL(url).port))
    if (!url.includes(":47450/")) throw new Error("refused")
    return { ok: true, json: async () => ({ sessions: {} }) }
  }) as any
  assert.deepEqual(await reader(47321, get, () => 47450)("/api/status", () => true), { sessions: {} })
  assert.deepEqual(asked, [47450])
  asked.length = 0
  assert.equal(await reader(47321, get, () => 47999)("/api/status", () => true), undefined)
  assert.deepEqual(asked, [47999, 47321, 47322, 47323, 47324, 47325])
})
