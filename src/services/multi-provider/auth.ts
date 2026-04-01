/**
 * Auth credential store — reads opencode's auth.json.
 *
 * File: ~/.local/share/opencode/auth.json
 * Format: { [providerID]: { type: "api", key: "..." } | { type: "oauth", ... } | ... }
 * Permissions: 0600
 *
 * Ported from opencode's auth/index.ts (Effect → plain async).
 */
import path from "path"
import os from "os"
import fs from "fs"

// ─── Types ────────────────────────────────────────────────────

export interface ApiAuth {
  type: "api"
  key: string
}

export interface OAuthAuth {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export interface WellKnownAuth {
  type: "wellknown"
  key: string
  token: string
}

export type AuthInfo = ApiAuth | OAuthAuth | WellKnownAuth

// ─── Type guards ──────────────────────────────────────────────

export function isApiAuth(info: AuthInfo): info is ApiAuth {
  return info.type === "api"
}

export function isOAuthAuth(info: AuthInfo): info is OAuthAuth {
  return info.type === "oauth"
}

export function isWellKnownAuth(info: AuthInfo): info is WellKnownAuth {
  return info.type === "wellknown"
}

/** Extract the usable token/key string from any auth type */
export function getAuthKey(info: AuthInfo): string | undefined {
  if (info.type === "api") return info.key
  if (info.type === "oauth") return info.access
  if (info.type === "wellknown") return info.token
  return undefined
}

// ─── Path ─────────────────────────────────────────────────────

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
}

function authFilePath(): string {
  return path.join(xdgDataHome(), "opencode", "auth.json")
}

// ─── Read / Write ─────────────────────────────────────────────

let cache: Record<string, AuthInfo> | null = null

function parseAuthEntry(value: unknown): AuthInfo | undefined {
  if (!value || typeof value !== "object") return undefined
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (type === "api" && typeof obj.key === "string") return { type: "api", key: obj.key }
  if (type === "oauth" && typeof obj.refresh === "string" && typeof obj.access === "string" && typeof obj.expires === "number") {
    return { type: "oauth", refresh: obj.refresh, access: obj.access, expires: obj.expires, accountId: obj.accountId as string | undefined, enterpriseUrl: obj.enterpriseUrl as string | undefined }
  }
  if (type === "wellknown" && typeof obj.key === "string" && typeof obj.token === "string") return { type: "wellknown", key: obj.key, token: obj.token }
  return undefined
}

export async function readAuth(): Promise<Record<string, AuthInfo>> {
  if (cache) return cache

  const filePath = authFilePath()
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8")
    const data = JSON.parse(raw) as Record<string, unknown>
    const result: Record<string, AuthInfo> = {}
    for (const [key, value] of Object.entries(data)) {
      const parsed = parseAuthEntry(value)
      if (parsed) result[key] = parsed
    }
    cache = result
    return result
  } catch {
    cache = {}
    return {}
  }
}

export async function writeAuth(data: Record<string, AuthInfo>): Promise<void> {
  const filePath = authFilePath()
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  cache = data
}

// ─── Public API (same interface as opencode) ──────────────────

/** Get auth credentials for a provider */
export async function get(providerID: string): Promise<AuthInfo | undefined> {
  const all = await readAuth()
  return all[providerID]
}

/** Get all auth credentials */
export async function all(): Promise<Record<string, AuthInfo>> {
  return readAuth()
}

/** Set auth credentials for a provider */
export async function set(key: string, info: AuthInfo): Promise<void> {
  const data = await readAuth()
  const norm = key.replace(/\/+$/, "")
  delete data[key]
  delete data[norm + "/"]
  data[norm] = info
  await writeAuth(data)
}

/** Remove auth credentials for a provider */
export async function remove(key: string): Promise<void> {
  const data = await readAuth()
  const norm = key.replace(/\/+$/, "")
  delete data[key]
  delete data[norm]
  await writeAuth(data)
}

/** Get the API key for a provider (from auth store or env vars) */
export async function getApiKey(providerID: string, envVars: string[]): Promise<string | undefined> {
  // 1. Check auth store first
  const auth = await get(providerID)
  if (auth) {
    if (auth.type === "api") return auth.key
    if (auth.type === "oauth") return auth.access
    if (auth.type === "wellknown") return auth.token
  }
  // 2. Fall back to env vars
  for (const envVar of envVars) {
    const value = process.env[envVar]
    if (value) return value
  }
  return undefined
}

/** Clear cached auth data */
export function clearCache(): void {
  cache = null
}
