/**
 * Provider configuration loading.
 * Reuses opencode's config directory (~/.config/opencode/) and format.
 */
import path from "path"
import os from "os"
import fs from "fs"

// ─── Config Schema ────────────────────────────────────────────

export interface ProviderConfig {
  name?: string
  env?: string[]
  apiKey?: string
  npm?: string
  api?: string
  baseURL?: string
  options?: Record<string, unknown>
  models?: Record<string, ProviderModelConfig>
  whitelist?: string[]
  blacklist?: string[]
}

export interface ProviderModelConfig {
  id?: string
  name?: string
  family?: string
  status?: "alpha" | "beta" | "deprecated" | "active"
  temperature?: boolean
  reasoning?: boolean
  attachment?: boolean
  tool_call?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
  interleaved?: boolean
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
  options?: Record<string, unknown>
  headers?: Record<string, string>
  provider?: { npm?: string; api?: string }
  variants?: Record<string, Record<string, unknown>>
  release_date?: string
}

export interface MultiProviderConfig {
  model?: string
  small_model?: string
  provider?: Record<string, ProviderConfig>
  enabled_providers?: string[]
  disabled_providers?: string[]
}

// ─── Config Paths ─────────────────────────────────────────────

const CONFIG_BASENAMES = ["opencode.json", "opencode.jsonc"]

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
}

function globalConfigDir(): string {
  return path.join(xdgConfigHome(), "opencode")
}

function projectConfigFiles(cwd: string): string[] {
  const results: string[] = []
  let dir = cwd
  const root = path.parse(dir).root

  while (dir !== root) {
    for (const name of CONFIG_BASENAMES) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) results.push(p)
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return results
}

// ─── JSONC Parsing ────────────────────────────────────────────

function stripJsonComments(text: string): string {
  let result = ""
  let i = 0
  let inString = false

  while (i < text.length) {
    if (inString) {
      result += text[i]
      if (text[i] === "\\" && i + 1 < text.length) {
        result += text[i + 1]
        i += 2
        continue
      }
      if (text[i] === '"') inString = false
      i++
      continue
    }

    if (text[i] === '"') {
      inString = true
      result += text[i]
      i++
    } else if (text[i] === "/" && text[i + 1] === "/") {
      // line comment
      while (i < text.length && text[i] !== "\n") i++
    } else if (text[i] === "/" && text[i + 1] === "*") {
      // block comment
      i += 2
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
    } else {
      result += text[i]
      i++
    }
  }

  // Strip trailing commas before } or ]
  result = result.replace(/,\s*([\]}])/g, "$1")
  return result
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text))
}

// ─── Variable Substitution ────────────────────────────────────

function substituteVars(text: string, filePath?: string): string {
  // {env:VAR_NAME} → environment variable value
  text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] || "")

  // {file:path} → file content
  text = text.replace(/\{file:([^}]+)\}/g, (_, filePath_) => {
    try {
      let resolved = filePath_
      if (filePath_.startsWith("~/")) {
        resolved = path.join(os.homedir(), filePath_.slice(2))
      } else if (filePath && !path.isAbsolute(filePath_)) {
        resolved = path.resolve(path.dirname(filePath), filePath_)
      }
      return fs.readFileSync(resolved, "utf-8").trim()
    } catch {
      return ""
    }
  })

  return text
}

// ─── Config Merging ───────────────────────────────────────────

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

// ─── Config Loading ───────────────────────────────────────────

let cachedConfig: MultiProviderConfig | null = null

function readConfigFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const substituted = substituteVars(raw, filePath)
    return parseJsonc(substituted) as Record<string, unknown>
  } catch {
    return {}
  }
}

function loadConfigFromPaths(paths: string[]): Record<string, unknown> {
  let result: Record<string, unknown> = {}
  for (const p of paths) {
    const data = readConfigFile(p)
    result = deepMerge(result, data)
  }
  return result
}

export function loadConfig(cwd?: string): MultiProviderConfig {
  if (cachedConfig) return cachedConfig

  const configPaths: string[] = []

  // 1. Global config: ~/.config/opencode/
  for (const name of CONFIG_BASENAMES) {
    const p = path.join(globalConfigDir(), name)
    if (fs.existsSync(p)) configPaths.push(p)
  }

  // 2. OPENCODE_CONFIG env var
  if (process.env.OPENCODE_CONFIG) {
    const p = process.env.OPENCODE_CONFIG
    if (fs.existsSync(p)) configPaths.push(p)
  }

  // 3. Project-level config
  if (cwd) {
    configPaths.push(...projectConfigFiles(cwd))
  }

  // 4. OPENCODE_CONFIG_CONTENT env var
  let merged = loadConfigFromPaths(configPaths)

  if (process.env.OPENCODE_CONFIG_CONTENT) {
    try {
      const envConfig = parseJsonc(process.env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>
      merged = deepMerge(merged, envConfig)
    } catch {
      // ignore
    }
  }

  cachedConfig = {
    model: merged.model as string | undefined,
    small_model: merged.small_model as string | undefined,
    provider: merged.provider as Record<string, ProviderConfig> | undefined,
    enabled_providers: merged.enabled_providers as string[] | undefined,
    disabled_providers: merged.disabled_providers as string[] | undefined,
  }

  return cachedConfig!
}

/** Clear cached config (for testing or hot reload) */
export function clearConfigCache(): void {
  cachedConfig = null
}
