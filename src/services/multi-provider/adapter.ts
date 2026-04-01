/**
 * Adapter that bridges Vercel AI SDK streaming with claude-code-rev's
 * existing AsyncGenerator<StreamEvent | AssistantMessage> interface.
 *
 * This enables non-Anthropic providers (OpenAI, Google, etc.) to work
 * through the same query loop without any changes to query.ts.
 */
import { streamText, type CoreMessage, type CoreTool, type ToolCallPart, type ToolResultPart, type TextPart } from "ai"
import { randomUUID } from "crypto"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { Message, AssistantMessage, StreamEvent } from "../../types/message"
import type { Tools, Tool } from "../../Tool"
import type { ModelInfo } from "./types"
import { getLanguageModel } from "./provider"
import { getTemperature, getProviderOptions, maxOutputTokens } from "./transform"
import { parseAPICallError, type ParsedError } from "./error"

// ─── Message Conversion ───────────────────────────────────────

/** Convert internal Message[] to AI SDK CoreMessage[] */
function convertMessages(messages: Message[]): CoreMessage[] {
  const result: CoreMessage[] = []

  for (const msg of messages) {
    if (msg.type === "user") {
      const content = msg.message?.content
      if (typeof content === "string") {
        result.push({ role: "user", content })
      } else if (Array.isArray(content)) {
        // Convert content blocks to AI SDK format
        const parts: Array<TextPart | { type: "image"; image: string } | { type: "file"; data: string; mediaType: string }> = []
        for (const block of content) {
          if (typeof block === "object" && block !== null) {
            if (block.type === "text" && typeof block.text === "string") {
              parts.push({ type: "text", text: block.text })
            } else if (block.type === "tool_result") {
              // Tool results become tool messages in AI SDK
              const toolResultContent = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text ?? JSON.stringify(c)).join("\n")
                  : JSON.stringify(block.content)
              result.push({
                role: "tool",
                content: [{ type: "tool-result", toolCallId: block.tool_use_id as string, toolName: block.tool_use_id as string, result: toolResultContent }],
              } as any)
            } else if (block.type === "image" && block.source) {
              const src = block.source as any
              if (src.type === "base64" && src.data) {
                parts.push({ type: "image", image: `data:${src.media_type};base64,${src.data}` })
              }
            }
          }
        }
        if (parts.length > 0) {
          result.push({ role: "user", content: parts })
        }
      }
    } else if (msg.type === "assistant") {
      const content = msg.message?.content
      if (!content) continue

      if (typeof content === "string") {
        result.push({ role: "assistant", content })
      } else if (Array.isArray(content)) {
        const textParts: TextPart[] = []
        const toolCalls: ToolCallPart[] = []

        for (const block of content as any[]) {
          if (block.type === "text") {
            textParts.push({ type: "text", text: block.text || "" })
          } else if (block.type === "tool_use") {
            toolCalls.push({
              type: "tool-call",
              toolCallId: block.id || randomUUID(),
              toolName: block.name,
              args: typeof block.input === "object" ? block.input : {},
            })
          } else if (block.type === "thinking") {
            // Skip thinking blocks — they're Anthropic-specific
          }
        }

        const assistantContent: Array<TextPart | ToolCallPart> = [...textParts, ...toolCalls]
        if (assistantContent.length > 0) {
          result.push({ role: "assistant", content: assistantContent })
        }
      }
    }
  }

  return result
}

// ─── Tool Schema Conversion ───────────────────────────────────

/** Convert claude-code-rev's Tool format to AI SDK CoreTool format */
function convertTools(tools: Tools): Record<string, CoreTool> {
  const result: Record<string, CoreTool> = {}

  for (const tool of tools) {
    const schema = tool.inputSchema
    if (schema && typeof schema === "object") {
      result[tool.name] = {
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: schema as any,
      }
    } else {
      result[tool.name] = {
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: { type: "object", properties: {} },
      }
    }
  }

  return result
}

// ─── Stream Event Mapping ─────────────────────────────────────

