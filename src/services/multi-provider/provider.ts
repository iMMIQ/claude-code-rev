/**
 * Provider registry — SDK resolution and model management.
 * Ported from opencode's provider/provider.ts, simplified (no Effect).
 */
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAzure } from "@ai-sdk/azure"
import { type ModelInfo, type ProviderInfo, type ProviderID, type ModelID, ProviderID as PID, ModelID as MID, parseModel, isAnthropicProviderID } from "./types"
import { getModels, type ModelsDevProvider } from "./models"
import { loadConfig } from "./config"
import * as Auth from "./auth"

// ─── Bundled SDK map ──────────────────────────────────────────

type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3
}

const BUNDLED_PROVIDERS: Record<string, (options: Record<string, unknown>) => BundledSDK> = {
  "@ai-sdk/amazon-bedrock": (opts) => createAmazonBedrock(opts as AmazonBedrockProviderSettings) as unknown as BundledSDK,
  "@ai-sdk/anthropic": (opts) => createAnthropic(opts as any) as unknown as BundledSDK,
  "@ai-sdk/azure": (opts) => createAzure(opts as any) as unknown as BundledSDK,
  "@ai-sdk/google": (opts) => createGoogleGenerativeAI(opts as any) as unknown as BundledSDK,
  "@ai-sdk/openai": (opts) => createOpenAI(opts as any) as unknown as BundledSDK,
  "@ai-sdk/openai-compatible": (opts) => createOpenAICompatible(opts as any) as unknown as BundledSDK,
  "@openrouter/ai-sdk-provider": (opts) => createOpenRouter(opts as any) as unknown as BundledSDK,
  "@ai-sdk/xai": (opts) => createXai(opts as any) as unknown as BundledSDK,
  "@ai-sdk/mistral": (opts) => createMistral(opts as any) as unknown as BundledSDK,
  "@ai-sdk/groq": (opts) => createGroq(opts as any) as unknown as BundledSDK,
  "@ai-sdk/deepinfra": (opts) => createDeepInfra(opts as any) as unknown as BundledSDK,
  "@ai-sdk/cerebras": (opts) => createCerebras(opts as any) as unknown as BundledSDK,
  "@ai-sdk/cohere": (opts) => createCohere(opts as any) as unknown as BundledSDK,
  "@ai-sdk/gateway": (opts) => {
    const { createGateway } = require("@ai-sdk/gateway")
    return createGateway(opts as any) as unknown as BundledSDK
  },
  "@ai-sdk/togetherai": (opts) => createTogetherAI(opts as any) as unknown as BundledSDK,
  "@ai-sdk/perplexity": (opts) => createPerplexity(opts as any) as unknown as BundledSDK,
  "@ai-sdk/vercel": (opts) => createVercel(opts as any) as unknown as BundledSDK,
}

// ─── Custom Loaders ───────────────────────────────────────────

type CustomModelLoader = (sdk: BundledSDK, modelID: string, options?: Record<string, unknown>) => Promise<LanguageModelV3> | LanguageModelV3

interface CustomLoaderResult {
  autoload: boolean
  getModel?: CustomModelLoader
  options?: Record<string, unknown>
}

type CustomLoader = (provider: ProviderInfo) => Promise<CustomLoaderResult>

