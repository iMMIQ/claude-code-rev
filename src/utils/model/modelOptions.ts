// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { getModelStrings } from './modelStrings.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { getAPIProvider } from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { getGlobalConfig } from '../config.js'
import { listProviders, isAnthropicProviderID } from '../../services/multi-provider/index.js'
import type { ModelInfo, ProviderInfo } from '../../services/multi-provider/types.js'

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

// ─── Multi-provider model loading ────────────────────────────────

let multiProviderOptionsCache: ModelOption[] | null = null

function buildModelOption(provider: ProviderInfo, modelId: string, model: ModelInfo): ModelOption {
  const fullId = `${provider.id}/${modelId}`
  const label = model.name || modelId
  const parts: string[] = [provider.name]
  if (model.capabilities.reasoning) parts.push('reasoning')
  if (model.capabilities.attachment) parts.push('multimodal')
  if (model.limit.context >= 128000) parts.push(`${(model.limit.context / 1000).toFixed(0)}K ctx`)
  if (model.limit.output >= 8192) parts.push(`${(model.limit.output / 1000).toFixed(0)}K out`)
  const description = parts.join(' · ')
  return { value: fullId, label, description }
}

const MAX_MODELS_PER_PROVIDER = 10

async function loadMultiProviderOptions(): Promise<void> {
  try {
    const providers = await listProviders()
    const options: ModelOption[] = []
    for (const [providerId, provider] of Object.entries(providers)) {
      if (isAnthropicProviderID(providerId)) continue
      // Sort: active first, then newest release date
      const entries = Object.entries(provider.models)
        .sort((a, b) => {
          const statusOrder: Record<string, number> = { active: 0, beta: 1, alpha: 2 }
          const sa = statusOrder[a[1].status] ?? 3
          const sb = statusOrder[b[1].status] ?? 3
          if (sa !== sb) return sa - sb
          return (b[1].release_date || '').localeCompare(a[1].release_date || '')
        })
        .slice(0, MAX_MODELS_PER_PROVIDER)
      for (const [modelId, model] of entries) {
        options.push(buildModelOption(provider, modelId, model))
      }
    }
    multiProviderOptionsCache = options
  } catch {
    multiProviderOptionsCache = []
  }
}

// Preload at module import time so the cache is warm when the picker opens
const _preloadPromise = loadMultiProviderOptions()

/** Pre-load multi-provider model options. */
export async function preloadMultiProviderModels(): Promise<void> {
  await loadMultiProviderOptions()
}

/** Invalidate the multi-provider options cache (e.g. after auth change) */
export function invalidateMultiProviderCache(): void {
  multiProviderOptionsCache = null
  loadMultiProviderOptions().catch(() => {})
}

// ─── Default option ──────────────────────────────────────────────

export function getDefaultOptionForUser(_fastMode = false): ModelOption {
  const currentModel = renderDefaultModelSetting(getDefaultMainLoopModelSetting())
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${currentModel})`,
  }
}

// ─── Model family info (for upgrade hints on pinned models) ──────

function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family
  if (canonical.includes('claude-opus-4')) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

// ─── Main model options builder ──────────────────────────────────

export function getModelOptions(fastMode = false): ModelOption[] {
  // Ant users have their own model config
  if (process.env.USER_TYPE === 'ant') {
    const antModelOptions: ModelOption[] = (getAntModels as any)().map((m: any) => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`,
    }))
    const options: ModelOption[] = [
      getDefaultOptionForUser(fastMode),
      ...antModelOptions,
    ]
    appendAnthropicAliases(options)
    appendMultiProviderModels(options)
    appendCustomModels(options)
    return filterModelOptionsByAllowlist(options)
  }

  const options: ModelOption[] = [getDefaultOptionForUser(fastMode)]

  // Anthropic models — use short aliases for backward compatibility
  appendAnthropicAliases(options)

  // Multi-provider models from provider registry cache
  appendMultiProviderModels(options)

  // Custom / env / bootstrap / current model
  appendCustomModels(options)

  return filterModelOptionsByAllowlist(options)
}

// ─── Option appenders ────────────────────────────────────────────

function appendAnthropicAliases(options: ModelOption[]): void {
  const is3P = getAPIProvider() !== 'firstParty'
  const existing = (v: ModelSetting) => options.some(o => o.value === v)

  const sonnetVal = is3P ? getModelStrings().sonnet46 : 'sonnet'
  if (!existing(sonnetVal)) {
    options.push({
      value: sonnetVal,
      label: 'Sonnet',
      description: 'Sonnet 4.6 · Best for everyday tasks',
      descriptionForModel: 'Sonnet 4.6 - best for everyday tasks',
    })
  }

  const opusVal = is3P ? getModelStrings().opus46 : 'opus'
  if (!existing(opusVal)) {
    options.push({
      value: opusVal,
      label: 'Opus',
      description: 'Opus 4.6 · Most capable for complex work',
      descriptionForModel: 'Opus 4.6 - most capable for complex work',
    })
  }

  if (!existing('haiku')) {
    options.push({
      value: 'haiku',
      label: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers',
      descriptionForModel: 'Haiku 4.5 - fastest for quick answers',
    })
  }

  const sonnet1m = is3P ? getModelStrings().sonnet46 + '[1m]' : 'sonnet[1m]'
  if (!existing(sonnet1m)) {
    options.push({
      value: sonnet1m,
      label: 'Sonnet (1M context)',
      description: 'Sonnet 4.6 with 1M context window',
      descriptionForModel: 'Sonnet 4.6 with 1M context - for long sessions',
    })
  }

  const opus1m = is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]'
  if (!existing(opus1m)) {
    options.push({
      value: opus1m,
      label: 'Opus (1M context)',
      description: 'Opus 4.6 with 1M context window',
      descriptionForModel: 'Opus 4.6 with 1M context - for long sessions',
    })
  }
}

function appendMultiProviderModels(options: ModelOption[]): void {
  if (!multiProviderOptionsCache) return
  for (const opt of multiProviderOptionsCache) {
    if (!options.some(o => o.value === opt.value)) {
      options.push(opt)
    }
  }
}

function appendCustomModels(options: ModelOption[]): void {
  // Custom model from env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (envCustomModel && !options.some(o => o.value === envCustomModel)) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Additional model options from bootstrap cache
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(o => o.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from current/initial model if not already listed
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel !== null && !options.some(o => o.value === customModel)) {
    const knownOption = getKnownModelOption(customModel)
    options.push(knownOption ?? {
      value: customModel,
      label: customModel,
      description: 'Custom model',
    })
  }
}

// ─── Allowlist filter ────────────────────────────────────────────

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
