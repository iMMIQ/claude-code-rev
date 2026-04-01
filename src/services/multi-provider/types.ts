/**
 * Multi-provider type definitions.
 * Ported from opencode's provider/schema.ts, simplified (no Effect dependency).
 */

// ─── Provider ID ──────────────────────────────────────────────

/** Branded string for provider IDs (e.g. "anthropic", "openai") */
export type ProviderID = string & { readonly __brand: "ProviderID" }

export const ProviderID = {
  make: (id: string): ProviderID => id as ProviderID,
  // Well-known providers
  anthropic: "anthropic" as ProviderID,
  openai: "openai" as ProviderID,
  google: "google" as ProviderID,
  googleVertex: "google-vertex" as ProviderID,
  githubCopilot: "github-copilot" as ProviderID,
  amazonBedrock: "amazon-bedrock" as ProviderID,
  azure: "azure" as ProviderID,
  openrouter: "openrouter" as ProviderID,
  mistral: "mistral" as ProviderID,
  xai: "xai" as ProviderID,
  groq: "groq" as ProviderID,
  deepinfra: "deepinfra" as ProviderID,
}

// ─── Model ID ─────────────────────────────────────────────────

export type ModelID = string & { readonly __brand: "ModelID" }

export const ModelID = {
  make: (id: string): ModelID => id as ModelID,
}

// ─── Model Info ───────────────────────────────────────────────

export interface ModelInfo {
  id: ModelID
  providerID: ProviderID
  api: {
    id: string
    url: string
    npm: string
  }
  name: string
  family?: string
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    output: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    interleaved: boolean | { field: "reasoning_content" | "reasoning_details" }
  }
  cost: {
    input: number
    output: number
    cache: { read: number; write: number }
    experimentalOver200K?: {
      input: number
      output: number
      cache: { read: number; write: number }
    }
  }
  limit: {
    context: number
    input?: number
    output: number
  }
  status: "alpha" | "beta" | "deprecated" | "active"
  options: Record<string, unknown>
  headers: Record<string, string>
  release_date: string
  variants?: Record<string, Record<string, unknown>>
}

// ─── Provider Info ────────────────────────────────────────────

export type ProviderSource = "env" | "config" | "custom" | "api"

export interface ProviderInfo {
  id: ProviderID
  name: string
  source: ProviderSource
  env: string[]
  key?: string
  options: Record<string, unknown>
  models: Record<string, ModelInfo>
}

// ─── Helpers ──────────────────────────────────────────────────

export interface ResolvedModel {
  providerID: ProviderID
  modelID: ModelID
}

/** Parse "providerID/modelID" format (e.g. "openai/gpt-5", "anthropic/claude-sonnet-4-6") */
export function parseModel(model: string): ResolvedModel {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderID.make(providerID),
    modelID: ModelID.make(rest.join("/")),
  }
}

/** Check if a provider ID refers to an Anthropic-hosted provider */
export function isAnthropicProviderID(providerID: string): boolean {
  return ["anthropic", "amazon-bedrock", "google-vertex", "azure"].includes(
    providerID,
  )
}
