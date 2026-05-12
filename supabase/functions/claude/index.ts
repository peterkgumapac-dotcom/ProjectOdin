// Supabase Edge Function: claude
// Proxies Anthropic Claude API calls so ANTHROPIC_API_KEY never reaches the browser.
//
// Deploy:
//   supabase functions deploy claude --project-ref xbanzimrojdsskavdvkk
//
// Set secret (server-side only):
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref xbanzimrojdsskavdvkk
//
// Invoke from the browser via @/lib/claudeClient.

// Deno runtime — std + npm specifiers.
// @ts-expect-error Deno-specific imports resolve at deploy time, not in vite tsc -b.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
// @ts-expect-error Deno-specific imports resolve at deploy time, not in vite tsc -b.
import Anthropic from "npm:@anthropic-ai/sdk@0.95"

interface ClaudeRequestBody {
  messages: Array<{ role: "user" | "assistant"; content: string }>
  model?: string
  system?: string
  max_tokens?: number
  temperature?: number
}

const DEFAULT_MODEL = "claude-sonnet-4-6"
const DEFAULT_MAX_TOKENS = 1024

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  })
}

// @ts-expect-error Deno global
const apiKey = Deno.env.get("ANTHROPIC_API_KEY")

if (!apiKey) {
  console.error("[claude] ANTHROPIC_API_KEY is not set in Supabase secrets.")
}

const client = apiKey ? new Anthropic({ apiKey }) : null

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS })
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }
  if (!client) {
    return jsonResponse(
      { error: "ANTHROPIC_API_KEY not configured on server" },
      500
    )
  }

  // Supabase Edge Functions automatically verify the JWT (project setting).
  // Anonymous calls are rejected before they reach this handler when
  // "Verify JWT" is enabled in the function settings.

  let body: ClaudeRequestBody
  try {
    body = (await req.json()) as ClaudeRequestBody
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({ error: "messages array is required" }, 400)
  }

  try {
    const message = await client.messages.create({
      model: body.model ?? DEFAULT_MODEL,
      max_tokens: body.max_tokens ?? DEFAULT_MAX_TOKENS,
      temperature: body.temperature ?? 0.7,
      system: body.system,
      messages: body.messages,
    })

    return jsonResponse({ data: message })
  } catch (err) {
    console.error("[claude] Anthropic SDK error:", err)
    const message = err instanceof Error ? err.message : "Unknown error"
    return jsonResponse({ error: message }, 502)
  }
})
