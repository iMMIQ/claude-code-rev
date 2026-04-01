/**
 * Message transforms for multi-provider support.
 * Ported from opencode's provider/transform.ts.
 */
import type { ModelInfo } from "./types"

// ─── Message Normalization ────────────────────────────────────

/**
 * Scrub tool call IDs to only contain safe characters (for Claude models).
 */
function scrubToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Check if the model uses Anthropic SDK (needs Anthropic-specific normalization).
 */
function isAnthropicSDK(model: ModelInfo): boolean {
  return (
    model.api.npm === "@ai-sdk/anthropic" ||
    model.api.npm === "@ai-sdk/amazon-bedrock" ||
    model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
    model.api.id.includes("claude")
  )
}

// ─── Temperature Defaults ─────────────────────────────────────

export function getTemperature(model: ModelInfo): number | undefined {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined
  if (id.includes("gemini")) return 1.0
  if (id.includes("glm")) return 1.0
  if (id.includes("minimax")) return 1.0
  if (id.includes("kimi")) {
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) return 1.0
    return 0.6
  }
  return undefined
}

export function getTopP(model: ModelInfo): number | undefined {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 1
  if (["minimax", "gemini"].some((s) => id.includes(s))) return 0.95
  return undefined
}

export function getTopK(model: ModelInfo): number | undefined {
  const id = model.id.toLowerCase()
  if (id.includes("minimax")) return 40
  if (id.includes("gemini")) return 64
  return undefined
}

// ─── Reasoning Variants ───────────────────────────────────────

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

export function getVariants(model: ModelInfo): Record<string, Record<string, unknown>> {
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  const isAnthropicAdaptive = ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) =>
    model.api.id.includes(v),
  )
  const adaptiveEfforts = ["low", "medium", "high", "max"]

  // Skip reasoning variants for these providers
  if (
    id.includes("deepseek") ||
    id.includes("minimax") ||
    id.includes("glm") ||
    id.includes("mistral") ||
    id.includes("kimi")
  )
    return {}

  switch (model.api.npm) {
    case "@ai-sdk/openai": {
      if (id === "gpt-5-pro") return {}
      return Object.fromEntries(
        OPENAI_EFFORTS.map((effort) => [
          effort,
          { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
        ]),
      )
    }
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic": {
      if (isAnthropicAdaptive) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [effort, { thinking: { type: "adaptive" }, effort }]),
        )
      }
      return {
        high: { thinking: { type: "enabled", budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)) } },
        max: { thinking: { type: "enabled", budgetTokens: Math.min(31_999, model.limit.output - 1) } },
      }
    }
    case "@ai-sdk/amazon-bedrock": {
      if (isAnthropicAdaptive) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            { reasoningConfig: { type: "adaptive", maxReasoningEffort: effort } },
          ]),
        )
      }
      if (model.api.id.includes("anthropic")) {
        return {
          high: { reasoningConfig: { type: "enabled", budgetTokens: 16000 } },
          max: { reasoningConfig: { type: "enabled", budgetTokens: 31999 } },
        }
      }
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [
          effort,
          { reasoningConfig: { type: "enabled", maxReasoningEffort: effort } },
        ]),
      )
    }
    case "@ai-sdk/google-vertex":
    case "@ai-sdk/google": {
      if (id.includes("2.5")) {
        return {
          high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
          max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } },
        }
      }
      const levels = id.includes("3.1") ? ["low", "medium", "high"] : ["low", "high"]
      return Object.fromEntries(
        levels.map((effort) => [effort, { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }]),
      )
    }
    case "@openrouter/ai-sdk-provider": {
      if (!model.id.includes("gpt") && !model.id.includes("gemini-3") && !model.id.includes("claude")) return {}
      return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoning: { effort } }]))
    }
    case "@ai-sdk/azure": {
      const efforts = ["low", "medium", "high"]
      if (id.includes("gpt-5-") || id === "gpt-5") efforts.unshift("minimal")
      return Object.fromEntries(
        efforts.map((effort) => [
          effort,
          { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
        ]),
      )
    }
    case "@ai-sdk/groq": {
      return Object.fromEntries(
        ["none", ...WIDELY_SUPPORTED_EFFORTS].map((effort) => [effort, { reasoningEffort: effort }]),
      )
    }
    case "@ai-sdk/openai-compatible": {
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]),
      )
    }
  }

  return {}
}

// ─── Provider Options ─────────────────────────────────────────

export function getProviderOptions(model: ModelInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  if (model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/github-copilot") {
    result["store"] = false
  }

  if (model.api.npm === "@openrouter/ai-sdk-provider") {
    result["usage"] = { include: true }
  }

  if (model.api.npm === "@ai-sdk/google" || model.api.npm === "@ai-sdk/google-vertex") {
    if (model.capabilities.reasoning) {
      result["thinkingConfig"] = { includeThoughts: true }
    }
  }

  return result
}

// ─── Max Output Tokens ────────────────────────────────────────

export const OUTPUT_TOKEN_MAX = 32_000

export function maxOutputTokens(model: ModelInfo): number {
  return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
}

// ─── Schema Sanitization (for Google/Gemini) ──────────────────

export function sanitizeSchema(model: ModelInfo, schema: Record<string, unknown>): Record<string, unknown> {
  if (model.providerID !== "google" && !model.api.id.includes("gemini")) return schema

  const isPlainObject = (node: unknown): node is Record<string, unknown> =>
    typeof node === "object" && node !== null && !Array.isArray(node)

  const sanitize = (obj: unknown): unknown => {
    if (obj === null || typeof obj !== "object") return obj
    if (Array.isArray(obj)) return obj.map(sanitize)

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "enum" && Array.isArray(value)) {
        result[key] = value.map((v) => String(v))
        if (result.type === "integer" || result.type === "number") {
          result.type = "string"
        }
      } else if (typeof value === "object" && value !== null) {
        result[key] = sanitize(value)
      } else {
        result[key] = value
      }
    }

    if (result.type === "object" && result.properties && Array.isArray(result.required)) {
      result.required = (result.required as unknown[]).filter((field) => field in (result.properties as Record<string, unknown>))
    }

    return result
  }

  return sanitize(schema) as Record<string, unknown>
}
