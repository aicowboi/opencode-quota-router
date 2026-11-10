// Health of model servers on this machine: is Ollama or LM Studio running, what is loaded, and does it fit.

export type LocalModel = {
  id: string
  loaded: boolean
  sizeBytes?: number
  /** Share of a loaded model held on the GPU, in percent. Under 100 means part of it runs on the CPU. */
  gpuPct?: number
  context?: number
  /** When an idle loaded model will be unloaded. */
  expiresAt?: number
}

export type LocalHealth = { running: boolean; models: LocalModel[]; error?: string }

export type LocalKind = "ollama" | "lmstudio"
export const LOCAL_NAMES: Record<LocalKind, string> = { ollama: "Ollama", lmstudio: "LM Studio" }

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined)
const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [])

/** Ollama: `/api/tags` lists what is installed, `/api/ps` what is in memory. */
export function interpretOllama(tags: unknown, ps: unknown): LocalModel[] {
  const out = new Map<string, LocalModel>()
  for (const m of list((tags as { models?: unknown } | null)?.models)) {
    const id = typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : undefined
    if (id) out.set(id, { id, loaded: false, sizeBytes: num(m.size) })
  }
  for (const m of list((ps as { models?: unknown } | null)?.models)) {
    const id = typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : undefined
    if (!id) continue
    const size = num(m.size)
    const vram = num(m.size_vram)
    const expires = typeof m.expires_at === "string" ? Date.parse(m.expires_at) : NaN
    out.set(id, {
      id,
      loaded: true,
      sizeBytes: size ?? out.get(id)?.sizeBytes,
      gpuPct: size && vram !== undefined ? Math.min(100, Math.round((vram / size) * 100)) : undefined,
      context: num(m.context_length),
      expiresAt: Number.isFinite(expires) ? expires : undefined,
    })
  }
  return [...out.values()]
}

/** LM Studio: `/api/v1/models` (`loaded_instances`), or the older `/api/v0/models` (`state`). Embedding models are left out. */
export function interpretLmStudio(json: unknown): LocalModel[] {
  const data = json as { models?: unknown; data?: unknown } | null
  return list(data?.models ?? data?.data).flatMap((m) => {
    const id = typeof m.key === "string" ? m.key : typeof m.id === "string" ? m.id : undefined
    if (!id || (typeof m.type === "string" && /embed/i.test(m.type))) return []
    const instances = list(m.loaded_instances)
    const config = instances[0]?.config as Record<string, unknown> | undefined
    return [{
      id,
      loaded: instances.length > 0 || m.state === "loaded",
      sizeBytes: num(m.size_bytes),
      context: num(config?.context_length) ?? num(m.loaded_context_length) ?? num(m.max_context_length),
    }]
  })
}

/** A base address for a local server: plain http or https, nothing else. */
export function localUrl(base: string, path: string): string | undefined {
  try {
    const url = new URL(base)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.username || url.password) return undefined
    return new URL(path, url).toString()
  } catch {
    return undefined
  }
}

export async function fetchLocal(kind: LocalKind, base: string, fetcher: Fetcher = fetch): Promise<LocalHealth> {
  const get = async (path: string): Promise<{ status: number; json?: unknown }> => {
    const url = localUrl(base, path)
    if (!url) throw new Error(`Not an http address: ${base}`)
    const response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(1500) })
    return { status: response.status, json: response.ok ? await response.json().catch(() => undefined) : undefined }
  }
  try {
    if (kind === "ollama") {
      const tags = await get("/api/tags")
      const ps = await get("/api/ps").catch(() => ({ status: 0, json: undefined }))
      return { running: true, models: interpretOllama(tags.json, ps.json), error: tags.json ? undefined : `HTTP ${tags.status}` }
    }
    let res = await get("/api/v1/models")
    if (!res.json) res = await get("/api/v0/models")
    return { running: true, models: interpretLmStudio(res.json), error: res.json ? undefined : `HTTP ${res.status}` }
  } catch (error) {
    // Nothing listening, or no answer in time: either way it cannot serve a request now.
    return { running: false, models: [], error: String((error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.name ?? error) }
  }
}

const GB = 1024 ** 3
const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`

/** What is worth saying about one model on this machine, if anything. */
export function localNote(m: LocalModel, totalMemBytes: number): string | undefined {
  if (m.loaded && m.gpuPct !== undefined && m.gpuPct < 100) return `${m.gpuPct}% of it is on the GPU; the rest runs on the CPU, which is slow`
  if (m.sizeBytes && totalMemBytes > 0 && m.sizeBytes > totalMemBytes * 0.9) return `${gb(m.sizeBytes)}, more than this machine's ${gb(totalMemBytes)} of memory can hold`
  return undefined
}
