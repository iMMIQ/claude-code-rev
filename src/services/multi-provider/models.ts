/**
 * Model catalog from models.dev.
 * Ported from opencode's provider/models.ts.
 */
import path from "path"
import os from "os"
import fs from "fs"
import z from "zod"

// ─── Zod Schemas ──────────────────────────────────────────────

export const ModelsDevModel = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  temperature: z.boolean(),
  tool_call: z.boolean(),
  interleaved: z
    .union([
      z.literal(true),
      z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict(),
    ])
    .optional(),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
      context_over_200k: z
        .object({
          input: z.number(),
          output: z.number(),
          cache_read: z.number().optional(),
          cache_write: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  limit: z.object({
    context: z.number(),
    input: z.number().optional(),
    output: z.number(),
  }),
  modalities: z
    .object({
      input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
    })
    .optional(),
  experimental: z.boolean().optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  options: z.record(z.string(), z.any()),
  headers: z.record(z.string(), z.string()).optional(),
  provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
  variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
})
export type ModelsDevModel = z.infer<typeof ModelsDevModel>

export const ModelsDevProvider = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), ModelsDevModel),
})
export type ModelsDevProvider = z.infer<typeof ModelsDevProvider>

// ─── Cache & Fetch ────────────────────────────────────────────

const cacheDir = path.join(os.homedir(), ".cache", "claude-code-rev")
const cacheFile = path.join(cacheDir, "models.json")
let cachedData: Record<string, ModelsDevProvider> | null = null
let fetchPromise: Promise<Record<string, ModelsDevProvider>> | null = null

async function readCache(): Promise<Record<string, ModelsDevProvider> | undefined> {
  try {
    const raw = await fs.promises.readFile(cacheFile, "utf-8")
    return JSON.parse(raw) as Record<string, ModelsDevProvider>
  } catch {
    return undefined
  }
}

async function writeCache(data: string): Promise<void> {
  try {
    await fs.promises.mkdir(cacheDir, { recursive: true })
    await fs.promises.writeFile(cacheFile, data, "utf-8")
  } catch {
    // ignore cache write failures
  }
}

function parseModelsDevData(raw: unknown): Record<string, ModelsDevProvider> {
  if (!raw || typeof raw !== "object") return {}
  const result: Record<string, ModelsDevProvider> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = ModelsDevProvider.safeParse(value)
    if (parsed.success) {
      result[key] = parsed.data
    }
  }
  return result
}

async function fetchModels(): Promise<Record<string, ModelsDevProvider>> {
  if (cachedData) return cachedData

  if (fetchPromise) return fetchPromise

  fetchPromise = (async () => {
    // Try cache first
    const cached = await readCache()
    if (cached && Object.keys(cached).length > 0) {
      cachedData = cached
      // Refresh in background
      void refreshInBackground()
      return cached
    }

    // Fetch from models.dev
    try {
      const res = await fetch("https://models.dev/api.json", {
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const text = await res.text()
        const data = parseModelsDevData(JSON.parse(text))
        cachedData = data
        void writeCache(text)
        return data
      }
    } catch {
      // fall through
    }

    cachedData = {}
    return cachedData
  })()

  try {
    return await fetchPromise
  } finally {
    fetchPromise = null
  }
}

async function refreshInBackground(): Promise<void> {
  try {
    const res = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const text = await res.text()
      const data = parseModelsDevData(JSON.parse(text))
      cachedData = data
      void writeCache(text)
    }
  } catch {
    // ignore background refresh failures
  }
}

// ─── Public API ───────────────────────────────────────────────

/** Get all providers from models.dev catalog */
export async function getModels(): Promise<Record<string, ModelsDevProvider>> {
  return fetchModels()
}

/** Force refresh the model catalog */
export async function refreshModels(): Promise<void> {
  cachedData = null
  await fetchModels()
}
