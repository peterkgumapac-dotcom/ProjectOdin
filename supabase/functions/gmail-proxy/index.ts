// Edge Function: gmail-proxy
// JWT-required. Routes Gmail API actions on behalf of the caller, scoped to
// a specific connected Google account via optional `account_id` in the body.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { googleFetchJson } from "../_shared/google.ts"

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

interface ListMessagesParams {
  q?: string
  labelIds?: string[]
  maxResults?: number
  pageToken?: string
}

interface GetMessageParams {
  id: string
  format?: "metadata" | "full" | "minimal"
}

interface ActionBody {
  action: string
  account_id?: string | null
  params?: Record<string, unknown>
}

async function listMessages(
  userId: string,
  accountId: string | null,
  params: ListMessagesParams
) {
  const qs = new URLSearchParams()
  if (params.q) qs.set("q", params.q)
  if (params.maxResults) qs.set("maxResults", String(params.maxResults))
  if (params.pageToken) qs.set("pageToken", params.pageToken)
  if (params.labelIds) {
    for (const id of params.labelIds) qs.append("labelIds", id)
  }
  return googleFetchJson(userId, `${BASE}/messages?${qs.toString()}`, {}, accountId)
}

async function getMessage(
  userId: string,
  accountId: string | null,
  params: GetMessageParams
) {
  if (!params.id) throw new Error("id is required")
  const format = params.format ?? "metadata"
  const qs = new URLSearchParams({ format })
  if (format === "metadata") {
    qs.append("metadataHeaders", "From")
    qs.append("metadataHeaders", "To")
    qs.append("metadataHeaders", "Subject")
    qs.append("metadataHeaders", "Date")
  }
  return googleFetchJson(
    userId,
    `${BASE}/messages/${params.id}?${qs.toString()}`,
    {},
    accountId
  )
}

async function search(
  userId: string,
  accountId: string | null,
  params: { q: string; maxResults?: number }
) {
  return listMessages(userId, accountId, {
    q: params.q,
    maxResults: params.maxResults ?? 20,
  })
}

async function unreadCount(userId: string, accountId: string | null) {
  const data = await googleFetchJson<{ messagesTotal?: number; messagesUnread?: number }>(
    userId,
    `${BASE}/labels/INBOX`,
    {},
    accountId
  )
  return {
    inbox_total: data.messagesTotal ?? 0,
    inbox_unread: data.messagesUnread ?? 0,
  }
}

async function profile(userId: string, accountId: string | null) {
  return googleFetchJson(userId, `${BASE}/profile`, {}, accountId)
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
  const accountId = body.account_id ?? null
  const params = body.params ?? {}

  try {
    switch (action) {
      case "list_messages":
        return jsonResponse({
          data: await listMessages(userId, accountId, params as ListMessagesParams),
        })
      case "get_message":
        return jsonResponse({
          data: await getMessage(userId, accountId, params as GetMessageParams),
        })
      case "search":
        return jsonResponse({
          data: await search(
            userId,
            accountId,
            params as { q: string; maxResults?: number }
          ),
        })
      case "unread_count":
        return jsonResponse({ data: await unreadCount(userId, accountId) })
      case "profile":
        return jsonResponse({ data: await profile(userId, accountId) })
      case "send_message":
      case "mark_read":
      case "archive":
      case "add_label":
        return jsonResponse(
          {
            error:
              "Write action requires gmail.send or gmail.modify scope. Expand the Google consent screen + reconnect Google.",
          },
          403
        )
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[gmail-proxy]", message)
    return jsonResponse({ error: message }, 502)
  }
})
