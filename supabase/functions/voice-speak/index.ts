// Edge Function: voice-speak
// Converts short ODIN responses into speech using the configured ElevenLabs voice.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"

interface SpeakRequest {
  text?: string
}

const DEFAULT_ODIN_VOICE_ID = "GhV9H8tqsNbzaH9vQoV5"

// @ts-expect-error Deno global
const apiKey = Deno.env.get("ELEVENLABS_API_KEY")
// @ts-expect-error Deno global
const voiceId = Deno.env.get("ELEVENLABS_VOICE_ID") ?? DEFAULT_ODIN_VOICE_ID
// @ts-expect-error Deno global
const modelId = Deno.env.get("ELEVENLABS_TTS_MODEL") ?? "eleven_flash_v2_5"
const MAX_TTS_CHARS = 900

function toBase64(bytes: Uint8Array) {
  let binary = ""
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
  }
  return btoa(binary)
}

function trimForSpeech(value: string, max = MAX_TTS_CHARS) {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  const clipped = text.slice(0, max)
  const sentenceEnd = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?")
  )
  if (sentenceEnd > max * 0.55) return clipped.slice(0, sentenceEnd + 1).trim()
  const wordEnd = clipped.lastIndexOf(" ")
  return `${clipped.slice(0, wordEnd > 0 ? wordEnd : max - 1).trim()}.`
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  const userId = await getCallerUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)
  if (!apiKey) {
    return jsonResponse({ data: null, error: "ELEVENLABS_API_KEY is not set for voice output." })
  }

  const body = (await req.json().catch(() => ({}))) as SpeakRequest
  const text = body.text?.replace(/\s+/g, " ").trim()
  if (!text) return jsonResponse({ error: "Missing text." }, 400)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`)
      url.searchParams.set("output_format", "mp3_44100_128")

      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "xi-api-key": apiKey,
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: trimForSpeech(text),
          model_id: modelId,
        }),
      })

      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(`ElevenLabs TTS failed: ${res.status} ${errorText.slice(0, 300)}`)
      }

      const audio = new Uint8Array(await res.arrayBuffer())
      return jsonResponse({
        data: {
          audioBase64: toBase64(audio),
          mimeType: "audio/mpeg",
          voiceId,
          model: modelId,
        },
      })
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown speech error"
    console.error("[voice-speak]", message)
    return jsonResponse({ data: null, error: message })
  }
})
