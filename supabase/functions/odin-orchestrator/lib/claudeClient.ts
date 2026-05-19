export const CLAUDE_MEMORY_FALLBACK =
  "I seem to be having trouble accessing my memory, sir. The text channel is still available."

interface AnthropicTextBlock {
  type: "text"
  text: string
}

interface AnthropicResponse {
  content?: AnthropicTextBlock[]
  error?: { message?: string }
}

export async function askClaude(
  systemPrompt: string,
  userMessage: string,
  tools?: unknown[]
): Promise<string> {
  // @ts-expect-error Deno global
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
  if (!apiKey) return CLAUDE_MEMORY_FALLBACK

  // @ts-expect-error Deno global
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6"

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 520,
        temperature: 0.35,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        ...(tools?.length ? { tools } : {}),
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.error("[odin-claude] Anthropic HTTP error", res.status, text)
      return CLAUDE_MEMORY_FALLBACK
    }

    const data = (await res.json()) as AnthropicResponse
    const text = (data.content ?? [])
      .filter((block): block is AnthropicTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim()

    return text || CLAUDE_MEMORY_FALLBACK
  } catch (err) {
    console.error("[odin-claude] request failed", err)
    return CLAUDE_MEMORY_FALLBACK
  }
}
