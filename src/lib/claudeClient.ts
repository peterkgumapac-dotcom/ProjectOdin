import { supabase } from "@/lib/supabaseClient"

export type ClaudeRole = "user" | "assistant"

export interface ClaudeMessage {
  role: ClaudeRole
  content: string
}

export interface ClaudeInvokeOptions {
  messages: ClaudeMessage[]
  model?: string
  system?: string
  maxTokens?: number
  temperature?: number
}

interface AnthropicTextBlock {
  type: "text"
  text: string
}

interface AnthropicMessageResponse {
  id: string
  model: string
  role: "assistant"
  content: AnthropicTextBlock[]
  stop_reason: string | null
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export interface ClaudeResult {
  data: AnthropicMessageResponse | null
  error: Error | null
}

const FUNCTION_NAME = "claude"

export async function invokeClaude(
  options: ClaudeInvokeOptions
): Promise<ClaudeResult> {
  const body = {
    messages: options.messages,
    model: options.model,
    system: options.system,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
  }

  const { data, error } = await supabase.functions.invoke<{
    data?: AnthropicMessageResponse
    error?: string
  }>(FUNCTION_NAME, { body })

  if (error) {
    return { data: null, error: new Error(error.message) }
  }
  if (data?.error) {
    return { data: null, error: new Error(data.error) }
  }
  if (!data?.data) {
    return { data: null, error: new Error("Empty response from claude function") }
  }
  return { data: data.data, error: null }
}

export function extractText(message: AnthropicMessageResponse): string {
  return message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
}
