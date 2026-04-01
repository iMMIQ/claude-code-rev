/**
 * Multi-provider error parsing.
 * Ported from opencode's provider/error.ts.
 */

// ─── Context Overflow Detection ───────────────────────────────

const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi, Moonshot
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /request entity too large/i, // HTTP 413
  /context length is only \d+ tokens/i, // vLLM
  /input length.*exceeds.*context length/i, // vLLM
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai
]

function isOverflow(message: string): boolean {
  if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true
  return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
}

// ─── Error Types ──────────────────────────────────────────────

export type ContextOverflowError = {
  type: "context_overflow"
  message: string
  responseBody?: string
}

export type APIProviderError = {
  type: "api_error"
  message: string
  statusCode?: number
  isRetryable: boolean
  responseHeaders?: Record<string, string>
  responseBody?: string
  metadata?: Record<string, string>
}

export type ParsedError = ContextOverflowError | APIProviderError

export type ParsedStreamError =
  | { type: "context_overflow"; message: string; responseBody: string }
  | { type: "api_error"; message: string; isRetryable: false; responseBody: string }

// ─── Error Parsing ────────────────────────────────────────────

function extractErrorMessage(error: {
  message: string
  statusCode?: number
  responseBody?: string
}): string {
  const { message: msg, statusCode, responseBody } = error

  if (!msg || msg === "") {
    if (responseBody) return responseBody
    if (statusCode) {
      const statusText = getStatusText(statusCode)
      if (statusText) return statusText
    }
    return "Unknown error"
  }

  if (!responseBody) return msg

  try {
    const body = JSON.parse(responseBody)
    const errMsg = body.message || body.error?.message || body.error
    if (typeof errMsg === "string" && errMsg) {
      return `${msg}: ${errMsg}`
    }
  } catch {
    // not JSON
  }

  if (/^\s*<!doctype|^\s*<html/i.test(responseBody)) {
    return msg
  }

  return responseBody ? `${msg}: ${responseBody}` : msg
}

function getStatusText(code: number): string | undefined {
  const codes: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    429: "Rate Limit Exceeded",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
  }
  return codes[code]
}

function parseJson(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) return input as Record<string, unknown>
  return undefined
}

// ─── Public API ───────────────────────────────────────────────

export function parseAPICallError(input: {
  providerID: string
  error: { message: string; statusCode?: number; responseBody?: string; isRetryable?: boolean; url?: string; responseHeaders?: Record<string, string> }
}): ParsedError {
  const m = extractErrorMessage(input.error)
  const body = parseJson(input.error.responseBody)

  if (
    isOverflow(m) ||
    input.error.statusCode === 413 ||
    (body && typeof body === "object" && (body as any).error?.code === "context_length_exceeded")
  ) {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined

  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.error.isRetryable ?? false,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const body = parseJson(input)
  if (!body) return undefined

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return undefined

  const errorCode = (body as any).error?.code
  switch (errorCode) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof (body as any).error?.message === "string" ? (body as any).error.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
  }

  return undefined
}

export function isContextOverflowError(error: ParsedError): error is ContextOverflowError {
  return error.type === "context_overflow"
}