const CUSTOM_LOADERS: Record<string, CustomLoader> = {
  async anthropic() {
    return {
      autoload: false,
      options: {
        headers: {
          "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        },
      },
    }
  },

  async openai() {
    return {
      autoload: false,
      getModel(sdk: BundledSDK, modelID: string) {
        // Use responses API for OpenAI
        return (sdk as any).responses(modelID)
      },
      options: {},
    }
  },

  async xai() {
    return {
      autoload: false,
      getModel(sdk: BundledSDK, modelID: string) {
        return (sdk as any).responses(modelID)
      },
      options: {},
    }
  },

  async openrouter() {
    return {
      autoload: false,
      options: {
        headers: {
          "HTTP-Referer": "https://claude-code.dev/",
          "X-Title": "claude-code",
        },
      },
    }
  },

  async cerebras() {
    return {
      autoload: false,
      options: {
        headers: {
          "X-Cerebras-3rd-Party-Integration": "claude-code",
        },
      },
    }
  },
}

// ─── Provider State ───────────────────────────────────────────

interface ProviderState {
  providers: Record<string, ProviderInfo>
  sdkCache: Map<string, BundledSDK>
  modelCache: Map<string, LanguageModelV3>
  modelLoaders: Record<string, CustomModelLoader>
}

let statePromise: Promise<ProviderState> | null = null

async function initState(): Promise<ProviderState> {
  const modelsDev = await getModels()
  const config = loadConfig(process.cwd())

  const disabled = new Set(config.disabled_providers ?? [])
  const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

  function isAllowed(id: string): boolean {
    if (enabled && !enabled.has(id)) return false
    if (disabled.has(id)) return false
    return true
  }

  // Build initial provider list from models.dev
  const providers: Record<string, ProviderInfo> = {}
  for (const [id, prov] of Object.entries(modelsDev)) {
    if (!isAllowed(id)) continue
    providers[id] = fromModelsDevProvider(prov)
  }

  // Merge config providers
  if (config.provider) {
    for (const [id, provConfig] of Object.entries(config.provider)) {
      if (!isAllowed(id)) continue
      if (providers[id]) {
        // Merge options and models
        if (provConfig.options) {
          providers[id].options = { ...providers[id].options, ...provConfig.options }
        }
        if (provConfig.models) {
          for (const [modelId, modelConfig] of Object.entries(provConfig.models)) {
            providers[id].models[modelId] = fromProviderModelConfig(id, modelId, modelConfig, providers[id].models[modelId])
          }
        }
        if (provConfig.apiKey) {
          providers[id].key = provConfig.apiKey
          providers[id].source = "config"
        }
        if (provConfig.baseURL) {
          providers[id].options = { ...providers[id].options, baseURL: provConfig.baseURL }
        }
      } else {
        // New custom provider
        providers[id] = {
          id: PID.make(id),
          name: provConfig.name || id,
          source: "config",
          env: provConfig.env || [],
          key: provConfig.apiKey,
          options: { ...(provConfig.options || {}), ...(provConfig.baseURL ? { baseURL: provConfig.baseURL } : {}) },
          models: {},
        }
        if (provConfig.models) {
          for (const [modelId, modelConfig] of Object.entries(provConfig.models)) {
            providers[id].models[modelId] = fromProviderModelConfig(id, modelId, modelConfig)
          }
        }
      }
    }
  }

  // Detect providers with API keys from env vars
  for (const [id, provider] of Object.entries(providers)) {
    const apiKey = provider.env.map((e) => process.env[e]).find(Boolean)
    if (apiKey && provider.source !== "config") {
      provider.source = "env"
      provider.key = apiKey
    }
  }

  // Detect providers with credentials from opencode auth store (~/.local/share/opencode/auth.json)
  const authStore = await Auth.all()
  for (const [authId, authInfo] of Object.entries(authStore)) {
    if (!isAllowed(authId)) continue
    const key = Auth.isApiAuth(authInfo) ? authInfo.key
      : Auth.isOAuthAuth(authInfo) ? authInfo.access
      : (authInfo as any).token

    if (providers[authId]) {
      // Existing provider — set key from auth store if not already set
      if (!providers[authId].key) {
        providers[authId].source = "api"
        providers[authId].key = key
      }
    } else {
      // New provider from auth store (e.g. "zhipuai-coding-plan")
      providers[authId] = {
        id: PID.make(authId),
        name: authId,
        source: "api",
        env: [],
        key,
        options: {},
        models: {},
      }
    }
  }

  // Run custom loaders
  const modelLoaders: Record<string, CustomModelLoader> = {}
  for (const [id, loader] of Object.entries(CUSTOM_LOADERS)) {
    if (!providers[id]) continue
    const result = await loader(providers[id])
    if (result && (result.autoload || providers[id].key)) {
      if (result.getModel) modelLoaders[id] = result.getModel
      if (result.options) {
        providers[id].options = { ...providers[id].options, ...result.options }
      }
    }
  }

  // Remove providers with no credentials (except those explicitly configured)
  for (const id of Object.keys(providers)) {
    const p = providers[id]
    const hasKey = !!p.key || p.env.some((e) => process.env[e])

    // Config providers are explicitly configured — always keep them
    if (p.source !== "config" && !hasKey) {
      delete providers[id]
      continue
    }

    // Filter out alpha/deprecated models
    for (const modelId of Object.keys(p.models)) {
      if (p.models[modelId].status === "alpha" || p.models[modelId].status === "deprecated") {
        delete p.models[modelId]
      }
    }

    // Remove providers that ended up with zero models after filtering
    if (Object.keys(p.models).length === 0 && !hasKey) {
      delete providers[id]
    }
  }

  return {
    providers,
    sdkCache: new Map(),
    modelCache: new Map(),
    modelLoaders,
  }
}

async function getState(): Promise<ProviderState> {
  if (!statePromise) statePromise = initState()
  return statePromise
}

// ─── ModelsDev Conversion ─────────────────────────────────────

function fromModelsDevProvider(prov: ModelsDevProvider): ProviderInfo {
  const models: Record<string, ModelInfo> = {}
  for (const [modelId, model] of Object.entries(prov.models)) {
    models[modelId] = fromModelsDevModel(prov, model)
  }
  return {
    id: PID.make(prov.id),
    name: prov.name,
    source: "custom",
    env: prov.env || [],
    options: {},
    models,
  }
}

function fromModelsDevModel(
  prov: ModelsDevProvider,
  model: { id: string; name: string; family?: string; release_date: string; attachment: boolean; reasoning: boolean; temperature: boolean; tool_call: boolean; limit: { context: number; input?: number; output: number }; modalities?: { input?: string[]; output?: string[] }; cost?: { input: number; output: number; cache_read?: number; cache_write?: number }; interleaved?: boolean; status?: string; options?: Record<string, unknown>; headers?: Record<string, string>; provider?: { npm?: string; api?: string } },
): ModelInfo {
  return {
    id: MID.make(model.id),
    providerID: PID.make(prov.id),
    name: model.name,
    family: model.family,
    api: {
      id: model.id,
      url: model.provider?.api ?? prov.api ?? "",
      npm: model.provider?.npm ?? prov.npm ?? "@ai-sdk/openai-compatible",
    },
    capabilities: {
      temperature: model.temperature,
      reasoning: model.reasoning,
      attachment: model.attachment,
      toolcall: model.tool_call,
      input: {
        text: model.modalities?.input?.includes("text") ?? false,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? false,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
      },
      interleaved: model.interleaved ?? false,
    },
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cache: {
        read: model.cost?.cache_read ?? 0,
        write: model.cost?.cache_write ?? 0,
      },
    },
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    status: (model.status as ModelInfo["status"]) || "active",
    options: model.options ?? {},
    headers: model.headers ?? {},
    release_date: model.release_date,
  }
}

