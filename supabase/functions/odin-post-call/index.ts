// Edge Function: odin-post-call
// ElevenLabs post-call webhook. Verifies HMAC, then logs transcript memory.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getAdminClient } from "../_shared/supabase_admin.ts"
import { runConversationLearning } from "../_shared/odin_learning.ts"

interface TranscriptTurn {
  role?: string
  speaker?: string
  message?: unknown
  text?: unknown
  content?: unknown
}

interface ElevenLabsPostCallPayload {
  type?: string
  event?: string
  event_type?: string
  conversation_id?: string
  conversationId?: string
  agent_id?: string
  agentId?: string
  transcript?: TranscriptTurn[]
  analysis?: Record<string, unknown>
  metadata?: Record<string, unknown>
  dynamic_variables?: Record<string, unknown>
  elevenlabs_extra_body?: Record<string, unknown>
  data?: Record<string, unknown>
}

const encoder = new TextEncoder()

function short(value: string, max = 5000): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i]
  }
  return diff === 0
}

function parseSignature(header: string | null): { timestamp: string | null; signatures: string[] } {
  if (!header) return { timestamp: null, signatures: [] }

  const parts = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)

  let timestamp: string | null = null
  const signatures: string[] = []

  for (const part of parts) {
    const [rawKey, ...rawValueParts] = part.split("=")
    const key = rawKey?.trim().toLowerCase()
    const value = rawValueParts.join("=").trim()
    if (!value) continue
    if (key === "t" || key === "timestamp") {
      timestamp = value
      continue
    }
    if (key === "v0" || key === "v1" || key === "signature" || key === "sig") {
      signatures.push(value.replace(/^sha256=/i, ""))
    }
  }

  if (!timestamp) {
    const maybeTimestamp = parts.find((part) => /^t=\d+/.test(part))
    timestamp = maybeTimestamp?.slice(2) ?? null
  }

  return { timestamp, signatures }
}

async function verifyElevenLabsSignature(req: Request, rawBody: string): Promise<boolean> {
  // @ts-expect-error Deno global
  const secret = Deno.env.get("ELEVENLABS_WEBHOOK_SECRET")
  if (!secret) {
    console.error("[odin-post-call] ELEVENLABS_WEBHOOK_SECRET is not set.")
    return false
  }

  const header =
    req.headers.get("elevenlabs-signature") ??
    req.headers.get("ElevenLabs-Signature") ??
    req.headers.get("x-elevenlabs-signature")
  const { timestamp, signatures } = parseSignature(header)
  if (!timestamp || signatures.length === 0) return false

  const timestampMs = Number(timestamp) * 1000
  if (Number.isFinite(timestampMs)) {
    const ageMs = Math.abs(Date.now() - timestampMs)
    if (ageMs > 30 * 60 * 1000) {
      console.error("[odin-post-call] Rejected stale ElevenLabs webhook signature.")
      return false
    }
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const digest = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)))
  return signatures.some((signature) => timingSafeEqual(digest, signature.toLowerCase()))
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function turnText(turn: TranscriptTurn): string {
  return textValue(turn.message) || textValue(turn.text) || textValue(turn.content)
}

function normalizeRole(turn: TranscriptTurn): "user" | "assistant" | "system" {
  const role = String(turn.role ?? turn.speaker ?? "").toLowerCase()
  if (role.includes("agent") || role.includes("assistant") || role.includes("odin")) return "assistant"
  if (role.includes("user") || role.includes("human") || role.includes("peter")) return "user"
  return "system"
}

function transcriptFromPayload(payload: ElevenLabsPostCallPayload): TranscriptTurn[] {
  const candidates = [
    payload.transcript,
    payload.data?.transcript,
    payload.analysis?.transcript,
  ]
  const found = candidates.find(Array.isArray)
  return found as TranscriptTurn[] | undefined ?? []
}

function payloadContainers(payload: ElevenLabsPostCallPayload): Record<string, unknown>[] {
  const data = payload.data
  const initiationData = data?.conversation_initiation_client_data
  const dynamicVariables =
    initiationData && typeof initiationData === "object"
      ? (initiationData as Record<string, unknown>).dynamic_variables
      : null

  return [
    payload,
    payload.metadata,
    payload.dynamic_variables,
    payload.elevenlabs_extra_body,
    data,
    initiationData,
    dynamicVariables,
  ]
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
}

