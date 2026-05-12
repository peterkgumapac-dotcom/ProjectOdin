// Edge Function: drive-proxy
// JWT-required. Routes Google Drive API actions.
// v1: all actions require drive.readonly scope which is NOT yet in the Google
// consent screen. Every call will return scope_missing until the user expands.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { googleFetchJson } from "../_shared/google.ts"

const BASE = "https://www.googleapis.com/drive/v3"

interface SearchParams {
  q: string
  pageSize?: number
  pageToken?: string
}

interface GetParams {
  fileId: string
}

interface ActionBody {
  action: string
  params?: Record<string, unknown>
}

async function searchFiles(userId: string, params: SearchParams) {
  const qs = new URLSearchParams({
    q: params.q,
    pageSize: String(params.pageSize ?? 20),
    fields: "files(id, name, mimeType, modifiedTime, webViewLink, owners),nextPageToken",
  })
  if (params.pageToken) qs.set("pageToken", params.pageToken)
  return googleFetchJson(userId, `${BASE}/files?${qs.toString()}`)
}

async function listRecent(userId: string) {
  return searchFiles(userId, {
    q: "trashed = false",
    pageSize: 20,
  })
}

async function getFileMetadata(userId: string, params: GetParams) {
  if (!params.fileId) throw new Error("fileId is required")
  const qs = new URLSearchParams({
    fields: "id, name, mimeType, modifiedTime, webViewLink, owners, size",
  })
  return googleFetchJson(userId, `${BASE}/files/${params.fileId}?${qs.toString()}`)
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  const userId = await getCallerUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)

  let body: ActionBody
  try {
    body = (await req.json()) as ActionBody
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }
  const action = body.action
  const params = body.params ?? {}

  try {
    switch (action) {
      case "search_files":
        return jsonResponse({ data: await searchFiles(userId, params as SearchParams) })
      case "list_recent":
        return jsonResponse({ data: await listRecent(userId) })
      case "get_file_metadata":
        return jsonResponse({ data: await getFileMetadata(userId, params as GetParams) })
      case "download_text":
      case "create_doc":
        return jsonResponse(
          {
            error:
              "Drive write/download actions require additional scopes. Expand consent screen + reconnect Google.",
          },
          403
        )
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[drive-proxy]", message)
    return jsonResponse({ error: message }, 502)
  }
})
