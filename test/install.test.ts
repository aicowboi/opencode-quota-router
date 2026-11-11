import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { editConfig, install, installerMain, INSTALL_VERSION, parseInstallArgs, parseJSONC, resolveNpm, type InstallRuntime } from "../install.mjs"
import { VERSION } from "../src/version.ts"
import { main } from "../src/cli/index.ts"

const plain = (source: string) => JSON.parse(JSON.stringify(parseJSONC(source).value))
const source = `{
  // Keep the user's model and comments, including URLs and quote escapes.
  "model": "provider/coder",
  "providers": { "example": { "settings": { "apiKey": "invented-placeholder" } } },
  "url": "https://example.invalid/path/*keep*/?q=,}",
  "plugins": [
    "another-plugin", // Keep this plugin.
    { "package": "opencode-quota-router@0.1.0", "options": { "enabled": false, "spend": { "monthlyUsd": 4 } } },
  ],
}
`

function fixture(config = source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qr-install-test-"))
  const env = { XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data") }
  const file = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, config, { mode: 0o640 })
  const local = path.join(root, "release.tgz"), bytes = Buffer.from("invented release archive")
  fs.writeFileSync(local, bytes)
  const calls: string[][] = []
  const behavior = { failPack: false, failInstall: false, wrongName: false, wrongIntegrity: false, wrongBuild: false, filename: "opencode-quota-router-0.2.0.tgz", onPack: undefined as undefined | (() => void) }
  const runtime: InstallRuntime = {
    env, home: path.join(root, "home"), nodeVersion: "24.0.0",
    runNpm: async (args) => {
      calls.push(args)
      if (args[0] === "pack") {
        if (behavior.failPack) throw new Error("A simulated npm failure with data that must not be printed")
        const dir = args[args.indexOf("--pack-destination") + 1]!
        if (!behavior.filename.includes("/")) fs.writeFileSync(path.join(dir, behavior.filename), bytes)
        behavior.onPack?.()
        return JSON.stringify([{ name: behavior.wrongName ? "another-package" : "opencode-quota-router", version: VERSION, filename: behavior.filename, integrity: behavior.wrongIntegrity ? "sha512-wrong" : "sha512-" + createHash("sha512").update(bytes).digest("base64") }])
      }
      assert.equal(args[0], "install", "never invokes OpenCode or another executable")
      if (behavior.failInstall) throw new Error("Simulated dependency failure")
      const prefix = args[args.indexOf("--prefix") + 1]!, folder = path.join(prefix, "node_modules", "opencode-quota-router")
      const exports = { ".": "./src/index.ts", "./engine": "./src/engine/index.ts", "./tui": "./src/tui.tsx", "./gui-experimental": "./dist/gui-experimental.cjs" }
      for (const name of [...Object.values(exports), "dist/cli.mjs"]) {
        fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true })
        fs.writeFileSync(path.join(folder, name), "// invented build\n")
      }
      fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name: behavior.wrongBuild ? "wrong" : "opencode-quota-router", version: VERSION, exports }))
      return ""
    },
  }
  return { root, file, local, env, calls, behavior, runtime, options: { package: local } }
}

test("installer: keeps JSONC comments, model, credentials, other plugins and existing options", () => {
  const installed = path.join(os.tmpdir(), "new plugin", "opencode-quota-router")
  const result = editConfig(source, installed)
  const before = plain(source), after = plain(result.text)
  assert.equal(after.plugins[1].package, installed)
  after.plugins[1].package = before.plugins[1].package
  assert.deepEqual(after, before)
  assert.ok(result.text.includes("// Keep this plugin."))
  assert.ok(result.text.includes('"url": "https://example.invalid/path/*keep*/?q=,}"'))
  assert.equal(editConfig(result.text, installed).changed, false)
})

test("installer: new, empty, inline, trailing-comma and CRLF config arrays stay valid", () => {
  for (const text of ["{}", '{"model":"a/b"}', '{"model":"a/b",}', '{"plugins":[]}', '{"plugins":["other"]}', '{"plugins":["other",]}', '{\r\n  "plugins": [\r\n    "other", // comment\r\n  ],\r\n}\r\n']) {
    const result = editConfig(text, "/example/router")
    const parsed = plain(result.text)
    assert.equal(parsed.plugins.at(-1).package, "/example/router", text)
    if (plain(text).model) assert.equal(parsed.model, plain(text).model)
    if (text.includes("\r\n")) assert.equal(result.text.replaceAll("\r\n", "").includes("\n"), false)
  }
})

test("installer: replaces a string entry or a named local installation instead of adding duplicates", () => {
  for (const ref of ["opencode-quota-router", "opencode-quota-router@0.1.0", "/example/node_modules/opencode-quota-router", "C:\\example\\node_modules\\opencode-quota-router"]) {
    const result = editConfig(JSON.stringify({ plugins: ["another", ref] }), "/new/router")
    assert.deepEqual(plain(result.text).plugins, ["another", "/new/router"])
  }
})

