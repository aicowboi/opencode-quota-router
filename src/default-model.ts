// Model transforms expose registry overrides, not necessarily the root `model` in opencode.jsonc. Read only that
// field from documented local config locations, in precedence order. Ambiguous/unreadable sources fail closed.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type DefaultInspection = { known: boolean; model?: { providerID: string; modelID: string } }

/** JSONC comments and trailing commas, without changing quoted strings (URLs, escaped quotes, comment markers). */
export function parseConfigDocument(source: string): Record<string, unknown> {
  let clean = "", quoted = false, escaped = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quoted) {
      clean += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') { quoted = true; clean += c }
    else if (c === "/" && source[i + 1] === "/") {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++
      clean += " "
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      if (end === -1) throw new Error("Unclosed config comment")
      i = end + 1; clean += " "
    } else clean += c
  }
  let json = ""
  quoted = false; escaped = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!
    if (!quoted && c === "," && /^\s*[}\]]/.test(clean.slice(i + 1))) continue
    json += c
    if (escaped) escaped = false
    else if (quoted && c === "\\") escaped = true
    else if (c === '"') quoted = !quoted
  }
  const result = JSON.parse(json.replace(/^\uFEFF/, ""))
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Config is not an object")
  return result
}

function modelValue(value: unknown): DefaultInspection["model"] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>
    if (typeof v.providerID === "string" && typeof v.model === "string") value = `${v.providerID}/${v.model}`
  }
  if (typeof value !== "string" || !/^[^/\s{}]+\/[^\s{}]+$/.test(value)) return undefined
  const [providerID, ...parts] = value.replace(/#.*$/, "").split("/")
  return { providerID: providerID!, modelID: parts.join("/") }
}

export function inspectDefault(directory: string, options: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; system?: string } = {}): DefaultInspection {
  const env = options.env ?? process.env, home = options.home ?? os.homedir(), platform = options.platform ?? process.platform
  let known = true, model: DefaultInspection["model"]
  const read = (folder: string) => {
    let found = 0
    for (const file of ["opencode.json", "opencode.jsonc"]) {
      try {
        const full = path.join(folder, file), stat = fs.statSync(full)
        found++
        if (stat.size > 1_048_576) { known = false; continue }
        const value = parseConfigDocument(fs.readFileSync(full, "utf8"))
        if (Object.hasOwn(value, "model")) {
          const next = modelValue(value.model)
          if (next) model = next
          else known = false
        }
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) known = false
      }
    }
    if (found > 1) known = false
  }
  read(path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"))
  const ancestors: string[] = []
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) { ancestors.unshift(dir); if (path.dirname(dir) === dir) break }
  for (const dir of ancestors) read(dir)
  for (const dir of ancestors) read(path.join(dir, ".opencode"))
  read(options.system ?? (platform === "darwin" ? "/Library/Application Support/opencode" : platform === "win32" ? path.join(env.ProgramData || "C:\\ProgramData", "opencode") : "/etc/opencode"))
  // Alternate/inline sources and MDM may outrank files. Never activate a preset while the default is uncertain.
  if (env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_DIR) known = false
  if (platform === "darwin" && ["/Library/Managed Preferences/ai.opencode.managed.plist", `/Library/Managed Preferences/${env.USER || path.basename(home)}/ai.opencode.managed.plist`].some((p) => fs.existsSync(p))) known = false
  return { known, model }
}