function fromProviderModelConfig(
  providerID: string,
  modelId: string,
  config: {
    id?: string; name?: string; family?: string; status?: string; temperature?: boolean; reasoning?: boolean; attachment?: boolean; tool_call?: boolean; modalities?: { input?: string[]; output?: string[] }; interleaved?: boolean; cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }; limit?: { context?: number; input?: number; output?: number }; options?: Record<string, unknown>; headers?: Record<string, string>; provider?: { npm?: string; api?: string }; release_date?: string
  },
  existing?: ModelInfo,
): ModelInfo {
  return {
    id: MID.make(modelId),
    providerID: PID.make(providerID),
    name: config.name ?? existing?.name ?? modelId,
    family: config.family ?? existing?.family,
    api: {
      id: config.id ?? existing?.api.id ?? modelId,
      url: config.provider?.api ?? existing?.api.url ?? "",
      npm: config.provider?.npm ?? existing?.api.npm ?? "@ai-sdk/openai-compatible",
    },
    capabilities: {
      temperature: config.temperature ?? existing?.capabilities.temperature ?? false,
      reasoning: config.reasoning ?? existing?.capabilities.reasoning ?? false,
      attachment: config.attachment ?? existing?.capabilities.attachment ?? false,
      toolcall: config.tool_call ?? existing?.capabilities.toolcall ?? true,
      input: {
        text: config.modalities?.input?.includes("text") ?? existing?.capabilities.input.text ?? true,
        audio: config.modalities?.input?.includes("audio") ?? existing?.capabilities.input.audio ?? false,
        image: config.modalities?.input?.includes("image") ?? existing?.capabilities.input.image ?? false,
        video: config.modalities?.input?.includes("video") ?? existing?.capabilities.input.video ?? false,
        pdf: config.modalities?.input?.includes("pdf") ?? existing?.capabilities.input.pdf ?? false,
      },
      output: {
        text: config.modalities?.output?.includes("text") ?? existing?.capabilities.output.text ?? true,
        audio: config.modalities?.output?.includes("audio") ?? existing?.capabilities.output.audio ?? false,
        image: config.modalities?.output?.includes("image") ?? existing?.capabilities.output.image ?? false,
        video: config.modalities?.output?.includes("video") ?? existing?.capabilities.output.video ?? false,
        pdf: config.modalities?.output?.includes("pdf") ?? existing?.capabilities.output.pdf ?? false,
      },
      interleaved: config.interleaved ?? existing?.capabilities.interleaved ?? false,
    },
    cost: {
      input: config.cost?.input ?? existing?.cost.input ?? 0,
      output: config.cost?.output ?? existing?.cost.output ?? 0,
      cache: {
        read: config.cost?.cache_read ?? existing?.cost.cache.read ?? 0,
        write: config.cost?.cache_write ?? existing?.cost.cache.write ?? 0,
      },
    },
    limit: {
      context: config.limit?.context ?? existing?.limit.context ?? 128000,
      input: config.limit?.input ?? existing?.limit.input,
      output: config.limit?.output ?? existing?.limit.output ?? 4096,
    },
    status: (config.status as ModelInfo["status"]) ?? existing?.status ?? "active",
    options: { ...(existing?.options ?? {}), ...(config.options ?? {}) },
    headers: { ...(existing?.headers ?? {}), ...(config.headers ?? {}) },
    release_date: config.release_date ?? existing?.release_date ?? "",
  }
}