test("installer: rejects invalid, ambiguous, legacy and templated configurations without rewriting them", () => {
  for (const text of ['{"plugins":{}}', '{"plugins":[],"plugins":[]}', '{"plugins":["opencode-quota-router","opencode-quota-router@0.2.0"]}', '{"plugins":[{"package":"opencode-quota-router","package":"other"}]}', '{"plugin":["opencode-quota-router"]}', '{"plugins":["{env:PLUGIN}"]}', '{"plugins":[}', '{/* no end', "[]", '{"plugins": ["other" "missing-comma"]}']) {
    assert.throws(() => editConfig(text, "/new/router"), Error, text)
  }
  assert.throws(() => editConfig("x".repeat(1_048_577), "/new/router"), /1 MB/)
})

test("installer: argument parsing, help and release version agree", async () => {
  assert.equal(INSTALL_VERSION, VERSION)
  assert.deepEqual(parseInstallArgs(["--package", "release.tgz", "--dry-run", "--config", "file.jsonc", "--install-dir", "store"]), { package: "release.tgz", dryRun: true, config: "file.jsonc", installDir: "store" })
  assert.throws(() => parseInstallArgs(["--config"]), /needs a path/)
  assert.throws(() => parseInstallArgs(["--force"]), /Unknown install option/)
  const log: string[] = [], out = { log: (text: string) => log.push(text), err: (text: string) => log.push(text) }
  assert.equal(await installerMain(["--help"], out), 0)
  assert.match(log.join("\n"), /No sudo.*service restarts/)
  assert.equal(await main(["install", "--help"], out), 0)
  assert.ok(fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8").includes(`opencode-quota-router@${VERSION}`))
})

test("installer: dry run and a failed prerequisite leave config and install directories untouched", async () => {
  const f = fixture(), before = fs.readFileSync(f.file)
  const dry = await install({ ...f.options, dryRun: true }, f.runtime)
  assert.equal(dry.dryRun, true)
  assert.equal(f.calls.length, 0)
  assert.ok(before.equals(fs.readFileSync(f.file)))
  assert.equal(fs.existsSync(f.env.XDG_DATA_HOME), false)
  await assert.rejects(install(f.options, { ...f.runtime, nodeVersion: "22.1.0" }), /Node.js 24/)
  assert.equal(f.calls.length, 0)
})

test("installer: verified install is atomic, backed up privately and idempotent", async () => {
  const f = fixture(), before = fs.readFileSync(f.file)
  const first = await install(f.options, f.runtime)
  assert.equal(first.changed, true)
  assert.ok(fs.readFileSync(first.backup!).equals(before))
  assert.equal(fs.statSync(first.backup!).mode & 0o777, 0o600)
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640)
  const config = plain(fs.readFileSync(f.file, "utf8"))
  assert.equal(config.plugins[1].package, first.installed)
  assert.equal(config.plugins[1].options.enabled, false)
  assert.equal(config.model, "provider/coder")
  assert.ok(f.calls.every((args) => args.includes("--ignore-scripts")))
  assert.ok(!f.calls.flat().some((arg) => ["opencode", "sudo", "-g", "--force"].includes(arg)))
  const second = await install(f.options, f.runtime)
  assert.equal(second.changed, false)
  assert.equal(second.reused, true)
  assert.equal(second.backup, undefined)
  assert.equal(second.installed, first.installed)
  assert.equal(f.calls.filter((args) => args[0] === "install").length, 1)
})

test("installer: creates a private global JSONC config when none exists and respects existing .json", async () => {
  const f = fixture()
  fs.unlinkSync(f.file)
  const result = await install(f.options, f.runtime)
  const config = plain(fs.readFileSync(f.file, "utf8"))
  assert.equal(config.$schema, "https://opencode.ai/config.json")
  assert.equal(config.plugins[0].package, result.installed)
  assert.equal(Object.hasOwn(config, "model"), false)
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
  assert.equal(result.backup, undefined)
  const other = fixture()
  const json = other.file.replace(/\.jsonc$/, ".json")
  fs.renameSync(other.file, json)
  assert.equal((await install(other.options, other.runtime)).config, json)
  assert.equal(fs.existsSync(other.file), false)
})

test("installer: ambiguous and alternate config sources need an explicit choice", async () => {
  const f = fixture()
  fs.writeFileSync(f.file.replace(/\.jsonc$/, ".json"), "{}")
  await assert.rejects(install(f.options, f.runtime), /Both opencode/)
  assert.equal(f.calls.length, 0)
  await install({ ...f.options, config: f.file }, f.runtime)
  const other = fixture()
  const runtime = { ...other.runtime, env: { ...other.env, OPENCODE_CONFIG_CONTENT: "{}" } }
  await assert.rejects(install(other.options, runtime), /alternate OpenCode config/)
  assert.equal(other.calls.length, 0)
  await install({ ...other.options, config: other.file }, runtime)
})

