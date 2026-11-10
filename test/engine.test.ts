import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import * as engine from "../src/engine/index.ts"

const DIR = path.join(import.meta.dirname, "..", "src", "engine")

test("engine modules import only from the engine", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".ts"))
  assert.ok(files.length >= 10)
  for (const file of files) {
    const source = fs.readFileSync(path.join(DIR, file), "utf8")
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      assert.match(m[1], /^\.\/[\w.-]+\.ts$/, `${file} imports ${m[1]}`)
    }
    assert.doesNotMatch(source, /\bprocess\.|\bfetch\(|\brequire\(/, `${file} reaches outside the engine`)
  }
})

test("engine entry point exposes the routing API", () => {
  for (const name of ["classify", "route", "PoolStore", "loadConfig", "parseResetText", "estimate", "headroom", "suggest"]) {
    assert.equal(typeof (engine as Record<string, unknown>)[name], "function", name)
  }
})
