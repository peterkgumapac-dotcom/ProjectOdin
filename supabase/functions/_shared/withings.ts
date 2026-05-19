import {
  getProviderTokens,
  isExpired,
  updateAccessTokenById,
  type ProviderTokens,
} from "./connected_accounts.ts"

const API_BASE = "https://wbsapi.withings.net"
const PROVIDER = "withings"

// @ts-expect-error Deno global
const clientId = Deno.env.get("WITHINGS_CLIENT_ID")
// @ts-expect-error Deno global
const clientSecret = Deno.env.get("WITHINGS_CLIENT_SECRET")

interface WithingsEnvelope<T> {
  status: number
  error?: string
  body?: T
}

interface TokenBody {
  userid: string | number
  access_token: string
  refresh_token: string
  scope?: string
  expires_in: number
  token_type?: string
}

function isInvalidAccessTokenError(message: string) {
  return /invalid_token|expired token|access_token/i.test(message)
}

function isInvalidRefreshTokenError(message: string) {
  return /invalid refresh_token/i.test(message)
}

function requireConfig() {
  if (!clientId || !clientSecret) {
    throw new Error("WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET not configured")
  }
  return { clientId, clientSecret }
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export async function signWithingsParams(
  params: Record<string, string | number>,
  secret: string
): Promise<string> {
  const paramsToSign: Record<string, string | number> = {
    action: params.action,
    client_id: params.client_id,
  }
  if (params.timestamp) paramsToSign.timestamp = params.timestamp
  if (params.nonce) paramsToSign.nonce = params.nonce

  const signedValues = Object.keys(paramsToSign)
    .sort()
    .map((key) => String(paramsToSign[key]))
    .join(",")
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedValues)
  )
  return toHex(signature)
}

async function postWithings<T>(
  path: string,
  params: Record<string, string | number>,
  accessToken?: string
): Promise<T> {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  })
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`)
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    ).toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Withings API ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = JSON.parse(text) as WithingsEnvelope<T>
  if (json.status !== 0) {
    throw new Error(json.error ?? `Withings status ${json.status}`)
  }
  if (!json.body) {
    throw new Error("Withings returned no body")
  }
  return json.body
}

async function getNonce(): Promise<string> {
  const { clientId, clientSecret } = requireConfig()
  const timestamp = Math.floor(Date.now() / 1000)
  const params = {
    action: "getnonce",
    client_id: clientId,
    timestamp,
  }
  const signature = await signWithingsParams(params, clientSecret)
  const body = await postWithings<{ nonce: string }>("/v2/signature", {
    ...params,
    signature,
  })
  return body.nonce
}

export async function exchangeWithingsCode(
  code: string,
  redirectUri: string
): Promise<TokenBody> {
  const { clientId, clientSecret } = requireConfig()
  const nonce = await getNonce()
  const params = {
    action: "requesttoken",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    grant_type: "authorization_code",
    nonce,
  }
  const signature = await signWithingsParams(params, clientSecret)
  return postWithings<TokenBody>("/v2/oauth2", { ...params, signature })
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string
  refresh_token: string
  expires_at: string
}> {
  const { clientId, clientSecret } = requireConfig()
  const nonce = await getNonce()
  const params = {
    action: "requesttoken",
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    nonce,
  }
  const signature = await signWithingsParams(params, clientSecret)
  const body = await postWithings<TokenBody>("/v2/oauth2", {
    ...params,
    signature,
  })
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  }
}

export async function getFreshWithingsTokens(
  userId: string,
  accountId?: string | null,
  forceRefresh = false
): Promise<ProviderTokens> {
  const tokens = await getProviderTokens(userId, PROVIDER, accountId ?? null)
  if (!tokens) {
    throw new Error("Withings account not connected for this user")
  }
  if (!forceRefresh && !isExpired(tokens)) return tokens
  if (!tokens.refresh_token) {
    throw new Error("Withings token expired and no refresh_token is available")
  }

  const refreshed = await refreshAccessToken(tokens.refresh_token)
  await updateAccessTokenById(
    tokens.id,
    refreshed.access_token,
    refreshed.expires_at,
    refreshed.refresh_token
  )
  return {
    ...tokens,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    token_expires_at: refreshed.expires_at,
  }
}

export async function withingsPostJson<T>(
  userId: string,
  path: string,
  params: Record<string, string | number>,
  accountId?: string | null
): Promise<T> {
  const tokens = await getFreshWithingsTokens(userId, accountId ?? null)
  try {
    return await postWithings<T>(path, params, tokens.access_token)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!isInvalidAccessTokenError(message)) throw err

    const latest = await getProviderTokens(userId, PROVIDER, tokens.id)
    if (
      latest &&
      latest.access_token &&
      !isExpired(latest) &&
      latest.access_token !== tokens.access_token
    ) {
      return postWithings<T>(path, params, latest.access_token)
    }

    try {
      const refreshed = await getFreshWithingsTokens(userId, tokens.id, true)
      return postWithings<T>(path, params, refreshed.access_token)
    } catch (refreshErr) {
      const refreshMessage =
        refreshErr instanceof Error ? refreshErr.message : String(refreshErr)
      if (!isInvalidRefreshTokenError(refreshMessage)) throw refreshErr

      const refreshedElsewhere = await getProviderTokens(userId, PROVIDER, tokens.id)
      if (
        refreshedElsewhere &&
        refreshedElsewhere.access_token &&
        !isExpired(refreshedElsewhere) &&
        refreshedElsewhere.access_token !== tokens.access_token
      ) {
        return postWithings<T>(path, params, refreshedElsewhere.access_token)
      }

      throw refreshErr
    }
  }
}