test("installer: package, integrity and dependency failures never change OpenCode config", async () => {
  for (const kind of ["failPack", "failInstall", "wrongName", "wrongIntegrity", "wrongBuild"] as const) {
    const f = fixture(), before = fs.readFileSync(f.file)
    f.behavior[kind] = true
    await assert.rejects(install(f.options, f.runtime))
    assert.ok(before.equals(fs.readFileSync(f.file)), kind)
    assert.equal(fs.readdirSync(path.dirname(f.file)).filter((name) => name.endsWith(".bak")).length, 0)
  }
})

test("installer: bad package filenames cannot escape the temporary directory", async () => {
  const f = fixture()
  f.behavior.filename = "../elsewhere.tgz"
  await assert.rejects(install(f.options, f.runtime), /unexpected package/)
  assert.equal(f.calls.length, 1)
})

test("installer: concurrent config edits are kept, never overwritten", async () => {
  const f = fixture(), changed = source.replace("provider/coder", "provider/new-choice")
  f.behavior.onPack = () => fs.writeFileSync(f.file, changed)
  await assert.rejects(install(f.options, f.runtime), /changed while installing/)
  assert.equal(fs.readFileSync(f.file, "utf8"), changed)
})

test("installer: an incomplete same-hash directory is not modified or reused", async () => {
  const f = fixture()
  const base = path.join(f.root, "installed"), digest = createHash("sha256").update(Buffer.from("invented release archive")).digest("hex").slice(0, 12)
  const existing = path.join(base, `${VERSION}-${digest}`)
  fs.mkdirSync(existing, { recursive: true })
  fs.writeFileSync(path.join(existing, "keep.txt"), "existing work")
  const result = await install({ ...f.options, installDir: base }, f.runtime)
  assert.ok(!result.installed!.startsWith(path.join(existing, "node_modules")))
  assert.equal(fs.readFileSync(path.join(existing, "keep.txt"), "utf8"), "existing work")
})

test("installer: config symlinks are preserved", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), target = path.join(f.root, "dotfiles", "opencode.jsonc")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(f.file, target)
  fs.symlinkSync(target, f.file)
  const result = await install(f.options, f.runtime)
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true)
  assert.equal(plain(fs.readFileSync(target, "utf8")).plugins[1].package, result.installed)
  assert.ok(result.backup!.startsWith(fs.realpathSync(target)))
})

test("installer: Windows npm is invoked as a Node script, never through shell interpolation", () => {
  const f = fixture(), bin = path.join(f.root, "Node & tools"), npm = path.join(bin, "node_modules", "npm", "bin", "npm-cli.js")
  fs.mkdirSync(path.dirname(npm), { recursive: true })
  fs.writeFileSync(npm, "// fake npm")
  const executable = path.join(bin, "node.exe")
  assert.deepEqual(resolveNpm({}, "win32", executable), { command: executable, prefix: [npm] })
})

test("installer: local shell bootstrap syntax and help work without starting OpenCode", { skip: process.platform === "win32" }, () => {
  const file = fileURL("../install.sh")
  execFileSync("sh", ["-n", file])
  const text = execFileSync("sh", [file, "--help"], { encoding: "utf8" })
  assert.match(text, /Install quota-router 0\.2\.0/)
  assert.match(text, /No sudo.*service restarts/)
})

test("installer: piped bootstrap uses the pinned npm release with scripts disabled, not an arbitrary working-directory installer", { skip: process.platform === "win32" }, () => {
  const f = fixture(), bin = path.join(f.root, "bin"), record = path.join(f.root, "bootstrap.json")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "npx"), '#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(' + JSON.stringify(record) + ',JSON.stringify({args:process.argv.slice(2),ignore:process.env.npm_config_ignore_scripts}));\n', { mode: 0o700 })
  fs.writeFileSync(path.join(f.root, "install.mjs"), 'throw new Error("Must not execute a working-directory installer")')
  execFileSync("sh", ["-s", "--", "--dry-run"], { cwd: f.root, input: fs.readFileSync(fileURL("../install.sh")), env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } })
  assert.deepEqual(JSON.parse(fs.readFileSync(record, "utf8")), { args: ["--yes", `opencode-quota-router@${VERSION}`, "install", "--dry-run"], ignore: "true" })
})

test("installer: the built command exposes install help without installing or reading usage", () => {
  const text = execFileSync(process.execPath, [fileURL("../dist/cli.mjs"), "install", "--help"], { encoding: "utf8" })
  assert.match(text, /Install quota-router 0\.2\.0/)
  assert.match(text, /--package <file\.tgz>/)
})

function fileURL(relative: string) { return fileURLToPath(new URL(relative, import.meta.url)) }
