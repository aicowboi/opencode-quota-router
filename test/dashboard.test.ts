import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { createContext, runInContext, Script } from "node:vm"
import type { Alert } from "../src/alerts.ts"

const html = fs.readFileSync(new URL("../src/dashboard/page.html", import.meta.url), "utf8")
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!
const between = (start: string, end: string) => script.slice(script.indexOf(start), script.indexOf(end))
const notificationCode = between("// ---------- notifications ----------", "// ---------- health check ----------")
const sectionCode = between("function fold(", '$("adviceRun").onclick')
const key = "qr.hide.alerts.items"
const now = Date.now()
const alerts: Alert[] = [
  { id: 1, at: now - 3000, kind: "fallback", title: "Moved to another provider", body: "The first provider is limited." },
  { id: 2, at: now - 2000, kind: "return", title: "Back on the preferred provider" },
  { id: 3, at: now - 1000, kind: "spendCap", title: "Spending cap reached" },
]
const alertKey = (a: Alert) => `${a.id}:${a.at}`

// Exercise the page's actual inline code with only the controls it uses. Layout and real DOM behaviour are checked
// in the demo dashboard; no browser package or running OpenCode service is needed for these regression tests.
async function page(storage = new Map<string, string>(), feed = alerts, hash = "") {
  let active: Element | undefined
  class Element {
    textContent = ""
    hidden = false
    dataset: Record<string, string> = {}
    attributes = new Map<string, string>()
    classes = new Set<string>()
    classList = {
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
    }
    children = new Map<string, Element>()
    buttons: Element[] = []
    markup = ""
    onclick?: () => void
    setAttribute(name: string, value: string) { this.attributes.set(name, value) }
    focus() { active = this }
    querySelectorAll(selector: string) { return selector === "[data-hide-alert]" ? this.buttons : [] }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? this.children.get(selector) ?? null }
    get innerHTML() { return this.markup }
    set innerHTML(value: string) {
      this.markup = value
      this.buttons = [...value.matchAll(/data-hide-alert="([^"]+)"/g)].map((m) => {
        const button = new Element()
        button.dataset.hideAlert = m[1]!
        return button
      })
    }
  }
  const section = new Element(), toggle = new Element(), heading = new Element(), list = new Element(), restore = new Element()
  toggle.dataset.hide = "alerts"
  heading.textContent = "Notifications"
  section.children.set("[data-hide]", toggle)
  section.children.set("h2", heading)
  const elements: Record<string, Element> = { alerts: section, alertList: list, alertsRestore: restore }
  const messages: string[] = [], requests: string[] = [], listeners: (() => void)[] = []
  const location = { hash }
  const context = createContext({
    $: (id: string) => elements[id],
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, value: string) => storage.set(k, value),
      removeItem: (k: string) => storage.delete(k),
    },
    api: async (path: string) => { requests.push(path); return { alerts: feed } },
    fmtWhen: (at: number) => String(at),
    announce: (text: string) => messages.push(text),
    document: { querySelectorAll: () => [toggle] },
    location,
    addEventListener: (_event: string, callback: () => void) => listeners.push(callback),
  })
  runInContext(script.split("\n").find((line) => line.startsWith("const esc ="))!, context)
  const loaded = runInContext(notificationCode, context)
  runInContext(sectionCode, context)
  await loaded
  return {
    storage, section, toggle, list, restore, messages, requests,
    focused: () => active,
    visible: () => list.buttons.map((b) => b.dataset.hideAlert),
    hide: (index: number) => list.buttons[index]!.onclick!(),
    update: async (rows: Alert[] = feed) => { feed = rows; await runInContext("loadAlerts()", context) },
    hash: (value: string) => { location.hash = value; for (const callback of listeners) callback() },
  }
}

test("dashboard script compiles and Notifications has an accessible section toggle", () => {
  assert.doesNotThrow(() => new Script(script))
  assert.match(html, /data-hide="alerts" aria-controls="alertList" aria-expanded="true"/)
})

