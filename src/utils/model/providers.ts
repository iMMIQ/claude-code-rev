import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
}

/**
 * Check if a model string uses the multi-provider format (providerID/modelID).
 * Returns false for Anthropic-hosted models and plain model names.
 */
export function isMultiProviderModel(model: string): boolean {
  if (!model.includes('/')) return false
  // Exclude known Anthropic/AWS paths that use /
  if (model.startsWith('us.anthropic.') || model.startsWith('eu.anthropic.')) return false
  if (model.startsWith('arn:aws')) return false
  if (model.match(/^(us|eu|global)\.(anthropic|amazon)/)) return false
  if (model.includes('application-inference-profile')) return false
  // Any non-Anthropic provider/model format is multi-provider
  const [providerID] = model.split('/')
  // Anthropic-hosted providers are NOT multi-provider (they use the native SDK)
  if (['anthropic', 'amazon-bedrock', 'google-vertex', 'azure'].includes(providerID)) return false
  return true
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