// ─── SDK Resolution ───────────────────────────────────────────

async function resolveSDKFromState(model: ModelInfo, state: ProviderState): Promise<BundledSDK> {
  const provider = state.providers[model.providerID]
  if (!provider) throw new Error(`Provider not found: ${model.providerID}`)

  const options: Record<string, unknown> = { ...provider.options }

  // Set baseURL from model or provider
  if (!options.baseURL && model.api.url) {
    options.baseURL = model.api.url
  }

  // Set API key
  if (!options.apiKey && provider.key) {
    options.apiKey = provider.key
  }

  // Merge model headers
  if (model.headers) {
    options.headers = { ...(options.headers as Record<string, string>), ...model.headers }
  }

  // Cache key
  const cacheKey = `${model.providerID}:${model.api.npm}:${JSON.stringify(options)}`
  const existing = state.sdkCache.get(cacheKey)
  if (existing) return existing

  const factory = BUNDLED_PROVIDERS[model.api.npm]
  if (!factory) {
    throw new Error(`No bundled provider for npm package: ${model.api.npm}. Provider: ${model.providerID}`)
  }

  const sdk = factory({ name: model.providerID, ...options })
  state.sdkCache.set(cacheKey, sdk)
  return sdk
}

// ─── Public API ───────────────────────────────────────────────

