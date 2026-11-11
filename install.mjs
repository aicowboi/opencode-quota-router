#!/usr/bin/env node
// Standalone, dependency-free installer. Also bundled into `quota-router install`; never starts/restarts OpenCode.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

export const INSTALL_VERSION = "0.2.0"
const NAME = "opencode-quota-router"
const exec = promisify(execFile)
const HELP = `Install quota-router ${INSTALL_VERSION} for OpenCode V2 (Node.js 24+ and npm).

  node install.mjs [options]
  quota-router install [options]

  --package <file.tgz>   Install a local release tarball instead of npm
  --config <file>        Use a specific OpenCode JSON/JSONC file
  --install-dir <dir>    Store immutable plugin builds in this directory
  --dry-run             Show the plan without installing or changing files
  -h, --help            Show this help

A tarball beside install.mjs is used automatically. Otherwise the source is
${NAME}@${INSTALL_VERSION}. Existing settings and comments are kept. Changed config
gets a private backup. No sudo, shell-profile edits, provider requests, model changes or service restarts.`

/** Small JSONC syntax tree: preserve every existing byte except the plugin entry and necessary commas. */
export function parseJSONC(source) {
  if (source.length > 1_048_576) throw new Error("OpenCode config exceeds 1 MB; edit the plugin entry manually.")
  let at = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const bad = () => { throw new Error("OpenCode config is not valid JSON/JSONC. Nothing was changed.") }
  const skip = () => {
    for (;;) {
      while (/\s/.test(source[at] || "") && at < source.length) at++
      if (source.slice(at, at + 2) === "//") { while (at < source.length && source[at] !== "\n") at++ }
      else if (source.slice(at, at + 2) === "/*") { const end = source.indexOf("*/", at + 2); if (end < 0) bad(); at = end + 2 }
      else return
    }
  }
  const value = (depth = 0) => {
    if (depth > 64) bad()
    skip()
    const start = at, c = source[at]
    if (c === '"') {
      at++
      let escaped = false
      while (at < source.length) {
        const next = source[at++]
        if (!escaped && next === '"') {
          try { return { kind: "string", start, end: at, value: JSON.parse(source.slice(start, at)) } } catch { bad() }
        }
        if (escaped) escaped = false
        else if (next === "\\") escaped = true
      }
      bad()
    }
    if (c === "{" || c === "[") {
      const object = c === "{", close = object ? "}" : "]", items = [], properties = [], result = object ? Object.create(null) : []
      at++; skip()
      let trailingComma = false
      while (source[at] !== close) {
        if (at >= source.length) bad()
        if (object) {
          const key = value(depth + 1)
          if (key.kind !== "string") bad()
          skip(); if (source[at++] !== ":") bad()
          const node = value(depth + 1)
          properties.push({ key: key.value, node }); result[key.value] = node.value
        } else { const node = value(depth + 1); items.push(node); result.push(node.value) }
        skip()
        if (source[at] === ",") { at++; skip(); trailingComma = source[at] === close }
        else if (source[at] !== close) bad()
      }
      at++
      return { kind: object ? "object" : "array", start, end: at, value: result, items, properties, trailingComma }
    }
    while (at < source.length && !/[\s,\]}\/]/.test(source[at])) at++
    if (at === start) bad()
    try { return { kind: "primitive", start, end: at, value: JSON.parse(source.slice(start, at)) } } catch { bad() }
  }
  const root = value()
  skip(); if (at !== source.length || root.kind !== "object") bad()
  return root
}

function isRouter(spec, directory) {
  if (typeof spec !== "string") return false
  const normalized = spec.replace(/\\/g, "/").replace(/\/$/, "")
  if (/^opencode-quota-router(?:@[^\s/]+)?$/.test(normalized) || normalized.endsWith("/opencode-quota-router")) return true
  if (/^(?:[a-z]+:|~)/i.test(spec)) return false
  try { return JSON.parse(fs.readFileSync(path.resolve(directory, spec, "package.json"), "utf8")).name === NAME } catch { return false }
}

