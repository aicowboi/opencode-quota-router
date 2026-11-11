import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { inspectDefault, parseConfigDocument } from "../src/default-model.ts"

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qr-default-")), directory = path.join(root, "project", "sub")
  fs.mkdirSync(directory, { recursive: true })
  const options = { home: path.join(root, "home"), env: { XDG_CONFIG_HOME: path.join(root, "global") }, platform: "linux" as const, system: path.join(root, "system") }
  const write = (file: string, value: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
  return { root, directory, options, write, inspect: () => inspectDefault(directory, options) }
}

test("configured default: JSONC comments and trailing commas preserve quoted content", () => {
  const doc = parseConfigDocument('{ // comment\n "model":"provider/org/model", /* comment */ "url":"https://example.test/*keep*/?q=,}", "escaped":"a\\\"//b", "list":[1,], }')
  assert.equal(doc.model, "provider/org/model")
  assert.equal(doc.url, "https://example.test/*keep*/?q=,}")
  assert.equal(doc.escaped, 'a"//b')
  assert.deepEqual(doc.list, [1])
  assert.throws(() => parseConfigDocument('{ /* unclosed'), /Unclosed/)
})

test("configured default: global, ancestor, .opencode and system precedence", () => {
  const f = fixture()
  assert.deepEqual(f.inspect(), { known: true, model: undefined })
  f.write(path.join(f.options.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), '{"model":"subscription/coder",}')
  assert.deepEqual(f.inspect().model, { providerID: "subscription", modelID: "coder" })
  f.write(path.join(f.directory, "opencode.json"), '{"model":"nearest/coder"}')
  assert.equal(f.inspect().model?.providerID, "nearest")
  f.write(path.join(f.root, "project", ".opencode", "opencode.jsonc"), '{"model":{"providerID":"project","model":"org/coder"}}')
  assert.deepEqual(f.inspect().model, { providerID: "project", modelID: "org/coder" })
  f.write(path.join(f.options.system, "opencode.json"), '{"model":"managed/coder"}')
  assert.equal(f.inspect().model?.providerID, "managed")
})

test("configured default: uncertain documents and alternate sources fail closed", () => {
  const f = fixture(), global = path.join(f.options.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc")
  f.write(global, '{"model":"{env:DEFAULT_MODEL}"}')
  assert.equal(f.inspect().known, false)
  f.write(global, '{ broken')
  assert.equal(f.inspect().known, false)
  f.write(global, '{"model":"subscription/coder"}')
  f.write(path.join(f.directory, "opencode.json"), '{"other":true}')
  f.write(path.join(f.directory, "opencode.jsonc"), '{"other":false}')
  assert.equal(f.inspect().known, false)
  const empty = fixture()
  assert.equal(inspectDefault(empty.directory, { ...empty.options, env: { ...empty.options.env, OPENCODE_CONFIG_CONTENT: "{}" } }).known, false)
})
