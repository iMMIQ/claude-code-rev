/**
 * Multi-provider support for claude-code-rev.
 *
 * This module adds support for non-Anthropic LLM providers (OpenAI, Google,
 * OpenRouter, xAI, Mistral, Groq, etc.) using the Vercel AI SDK as a unified
 * abstraction layer. It reuses opencode's configuration format and models.dev
 * catalog for provider/model discovery.
 *
 * Usage:
 *   1. Configure providers in ~/.config/opencode/opencode.json
 *   2. Set the model: ANTHROPIC_MODEL=openai/gpt-4o or via config
 *   3. The system automatically routes to the correct provider
 */

export type { ProviderID, ModelID, ProviderInfo, ModelInfo, ResolvedModel } from "./types"
export { parseModel, isAnthropicProviderID } from "./types"

export {
  listProviders,
  getProvider,
  getModel,
  getLanguageModel,
  isMultiProviderModel,
  resolveModelInfo,
  getDefaultModel,
  getSmallModel,
  resetState,
} from "./provider"

export { queryModelViaAISDK, type AdapterOptions } from "./adapter"

export {
  getTemperature,
  getTopP,
  getTopK,
  getVariants,
  getProviderOptions,
  maxOutputTokens,
  sanitizeSchema,
  OUTPUT_TOKEN_MAX,
} from "./transform"

export {
  parseAPICallError,
  parseStreamError,
  isContextOverflowError,
  type ParsedError,
  type ContextOverflowError,
  type APIProviderError,
} from "./error"

export { getModels, refreshModels, type ModelsDevProvider, type ModelsDevModel } from "./models"

export { loadConfig, clearConfigCache, type MultiProviderConfig, type ProviderConfig } from "./config"

export {
  get as getAuth,
  all as getAllAuth,
  set as setAuth,
  remove as removeAuth,
  getApiKey,
  clearCache as clearAuthCache,
  isApiAuth,
  isOAuthAuth,
  isWellKnownAuth,
  getAuthKey,
  type AuthInfo,
  type ApiAuth,
  type OAuthAuth,
  type WellKnownAuth,
} from "./auth"
