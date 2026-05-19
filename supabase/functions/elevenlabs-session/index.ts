// Edge Function: elevenlabs-session
// Returns safe ElevenLabs widget/session config for the logged-in ODIN user.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getAdminClient, getCallerUserId } from "../_shared/supabase_admin.ts"

const WIDGET_SCRIPT_URL = "https://unpkg.com/@elevenlabs/convai-widget-embed"
const DEFAULT_ODIN_VOICE_ID = "GhV9H8tqsNbzaH9vQoV5"

// @ts-expect-error Deno global
const apiKey = Deno.env.get("ELEVENLABS_API_KEY")
// @ts-expect-error Deno global
const agentId = Deno.env.get("ELEVENLABS_AGENT_ID")
// @ts-expect-error Deno global
const voiceId = Deno.env.get("ELEVENLABS_VOICE_ID") ?? DEFAULT_ODIN_VOICE_ID
// @ts-expect-error Deno global
const tuneTurnTaking = Deno.env.get("ELEVENLABS_TUNE_TURN_TAKING") === "true"

const ODIN_TURN_CONFIG = {
  turn_timeout: 30,
  silence_end_call_timeout: -1,
  soft_timeout_config: {
    timeout_seconds: -1,
    message: "",
  },
  turn_eagerness: "eager",
  spelling_patience: "auto",
  speculative_turn: false,
  retranscribe_on_turn_timeout: true,
  interruption_ignore_terms: ["odin", "hey odin"],
  mode: "turn",
}

async function getUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await getAdminClient().auth.admin.getUserById(userId)
  if (error) return null
  return data.user?.email ?? null
}

async function safeCallerUserId(req: Request): Promise<string | null> {
  try {
    return await getCallerUserId(req)
  } catch (err) {
    console.warn("[elevenlabs-session] Supabase JWT auth unavailable", err)
    return null
  }
}

async function resolveDefaultUserId(): Promise<string | null> {
  // @ts-expect-error Deno global
  const defaultUserId = Deno.env.get("ODIN_DEFAULT_USER_ID")
  if (defaultUserId) return defaultUserId

  // @ts-expect-error Deno global
  const defaultEmail = Deno.env.get("ODIN_DEFAULT_USER_EMAIL") ?? Deno.env.get("PETER_USER_EMAIL")
  if (!defaultEmail) return null

  const { data, error } = await getAdminClient()
    .from("users")
    .select("id")
    .eq("email", defaultEmail)
    .limit(1)
    .maybeSingle()

  if (error || !data?.id) return null
  return data.id as string
}

async function getSignedUrl(): Promise<string | null> {
  if (!apiKey || !agentId) return null

  const url = new URL("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url")
  url.searchParams.set("agent_id", agentId)
  const res = await fetch(url, {
    headers: {
      "xi-api-key": apiKey,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ElevenLabs signed URL failed: ${res.status} ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as { signed_url?: string }
  return json.signed_url ?? null
}

async function tuneAgentTurnTaking(): Promise<string | null> {
  if (!apiKey || !agentId || !tuneTurnTaking) return null

  const currentRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    headers: {
      "xi-api-key": apiKey,
    },
  })
  if (!currentRes.ok) {
    const text = await currentRes.text()
    throw new Error(`ElevenLabs agent read failed: ${currentRes.status} ${text.slice(0, 300)}`)
  }
  const current = (await currentRes.json()) as {
    conversation_config?: Record<string, unknown> | null
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      conversation_config: {
        ...(current.conversation_config ?? {}),
        turn: ODIN_TURN_CONFIG,
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ElevenLabs turn tuning failed: ${res.status} ${text.slice(0, 300)}`)
  }

  return "ElevenLabs turn-taking tuned for faster ODIN analysis."
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  const userId = (await safeCallerUserId(req)) ?? (await resolveDefaultUserId())
  if (!userId) {
    return jsonResponse(
      {
        error:
          "Unauthorized. ODIN voice needs a Supabase session or ODIN_DEFAULT_USER_ID / ODIN_DEFAULT_USER_EMAIL configured.",
      },
      401
    )
  }

  const email = await getUserEmail(userId)

  if (!agentId) {
    return jsonResponse({
      data: {
        configured: false,
        agentId: null,
        voiceId,
        signedUrl: null,
        conversationToken: null,
        widgetScriptUrl: WIDGET_SCRIPT_URL,
        dynamicVariables: {
          user_id: userId,
          user_email: email ?? "",
          odin_mode: "read_drafts_only",
        },
        error: "ELEVENLABS_AGENT_ID is not set.",
      },
    })
  }

  try {
    const warnings: string[] = []
    if (apiKey && agentId) {
      await tuneAgentTurnTaking().catch((err) => {
        warnings.push(err instanceof Error ? err.message : "ElevenLabs turn tuning failed")
      })
    }
    const signedUrl = apiKey
      ? await getSignedUrl().catch((err) => {
          warnings.push(err instanceof Error ? err.message : "ElevenLabs signed URL failed")
          return null
        })
      : null
    return jsonResponse({
      data: {
        configured: true,
        agentId,
        voiceId,
        signedUrl,
        conversationToken: null,
        widgetScriptUrl: WIDGET_SCRIPT_URL,
        dynamicVariables: {
          user_id: userId,
          user_email: email ?? "",
          odin_mode: "read_drafts_only",
        },
        error: apiKey
          ? warnings[0]
          : "ELEVENLABS_API_KEY is not set; falling back to public agent-id widget mode.",
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown ElevenLabs error"
    console.error("[elevenlabs-session]", message)
    return jsonResponse({
      data: {
        configured: false,
        agentId,
        voiceId,
        signedUrl: null,
        conversationToken: null,
        widgetScriptUrl: WIDGET_SCRIPT_URL,
        dynamicVariables: {
          user_id: userId,
          user_email: email ?? "",
          odin_mode: "read_drafts_only",
        },
        error: message,
      },
    })
  }
})
