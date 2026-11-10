// Contract with the OpenCode plugin API. The type checks below compile only while the pinned @opencode/plugin still
// hands the plugin what its handlers expect, so `npm run typecheck` fails when an OpenCode update changes a hook, an
// event or a context method the plugin uses. The runtime tests check the event names and the pinned versions.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OpenCodeEvent } from "@opencode/client"
import type { SessionHttpResponse, SessionPrompt, SessionRetry } from "@opencode/plugin/promise/session"
import type { Core } from "../src/core.ts"
import type { onCodexResponse, onHttpResponse, onPrompt, onRetry } from "../src/controller.ts"

type Ctx = Plugin.Context
type Event<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>
type Data<T extends OpenCodeEvent["type"]> = NonNullable<Event<T>["data"]>
/** Compiles only when `A` can be passed where `B` is expected. */
type Fits<A, B> = [A] extends [B] ? true : false
const ok = <T extends true>() => true as T

// Hook inputs fit the handlers they are passed to.
ok<Fits<SessionRetry, Parameters<typeof onRetry>[1]>>()
ok<Fits<SessionPrompt, Parameters<typeof onPrompt>[1]>>()
ok<Fits<SessionHttpResponse, Parameters<typeof onHttpResponse>[1]>>()
ok<Fits<SessionHttpResponse, Parameters<typeof onCodexResponse>[1]>>()
ok<Fits<"retry" | "prompt" | "http.response", Parameters<Ctx["session"]["hook"]>[0]>>()

// Context methods are there, and take what the plugin passes.
ok<Fits<{ sessionID: string; model: { providerID: string; id: string; variant: string } }, Parameters<Ctx["session"]["switchModel"]>[0]>>()
ok<Fits<{ sessionID: string; text: string; description: string; metadata: { quotaRouter: boolean }; resume: boolean }, Parameters<Ctx["session"]["synthetic"]>[0]>>()
ok<Fits<{ sessionID: string }, Parameters<Ctx["session"]["get"]>[0]>>()
ok<Fits<string, Parameters<Ctx["integration"]["connection"]["active"]>[0]>>()
ok<Fits<NonNullable<Awaited<ReturnType<Ctx["integration"]["connection"]["active"]>>>, Parameters<Ctx["integration"]["connection"]["resolve"]>[0]>>()
ok<Fits<{ signal: AbortSignal }, Parameters<Ctx["event"]["subscribe"]>[0]>>()
ok<Fits<Ctx["model"]["list"], () => Promise<unknown>>>()
ok<Fits<Ctx["command"]["transform"], (...args: any[]) => unknown>>()
ok<Fits<Ctx["location"]["directory"], string | undefined>>()

// Event fields the recorder and the controller read.
ok<Fits<"agent" | "parentID" | "model" | "location", keyof Data<"session.created">>>()
ok<Fits<"agent", keyof Data<"session.agent.selected">>>()
ok<Fits<"model", keyof Data<"session.model.selected">>>()
ok<Fits<"sessionID", keyof Data<"session.step.started">>>()
ok<Fits<"error", keyof Data<"session.step.failed">>>()
ok<Fits<"tokens" | "cost", keyof Data<"session.step.ended">>>()
ok<Fits<"tokens" | "cost", keyof Data<"session.usage.updated">>>()

void ({} as Core)

const root = path.join(import.meta.dirname, "..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")

/** Every event name the API defines, read from the pinned schema package. */
function apiEvents(): Set<string> {
  const text = read("node_modules/@opencode/schema/dist/event-manifest.d.ts") + read("node_modules/@opencode/schema/dist/session-event.d.ts")
  return new Set([...text.matchAll(/"([a-z]+(?:\.[a-z]+)+)"/g)].map((m) => m[1]))
}

test("contract: every event the plugin listens for is one the pinned OpenCode API sends", () => {
  const api = apiEvents()
  const files = ["src/index.ts", "src/controller.ts", "src/recorder.ts", "src/core.ts"]
  const used = new Set<string>()
  for (const f of files) for (const m of read(f).matchAll(/"((?:session|credential|integration|model|provider)\.[a-z]+(?:\.[a-z]+)*)"/g)) used.add(m[1])
  // Hook names share the dotted shape but are not events.
  used.delete("http.response")
  assert.ok(used.size >= 20, `found ${used.size} event names`)
  const missing = [...used].filter((e) => !api.has(e))
  assert.deepEqual(missing, [], `not in the pinned API: ${missing.join(", ")}`)
})

test("contract: the versions the support matrix names are the ones pinned and tested", () => {
  const pkg = JSON.parse(read("package.json"))
  const plugin = JSON.parse(read("node_modules/@opencode/plugin/package.json")).version
  assert.equal(pkg.devDependencies["@opencode/plugin"], plugin, "@opencode/plugin is pinned to an exact version")
  const matrix = read("docs/support.md")
  assert.match(matrix, new RegExp(`@opencode/plugin\\D+${plugin.replaceAll(".", "\\.")}`), "docs/support.md names the pinned plugin API")
  assert.match(matrix, new RegExp(`Node\\D+${pkg.engines.node.replace(/\D/g, "")}`), "docs/support.md names the Node version")
})
