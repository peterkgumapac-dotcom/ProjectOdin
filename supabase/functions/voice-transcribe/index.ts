// Edge Function: voice-transcribe
// Converts short ODIN microphone clips into text using ElevenLabs Speech to Text.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"

interface TranscribeRequest {
  audioBase64?: string
  mimeType?: string
}

interface ElevenLabsTranscript {
  text?: string
}

// @ts-expect-error Deno global
const apiKey = Deno.env.get("ELEVENLABS_API_KEY")
// @ts-expect-error Deno global
const modelId = Deno.env.get("ELEVENLABS_STT_MODEL") ?? "scribe_v1"

function decodeBase64Audio(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  const userId = await getCallerUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)
  if (!apiKey) {
    return jsonResponse({
      error: "ELEVENLABS_API_KEY is not set for voice transcription.",
    })
  }

  const body = (await req.json().catch(() => ({}))) as TranscribeRequest
  if (!body.audioBase64) {
    return jsonResponse({ error: "Missing audioBase64." }, 400)
  }

  try {
    const audioBytes = decodeBase64Audio(body.audioBase64)
    const mimeType = body.mimeType || "audio/webm"
    const extension = mimeType.includes("mp4")
      ? "mp4"
      : mimeType.includes("ogg")
        ? "ogg"
        : mimeType.includes("wav")
          ? "wav"
          : "webm"

    const form = new FormData()
    form.append("model_id", modelId)
    form.append("file", new Blob([audioBytes], { type: mimeType }), `odin-voice.${extension}`)

    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: form,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`ElevenLabs STT failed: ${res.status} ${text.slice(0, 300)}`)
    }

    const transcript = (await res.json()) as ElevenLabsTranscript
    return jsonResponse({
      data: {
        text: transcript.text?.trim() ?? "",
        model: modelId,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown transcription error"
    console.error("[voice-transcribe]", message)
    return jsonResponse({ error: message })
  }
})