function makeAssistantMessage(content: unknown[], model: string): AssistantMessage {
  return {
    type: "assistant",
    message: {
      content,
      model,
      role: "assistant",
      stop_reason: "end_turn",
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

// ─── Main Adapter ─────────────────────────────────────────────

export interface AdapterOptions {
  messages: Message[]
  systemPrompt: string[]
  tools: Tools
  modelInfo: ModelInfo
  signal: AbortSignal
  maxTokens?: number
  temperature?: number
}

/**
 * Stream model responses via the Vercel AI SDK, yielding events
 * in the same format as the existing Anthropic streaming path.
 */
export async function* queryModelViaAISDK({
  messages,
  systemPrompt,
  tools,
  modelInfo,
  signal,
  maxTokens,
  temperature,
}: AdapterOptions): AsyncGenerator<StreamEvent | AssistantMessage, void> {
  // 1. Convert messages and tools
  const coreMessages = convertMessages(messages)
  const coreTools = convertTools(tools)

  // 2. Resolve the LanguageModelV3
  const languageModel = await getLanguageModel(modelInfo)

  // 3. Build options
  const providerOpts = getProviderOptions(modelInfo)
  const temp = temperature ?? getTemperature(modelInfo)
  const maxOut = maxTokens ?? maxOutputTokens(modelInfo)

  // 4. Stream
  let usage = { promptTokens: 0, completionTokens: 0 }
  let currentText = ""
  let ttftMs: number | undefined

  try {
    const stream = streamText({
      model: languageModel,
      messages: coreMessages,
      system: systemPrompt.join("\n"),
      tools: coreTools,
      maxTokens: maxOut,
      abortSignal: signal,
      ...(temp !== undefined ? { temperature: temp } : {}),
      ...providerOpts,
    })

    // Yield text deltas and tool calls
    let accumulatedToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
    let textContent: Array<{ type: string; text: string }> = []

    for await (const part of (await stream).fullStream) {
      if (!ttftMs) ttftMs = Date.now()

      switch (part.type) {
        case "text-delta": {
          currentText += part.textDelta
          // Yield stream event for real-time display
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: part.textDelta },
            },
          } as StreamEvent
          break
        }
        case "tool-call": {
          accumulatedToolCalls.push({
            id: part.toolCallId,
            name: part.toolName,
            args: part.args as Record<string, unknown>,
          })
          break
        }
        case "tool-result": {
          // Tool results come back after tool calls — the query loop handles execution
          break
        }
        case "error": {
          const parsed = parseAPICallError({
            providerID: modelInfo.providerID,
            error: {
              message: part.error?.message || String(part.error),
              statusCode: (part.error as any)?.statusCode,
              responseBody: (part.error as any)?.responseBody,
            },
          })
          if (parsed.type === "context_overflow") {
            yield {
              type: "stream_event",
              event: {
                type: "error",
                error: { type: "context_length_exceeded", message: parsed.message },
              },
            } as StreamEvent
          }
          throw part.error
        }
        case "step-finish": {
          // Yield an assistant message for completed content
          const content: unknown[] = []

          if (currentText) {
            content.push({ type: "text", text: currentText })
            textContent.push({ type: "text", text: currentText })
          }

          for (const tc of accumulatedToolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.args,
            })
          }

          if (content.length > 0) {
            const msg = makeAssistantMessage(content, modelInfo.id)
            yield msg
          }

          currentText = ""
          accumulatedToolCalls = []
          break
        }
        case "finish": {
          usage = {
            promptTokens: part.usage.promptTokens ?? 0,
            completionTokens: part.usage.completionTokens ?? 0,
          }
          break
        }
      }
    }

    // Yield final usage event
    yield {
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: { output_tokens: usage.completionTokens },
        delta: { stop_reason: "end_turn" },
      },
    } as StreamEvent
  } catch (error: unknown) {
    // Classify and re-throw
    if (error instanceof Error && error.name === "AbortError") {
      throw error
    }
    throw error
  }
}