test("dashboard: hiding the whole notification section survives reloads and live updates", async () => {
  const p = await page()
  assert.equal(p.toggle.attributes.get("aria-expanded"), "true")
  p.toggle.onclick!()
  assert.equal(p.section.classList.contains("folded"), true)
  assert.equal(p.toggle.textContent, "Show")
  assert.equal(p.toggle.attributes.get("aria-expanded"), "false")
  assert.equal(p.toggle.attributes.get("aria-label"), "Show Notifications")
  assert.equal(p.storage.get("qr.hide.alerts"), "1")
  await p.update([...alerts, { ...alerts[0]!, id: 4, at: now }])
  assert.equal(p.section.classList.contains("folded"), true)
  const reloaded = await page(p.storage)
  assert.equal(reloaded.section.classList.contains("folded"), true)
  reloaded.toggle.onclick!()
  assert.equal(reloaded.section.classList.contains("folded"), false)
  assert.equal(reloaded.storage.has("qr.hide.alerts"), false)
  assert.equal(reloaded.visible().length, 3)
  reloaded.toggle.onclick!()
  reloaded.hash("#alerts")
  assert.equal(reloaded.section.classList.contains("folded"), false)
  const linked = await page(new Map([["qr.hide.alerts", "1"]]), alerts, "#alerts")
  assert.equal(linked.section.classList.contains("folded"), false)
})

test("dashboard: hide one notification, keep it hidden, and still show new notifications with the same title", async () => {
  const p = await page()
  p.hide(1)
  assert.deepEqual(p.visible(), [alertKey(alerts[2]!), alertKey(alerts[0]!)])
  assert.equal(p.restore.hidden, false)
  assert.equal(p.restore.textContent, "Restore hidden (1)")
  assert.equal(p.focused(), p.list.buttons[1])
  assert.deepEqual(JSON.parse(p.storage.get(key)!), [alertKey(alerts[1]!)])
  const next = [...alerts, { ...alerts[1]!, id: 4, at: now }]
  await p.update(next)
  assert.deepEqual(p.visible(), [alertKey(next[3]!), alertKey(alerts[2]!), alertKey(alerts[0]!)])
  const reloaded = await page(p.storage, next)
  assert.deepEqual(reloaded.visible(), p.visible())
  // Hiding a section does not undo the individual choices.
  reloaded.toggle.onclick!(); reloaded.toggle.onclick!()
  assert.deepEqual(reloaded.visible(), p.visible())
  assert.ok(p.requests.every((path) => path === "/api/notifications?limit=20"))
})

test("dashboard: hiding every notification leaves a restore action and sensible keyboard focus", async () => {
  const p = await page()
  while (p.list.buttons.length) p.hide(0)
  assert.equal(p.section.hidden, false)
  assert.match(p.list.innerHTML, /All recent notifications are hidden/)
  assert.equal(p.restore.textContent, "Restore hidden (3)")
  assert.equal(p.focused(), p.restore)
  const reloaded = await page(p.storage)
  assert.equal(reloaded.visible().length, 0)
  reloaded.restore.onclick!()
  assert.equal(reloaded.visible().length, 3)
  assert.equal(reloaded.restore.hidden, true)
  assert.equal(reloaded.focused(), reloaded.list.buttons[0])
  assert.equal(reloaded.messages.at(-1), "Hidden notifications restored.")
  assert.deepEqual(JSON.parse(reloaded.storage.get(key)!), [])
  await reloaded.update([])
  assert.equal(reloaded.section.hidden, true)
})

test("dashboard: bad or expired stored choices do not break notifications or hide a reused ID", async () => {
  for (const saved of ["{", "null", "{}", '"text"']) {
    const p = await page(new Map([[key, saved]]))
    assert.equal(p.visible().length, 3, saved)
  }
  const saved = JSON.stringify([null, 3, {}, "bad", "1:1", alertKey(alerts[1]!)])
  const p = await page(new Map([[key, saved]]))
  assert.deepEqual(p.visible(), [alertKey(alerts[2]!), alertKey(alerts[0]!)])
  await p.update([{ ...alerts[1]!, at: now }])
  assert.equal(p.visible().length, 1)
})

test("dashboard: notification titles and bodies stay escaped, including the hide button's name", async () => {
  const p = await page(new Map(), [{ ...alerts[0]!, title: 'Title <script>"&', body: '<img onerror="bad">' }])
  assert.match(p.list.innerHTML, /aria-label="Hide notification: Title &lt;script&gt;&quot;&amp;"/)
  assert.match(p.list.innerHTML, /&lt;img onerror=&quot;bad&quot;&gt;/)
  assert.doesNotMatch(p.list.innerHTML, /<script>|<img /)
})