async function resolveUserId(payload: ElevenLabsPostCallPayload): Promise<string | null> {
  const containers = payloadContainers(payload)
  for (const item of containers) {
    const id = item.user_id ?? item.userId
    if (typeof id === "string" && isUuid(id)) return id
  }

  // @ts-expect-error Deno global
  const defaultEmail = Deno.env.get("ODIN_DEFAULT_USER_EMAIL") ?? Deno.env.get("PETER_USER_EMAIL") ?? "peterkgumapac@gmail.com"
  const emailCandidates = [
    ...containers.flatMap((item) => [item.user_email, item.email, item.user, item.user_id, item.userId]),
    defaultEmail,
  ].filter((item): item is string => typeof item === "string" && item.includes("@"))

  for (const email of emailCandidates) {
    const { data, error } = await getAdminClient()
      .from("users")
      .select("id")
      .eq("email", email)
      .limit(1)
      .maybeSingle()
    if (!error && data?.id) return data.id as string
  }

  return null
}

function conversationId(payload: ElevenLabsPostCallPayload): string | null {
  const containers = payloadContainers(payload)
  for (const item of containers) {
    const id = item.conversation_id ?? item.conversationId
    if (typeof id === "string" && id) return id
  }
  return null
}

function observationFor(userInput: string, odinResponse: string): string {
  if (!userInput && !odinResponse) return "ElevenLabs completed a voice conversation with ODIN."
  if (!odinResponse) return `Peter spoke with ODIN: "${short(userInput, 220)}".`
  if (!userInput) return `ODIN spoke after a voice call: "${short(odinResponse, 220)}".`
  return `Peter asked: "${short(userInput, 140)}". ODIN answered: "${short(odinResponse, 180)}".`
}

async function logTranscript(payload: ElevenLabsPostCallPayload): Promise<{
  logged: number
  userId: string | null
  learning?: { memoriesUpdated: number; rulesUpdated: number; pendingUpdated: number; eventsLogged: number }
}> {
  const userId = await resolveUserId(payload)
  if (!userId) return { logged: 0, userId: null }

  const transcript = transcriptFromPayload(payload)
  const convoId = conversationId(payload)
  const admin = getAdminClient()

  if (convoId) {
    const { data: existing } = await admin
      .from("odin_conversation_events")
      .select("id")
      .eq("user_id", userId)
      .eq("conversation_id", convoId)
      .eq("source", "voice")
      .eq("mode", "post_call")
      .limit(1)
      .maybeSingle()
    if (existing?.id) return { logged: 0, userId }
  }

  const rows = transcript
    .map((turn, index) => {
      const content = short(turnText(turn), 4000)
      if (!content) return null
      return {
        user_id: userId,
        conversation_id: convoId,
        turn_id: String(index + 1),
        source: "voice",
        role: normalizeRole(turn),
        mode: "post_call",
        content,
        payload: { role: turn.role ?? null, speaker: turn.speaker ?? null },
      }
    })
    .filter(Boolean)

  if (rows.length > 0) {
    const { error } = await admin.from("odin_conversation_events").insert(rows)
    if (error) throw new Error(`Failed to log conversation events: ${error.message}`)
  }

  const userInput = short(
    transcript
      .filter((turn) => normalizeRole(turn) === "user")
      .map(turnText)
      .filter(Boolean)
      .join("\n"),
    6000
  )
  const odinResponse = short(
    transcript
      .filter((turn) => normalizeRole(turn) === "assistant")
      .map(turnText)
      .filter(Boolean)
      .join("\n"),
    6000
  )

  if (userInput || odinResponse) {
    const { error } = await admin.from("episodic_memory").insert({
      user_id: userId,
      conversation_id: convoId,
      user_input: userInput || null,
      odin_response: odinResponse || null,
      observation: observationFor(userInput, odinResponse),
      user_reaction: "neutral",
      context_json: {
        source: "elevenlabs_post_call",
        event: payload.event ?? payload.event_type ?? payload.type ?? null,
        agent_id: payload.agent_id ?? payload.agentId ?? payload.data?.agent_id ?? null,
      },
    })
    if (error) throw new Error(`Failed to log episodic memory: ${error.message}`)
  }

  const learning = userInput
    ? await runConversationLearning({
        userId,
        userInput,
        odinResponse,
        sourceType: "post_call",
        sourceId: convoId ?? undefined,
      }).catch((err) => {
        console.warn("[odin-post-call] automatic learning failed", err)
        return undefined
      })
    : undefined

  return { logged: rows.length, userId, learning }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  const rawBody = await req.text()
  const verified = await verifyElevenLabsSignature(req, rawBody)
  if (!verified) return jsonResponse({ error: "Invalid ElevenLabs signature" }, 401)

  let payload: ElevenLabsPostCallPayload
  try {
    payload = JSON.parse(rawBody) as ElevenLabsPostCallPayload
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }

  try {
    const result = await logTranscript(payload)
    return jsonResponse({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : "ODIN post-call logging failed"
    console.error("[odin-post-call]", message)
    return jsonResponse({ ok: false, error: message }, 500)
  }
})