export function editConfig(source, installed, directory = process.cwd()) {
  const root = parseJSONC(source), matches = root.properties.filter((p) => p.key === "plugins")
  if (matches.length > 1) throw new Error("OpenCode config has duplicate plugins properties. Consolidate them first; nothing was changed.")
  const plugins = matches[0]?.node
  if (plugins && plugins.kind !== "array") throw new Error("OpenCode plugins must be an array. Nothing was changed.")
  if (Array.isArray(root.value.plugin) && root.value.plugin.some((p) => isRouter(typeof p === "string" ? p : p?.package, directory))) throw new Error("A legacy plugin entry already contains quota-router. Move it to the V2 plugins array before installing; nothing was changed.")
  const targets = []
  for (const item of plugins?.items || []) {
    const reference = item.kind === "string" ? item.value : item.value?.package
    if (typeof reference === "string" && /\{(?:env|file):/.test(reference)) throw new Error("A plugin entry uses variable substitution. Set the quota-router entry explicitly before installing; nothing was changed.")
    if (item.kind === "string" && isRouter(item.value, directory)) targets.push(item)
    if (item.kind === "object") {
      const entries = item.properties.filter((p) => p.key === "package")
      if (entries.some((p) => isRouter(p.node.value, directory))) {
        if (entries.length !== 1) throw new Error("A quota-router entry has duplicate package properties. Nothing was changed.")
        targets.push(entries[0].node)
      }
    }
  }
  if (targets.length > 1) throw new Error("Multiple quota-router entries found. Keep one before installing; nothing was changed.")
  if (targets.length) {
    const target = targets[0]
    const text = source.slice(0, target.start) + JSON.stringify(installed) + source.slice(target.end)
    parseJSONC(text)
    return { text, changed: text !== source, action: "update" }
  }
  const container = plugins || root, last = plugins ? plugins.items.at(-1) : root.properties.at(-1)?.node
  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  const unit = source.match(/(?:^|\n)([ \t]+)"/)?.[1] || "  "
  const parentIndent = plugins ? unit : "", indent = parentIndent + unit
  const entry = plugins ? { package: installed } : [{ package: installed }]
  const formatted = JSON.stringify(entry, null, unit).split("\n").map((line, i) => i ? indent + line : line).join(newline)
  const addition = plugins ? formatted : '"plugins": ' + formatted
  const edits = [{ start: container.end - 1, end: container.end - 1, text: newline + indent + addition + (container.trailingComma ? "," : "") + newline + parentIndent }]
  if (last && !container.trailingComma) edits.push({ start: last.end, end: last.end, text: "," })
  let text = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  parseJSONC(text)
  return { text, changed: true, action: "add" }
}

export function parseInstallArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (["--package", "--config", "--install-dir"].includes(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a path`)
      options[arg === "--install-dir" ? "installDir" : arg.slice(2)] = value
    } else throw new Error(`Unknown install option ${arg}. Run quota-router install --help.`)
  }
  return options
}

export function resolveNpm(env = process.env, platform = process.platform, executable = process.execPath) {
  const cli = env.npm_execpath
  if (cli && path.basename(cli) === "npm-cli.js" && fs.existsSync(cli)) return { command: executable, prefix: [cli] }
  const dirs = [path.dirname(executable), ...(env.PATH || env.Path || "").split(platform === "win32" ? ";" : path.delimiter)]
  for (const dir of dirs.filter(Boolean)) {
    const adjacent = path.join(dir, "node_modules/npm/bin/npm-cli.js")
    if (fs.existsSync(adjacent)) return { command: executable, prefix: [adjacent] }
    if (platform !== "win32") {
      try { const real = fs.realpathSync(path.join(dir, "npm")); if (path.basename(real) === "npm-cli.js") return { command: executable, prefix: [real] } } catch {}
    }
  }
  if (platform === "win32") throw new Error("npm could not be found beside Node.js. Install Node.js 24+ with npm, then try again.")
  return { command: "npm", prefix: [] }
}

function configPath(options, home, env) {
  if (options.config) return path.resolve(options.config)
  if (env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_DIR) throw new Error("An alternate OpenCode config source is active. Pass --config <file> explicitly; nothing was changed.")
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
  const json = path.join(dir, "opencode.json"), jsonc = path.join(dir, "opencode.jsonc")
  if (fs.existsSync(json) && fs.existsSync(jsonc)) throw new Error("Both opencode.json and opencode.jsonc exist. Choose one with --config; nothing was changed.")
  return fs.existsSync(json) ? json : jsonc
}

function snapshot(file) {
  try {
    const actual = fs.realpathSync(file), stat = fs.statSync(actual)
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error("OpenCode config is not a regular file under 1 MB.")
    return { actual, original: fs.readFileSync(actual, "utf8"), mode: stat.mode & 0o777 }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    if (fs.existsSync(path.dirname(file)) && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("OpenCode config is a dangling symlink. Fix it before installing.")
    return { actual: file, original: undefined, mode: 0o600 }
  }
}

function sameSnapshot(file, before) {
  const now = snapshot(file)
  return now.actual === before.actual && now.original === before.original && now.mode === before.mode
}

function validateBuild(folder) {
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"))
  if (pkg.name !== NAME || pkg.version !== INSTALL_VERSION) throw new Error(`Expected ${NAME}@${INSTALL_VERSION}. No OpenCode config was changed.`)
  for (const key of [".", "./engine", "./tui", "./gui-experimental"]) {
    const file = pkg.exports?.[key]
    if (typeof file !== "string" || !path.resolve(folder, file).startsWith(folder + path.sep) || !fs.statSync(path.resolve(folder, file)).isFile()) throw new Error(`Package is missing its ${key} entry point. No OpenCode config was changed.`)
  }
  if (!fs.existsSync(path.join(folder, "dist/cli.mjs"))) throw new Error("The package has no built command line. No OpenCode config was changed.")
}

export async function install(options = {}, runtime = {}) {
  const env = runtime.env || process.env, home = runtime.home || os.homedir()
  if (Number((runtime.nodeVersion || process.versions.node).split(".")[0]) < 24) throw new Error("Node.js 24 or later and npm are required. Install them from https://nodejs.org, then try again.")
  const file = configPath(options, home, env), before = snapshot(file)
  const original = before.original ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
  // Check config before downloading anything, without touching the actual entry yet.
  editConfig(original, path.join(home, ".quota-router-install-preview"), path.dirname(file))
  const beside = path.join(path.dirname(fileURLToPath(import.meta.url)), `${NAME}-${INSTALL_VERSION}.tgz`)
  const local = options.package ? path.resolve(options.package) : fs.existsSync(beside) ? beside : undefined
  if (local && (!local.endsWith(".tgz") || !fs.statSync(local).isFile())) throw new Error("--package must point to a local .tgz release tarball.")
  const source = local || `${NAME}@${INSTALL_VERSION}`
  if (options.dryRun) return { dryRun: true, config: file, source, version: INSTALL_VERSION, changed: false }
  const npm = runtime.runNpm || (async (args, cwd) => {
    const command = resolveNpm(env)
    const result = await exec(command.command, [...command.prefix, ...args], { cwd, env, timeout: 180_000, maxBuffer: 16 << 20, windowsHide: true })
    return result.stdout
  })
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "quota-router-install-"))
  let archive
  try {
    let packed
    try { packed = JSON.parse(await npm(["pack", source, "--ignore-scripts", "--json", "--pack-destination", temporary], temporary)) } catch {
      throw new Error(`Could not download ${NAME}@${INSTALL_VERSION}. Check npm/network access. Before npm publication, use --package <local-release.tgz>. No OpenCode config was changed.`)
    }
    const info = Array.isArray(packed) && packed.length === 1 ? packed[0] : undefined
    if (!info || info.name !== NAME || info.version !== INSTALL_VERSION || typeof info.filename !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(info.filename) || path.basename(info.filename) !== info.filename) throw new Error("npm returned an unexpected package. No OpenCode config was changed.")
    archive = path.join(temporary, info.filename)
    const integrity = "sha512-" + createHash("sha512").update(fs.readFileSync(archive)).digest("base64")
    if (integrity !== info.integrity) throw new Error("The package integrity check failed. No OpenCode config was changed.")
    const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex").slice(0, 12)
    const base = path.resolve(options.installDir || path.join(env.XDG_DATA_HOME || path.join(home, ".local/share"), "opencode-quota-router", "installations"))
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    let prefix = path.join(base, `${INSTALL_VERSION}-${digest}`), reused = false
    const receiptFile = (dir) => path.join(dir, "quota-router-install.json")
    if (fs.existsSync(prefix)) {
      try { reused = JSON.parse(fs.readFileSync(receiptFile(prefix), "utf8")).integrity === integrity; if (reused) validateBuild(path.join(prefix, "node_modules", NAME)) } catch { reused = false }
      if (!reused) prefix = fs.mkdtempSync(prefix + "-")
    } else fs.mkdirSync(prefix, { mode: 0o700 })
    const installed = path.join(prefix, "node_modules", NAME)
    if (!reused) {
      try { await npm(["install", "--prefix", prefix, "--ignore-scripts", "--omit=dev", "--no-save", "--package-lock=false", "--prefer-offline", archive], prefix) } catch {
        throw new Error("npm could not install the release and its dependencies. Check your Node.js version and npm/network access; no OpenCode config was changed.")
      }
      validateBuild(installed)
      fs.writeFileSync(receiptFile(prefix), JSON.stringify({ name: NAME, version: INSTALL_VERSION, integrity }) + "\n", { mode: 0o600, flag: "wx" })
    }
    if (!sameSnapshot(file, before)) throw new Error("OpenCode config changed while installing. Nothing was overwritten; run the installer again.")
    const updated = editConfig(original, installed, path.dirname(file))
    let backup
    if (updated.changed) {
      fs.mkdirSync(path.dirname(before.actual), { recursive: true, mode: 0o700 })
      const pending = path.join(path.dirname(before.actual), `.quota-router-${randomUUID()}.tmp`)
      try {
        fs.writeFileSync(pending, updated.text, { mode: before.mode, flag: "wx" })
        fs.chmodSync(pending, before.mode)
        if (!sameSnapshot(file, before)) throw new Error("OpenCode config changed while installing. Nothing was overwritten; run the installer again.")
        if (before.original !== undefined) {
          backup = `${before.actual}.quota-router-${Date.now()}-${randomUUID().slice(0, 8)}.local.bak`
          fs.writeFileSync(backup, before.original, { mode: 0o600, flag: "wx" })
        }
        fs.renameSync(pending, before.actual)
      } finally { if (fs.existsSync(pending)) fs.unlinkSync(pending) }
    }
    return { dryRun: false, config: file, source, version: INSTALL_VERSION, installed, backup, changed: updated.changed, reused }
  } finally {
    if (archive && fs.existsSync(archive)) fs.unlinkSync(archive)
    try { fs.rmdirSync(temporary) } catch {}
  }
}

export async function installerMain(argv = [], out = { log: console.log, err: console.error }, runtime = {}) {
  try {
    const options = parseInstallArgs(argv)
    if (options.help) { out.log(HELP); return 0 }
    const result = await install(options, runtime)
    if (result.dryRun) out.log(`Dry run: would install quota-router ${result.version} from ${result.source} and update ${result.config}. No files changed.`)
    else {
      out.log(`quota-router ${result.version} ${result.changed ? "installed" : "is already configured"}.`)
      out.log(`OpenCode config: ${result.config}`)
      if (result.backup) out.log(`Backup: ${result.backup}`)
      out.log("Next: open OpenCode normally, connect your providers, then run /router. No service restart is needed.")
      out.log("Existing models, provider credentials, other plugins and quota-router options were kept. Intelligent setup is optional.")
    }
    return 0
  } catch (error) { out.err(`quota-router install: ${error instanceof Error ? error.message : "Installation failed; check your config and npm access."}`); return 1 }
}

// The basename check keeps this entry point inert when Vite bundles it into dist/cli.mjs.
if (process.argv[1] && path.basename(process.argv[1]) === "install.mjs" && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await installerMain(process.argv.slice(2))
}