/** List all available providers */
export async function listProviders(): Promise<Record<string, ProviderInfo>> {
  const state = await getState()
  return state.providers
}

/** Get a specific provider */
export async function getProvider(providerID: string): Promise<ProviderInfo | undefined> {
  const state = await getState()
  return state.providers[providerID]
}

/** Get a specific model */
export async function getModel(providerID: string, modelID: string): Promise<ModelInfo | undefined> {
  const state = await getState()
  return state.providers[providerID]?.models[modelID]
}

/** Resolve a LanguageModelV3 for the given model */
export async function getLanguageModel(model: ModelInfo): Promise<LanguageModelV3> {
  const state = await getState()
  const cacheKey = `${model.providerID}/${model.id}`

  const cached = state.modelCache.get(cacheKey)
  if (cached) return cached

  const sdk = await resolveSDKFromState(model, state)

  let language: LanguageModelV3
  const customLoader = state.modelLoaders[model.providerID]
  if (customLoader) {
    language = await customLoader(sdk, model.api.id, state.providers[model.providerID]?.options)
  } else {
    language = sdk.languageModel(model.api.id)
  }

  state.modelCache.set(cacheKey, language)
  return language
}

/** Check if a model string refers to a non-Anthropic provider */
export function isMultiProviderModel(model: string): boolean {
  if (!model.includes("/")) return false
  const { providerID } = parseModel(model)
  return !isAnthropicProviderID(providerID)
}

/** Resolve a model string to ModelInfo */
export async function resolveModelInfo(modelString: string): Promise<ModelInfo | null> {
  if (!modelString.includes("/")) return null

  const { providerID, modelID } = parseModel(modelString)
  if (isAnthropicProviderID(providerID)) return null

  const state = await getState()
  const provider = state.providers[providerID]
  if (!provider) return null

  const existing = provider.models[modelID]
  if (existing) return existing

  // Provider exists (has credentials) but model not in catalog — build a minimal fallback
  // so that custom/auth-store-only providers (e.g. "zhipuai-coding-plan") still work
  return {
    id: ModelID.make(modelID),
    providerID: ProviderID.make(providerID),
    name: modelID,
    api: {
      id: modelID,
      url: "",
      npm: "@ai-sdk/openai-compatible",
    },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  }
}

/** Get default model from config or first available */
export async function getDefaultModel(): Promise<{ providerID: ProviderID; modelID: ModelID } | null> {
  const config = loadConfig(process.cwd())
  if (config.model) {
    return parseModel(config.model)
  }

  const state = await getState()
  const providers = Object.values(state.providers)
  if (providers.length === 0) return null

  // Find a good default model
  const priority = ["claude-sonnet-4", "gpt-5", "gemini-2.5-pro"]
  for (const p of providers) {
    for (const pattern of priority) {
      for (const [modelId, model] of Object.entries(p.models)) {
        if (model.id.includes(pattern)) {
          return { providerID: p.id, modelID: model.id }
        }
      }
    }
  }

  // Fallback to first model of first provider
  const first = providers[0]
  const firstModel = Object.values(first.models)[0]
  if (!firstModel) return null
  return { providerID: first.id, modelID: firstModel.id }
}

/** Get small/fast model for side queries */
export async function getSmallModel(): Promise<ModelInfo | null> {
  const config = loadConfig(process.cwd())
  if (config.small_model) {
    const { providerID, modelID } = parseModel(config.small_model)
    return getModel(providerID, modelID) ?? null
  }

  const state = await getState()
  const priority = ["claude-haiku-4-5", "gpt-5-nano", "gemini-2.5-flash"]
  for (const p of Object.values(state.providers)) {
    for (const pattern of priority) {
      for (const model of Object.values(p.models)) {
        if (model.id.includes(pattern)) return model
      }
    }
  }
  return null
}

/** Force refresh provider state */
export function resetState(): void {
  statePromise = null
}
