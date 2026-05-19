import { getFreshAuthHeaders, supabase } from "@/lib/supabaseClient"

interface ProxyEnvelope<T> {
  data?: T
  error?: string
}

export interface InvokeProxyOptions {
  timeoutMs?: number
  /**
   * Hard guard. The non-streaming `invokeProxy` is a request/response call and
   * buffers the entire body before resolving. If the caller has a streaming
   * payload (LLM token stream, NDJSON feed, SSE), they must use
   * `invokeProxyStream` instead — setting this flag on the buffered path is a
   * programming error and the call will reject immediately.
   */
  stream?: false
}

export interface InvokeProxyStreamOptions {
  /**
   * Per-chunk idle timeout. The abort timer is reset every time a byte chunk
   * arrives. Default 15s. If a stream goes 15s without a single chunk, the
   * underlying fetch is aborted and the iterator throws.
   */
  idleTimeoutMs?: number
  /**
   * Absolute upper bound on the whole stream lifetime, regardless of activity.
   * Default 5 minutes. Protects against pathological producers that send a
   * keep-alive byte every 14s forever. Set Infinity to disable.
   */
  hardCeilingMs?: number
  /**
   * Initial-connect timeout for the HTTP handshake (TCP + TLS + headers).
   * Independent of the idle/hard ceilings, which start once headers land.
   * Default 10s.
   */
  connectTimeoutMs?: number
}

export class SessionExpiredError extends Error {
  constructor(message = "Session expired") {
    super(message)
    this.name = "SessionExpiredError"
  }
}

export class StreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`No bytes received for ${idleMs}ms`)
    this.name = "StreamIdleTimeoutError"
  }
}

export class StreamHardCeilingError extends Error {
  constructor(hardMs: number) {
    super(`Stream exceeded hard ceiling of ${hardMs}ms`)
    this.name = "StreamHardCeilingError"
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_STREAM_IDLE_MS = 15_000
const DEFAULT_STREAM_HARD_CEILING_MS = 5 * 60_000
const DEFAULT_STREAM_CONNECT_MS = 10_000

const STREAMING_CONTENT_TYPES = [
  "text/event-stream",
  "application/x-ndjson",
  "application/jsonl",
  "application/stream+json",
]

function isUnauthorized(message: string | undefined): boolean {
  if (!message) return false
  return /401|unauthorized|non-2xx status code/i.test(message)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms invoking ${label}`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

let sessionExpiredDispatched = false
function notifySessionExpired() {
  if (sessionExpiredDispatched) return
  sessionExpiredDispatched = true
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("odin:session-expired"))
    }
  } catch {
    // Custom events unavailable; nothing to do.
  } finally {
    // Allow re-dispatch if the user signs back in and a new 401 happens later.
    setTimeout(() => {
      sessionExpiredDispatched = false
    }, 5_000)
  }
}

function supabaseFunctionUrl(functionName: string): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ""
  if (!base) {
    throw new Error("VITE_SUPABASE_URL is not configured; cannot stream from edge functions.")
  }
  const trimmed = base.replace(/\/+$/, "")
  return `${trimmed}/functions/v1/${functionName}`
}

function looksStreamingContentType(contentType: string | null, transferEncoding: string | null): boolean {
  const ct = (contentType ?? "").toLowerCase()
  for (const candidate of STREAMING_CONTENT_TYPES) {
    if (ct.includes(candidate)) return true
  }
  const te = (transferEncoding ?? "").toLowerCase()
  // Browsers do not expose Transfer-Encoding via fetch headers in practice,
  // but Deno edge runtime sometimes leaks the hint through. Honor it when present.
  if (te.includes("chunked")) return true
  return false
}

/**
 * Invoke a Supabase edge proxy with a `{ action, params, account_id }` body.
 *
 * Use this only for buffered request/response calls (Slack list, Gmail counts,
 * calendar events, etc). Streaming LLM/text producers MUST use
 * `invokeProxyStream` so the per-chunk idle timeout applies and no mid-stream
 * retry corrupts partial output.
 *
 * `accountId` scopes the call to a single connected_accounts row, enabling
 * multi-account flows (e.g. choosing which Gmail address to read). When
 * omitted, the proxy falls back to the user's primary account for that
 * provider.
 *
 * Caps:
 * - One automatic 401 → refresh → retry, then surface SessionExpiredError.
 * - Each network attempt is wrapped in a `timeoutMs` race so callers never hang.
 */
export async function invokeProxy<T = unknown>(
  functionName: string,
  action: string,
  params?: Record<string, unknown>,
  accountId?: string | null,
  options?: InvokeProxyOptions
): Promise<{ data: T | null; error: Error | null }> {
  if (options?.stream) {
    return {
      data: null,
      error: new Error(
        `invokeProxy(${functionName}:${action}) called with stream: true. Use invokeProxyStream for streaming responses; this function buffers and would deadlock or truncate.`
      ),
    }
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const body = {
    action,
    params,
    ...(accountId ? { account_id: accountId } : {}),
  }
  const invoke = async () => {
    const headers = await getFreshAuthHeaders()
    return withTimeout(
      supabase.functions.invoke<ProxyEnvelope<T>>(functionName, {
        body: { ...body },
        headers,
      }),
      timeoutMs,
      `${functionName}:${action}`
    )
  }

  let { data, error } = await invoke()

  if (error && isUnauthorized(error.message)) {
    const refresh = await supabase.auth.refreshSession()
    if (refresh.error) {
      notifySessionExpired()
      return { data: null, error: new SessionExpiredError(refresh.error.message) }
    }
    ;({ data, error } = await invoke())
    if (error && isUnauthorized(error.message)) {
      notifySessionExpired()
      return { data: null, error: new SessionExpiredError(error.message) }
    }
  }

  if (error) {
    return { data: null, error: new Error(error.message) }
  }
  if (data?.error) {
    return { data: null, error: new Error(data.error) }
  }
  if (data?.data === undefined) {
    return { data: null, error: new Error(`Empty response from ${functionName}`) }
  }
  return { data: data.data as T, error: null }
}

export interface ProxyStreamSuccess {
  ok: true
  /** Underlying fetch Response. Use only for headers/status; do not consume body directly. */
  response: Response
  /** True if Content-Type matched a known streaming type. False for buffered JSON. */
  isStreaming: boolean
  /** Resolved Content-Type header value (lowercased) or empty string. */
  contentType: string
  /**
   * Async iterator of raw byte chunks. Idle timeout is reset per chunk; iterator
   * throws StreamIdleTimeoutError / StreamHardCeilingError on abort. Iterator
   * also throws if the network is severed.
   */
  iter: AsyncIterable<Uint8Array>
  /** Convenience: buffer the rest of the body to text. Drains `iter`. */
  text: () => Promise<string>
  /** Convenience: buffer the rest of the body and JSON.parse it. Drains `iter`. */
  json: <U = unknown>() => Promise<U>
  /** Abort the underlying fetch. Safe to call after completion. */
  abort: () => void
}

export interface ProxyStreamFailure {
  ok: false
  error: Error
}

export type ProxyStreamResult = ProxyStreamSuccess | ProxyStreamFailure

/**
 * Open a streaming connection to a Supabase edge function.
 *
 * Differences from `invokeProxy`:
 * - No total-request timeout. Connect handshake is bounded by `connectTimeoutMs`
 *   (default 10s); once headers land, only the per-chunk idle timeout applies.
 * - Idle timer resets on every byte chunk. Default 15s. Hard ceiling 5m.
 * - No mid-stream retry. Replaying a partial stream produces duplicate output.
 *   A single 401-refresh-retry happens ONLY before any body bytes are returned
 *   from the server (i.e. on initial handshake), which is safe.
 * - Auto-detects streaming via Content-Type (text/event-stream, NDJSON, JSONL,
 *   chunked transfer). If the response is buffered JSON, `isStreaming` is
 *   false and callers can simply call `.json()`. Either way, `iter` works.
 *
 * @example
 * const result = await invokeProxyStream("claude", "complete", { messages })
 * if (!result.ok) throw result.error
 * for await (const chunk of result.iter) {
 *   pipeToTTS(decoder.decode(chunk, { stream: true }))
 * }
 */
export async function invokeProxyStream(
  functionName: string,
  action: string,
  params?: Record<string, unknown>,
  accountId?: string | null,
  options?: InvokeProxyStreamOptions
): Promise<ProxyStreamResult> {
  const idleMs = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS
  const hardMs = options?.hardCeilingMs ?? DEFAULT_STREAM_HARD_CEILING_MS
  const connectMs = options?.connectTimeoutMs ?? DEFAULT_STREAM_CONNECT_MS

  const url = (() => {
    try {
      return supabaseFunctionUrl(functionName)
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  })()
  if (url instanceof Error) {
    return { ok: false, error: url }
  }

  const requestBody = JSON.stringify({
    action,
    params,
    ...(accountId ? { account_id: accountId } : {}),
  })

  const openOnce = async (): Promise<{ response: Response; controller: AbortController } | { error: Error }> => {
    const controller = new AbortController()
    const connectTimer = setTimeout(() => {
      controller.abort(new Error(`Connect timeout after ${connectMs}ms`))
    }, connectMs)

    try {
      const authHeaders = await getFreshAuthHeaders()
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: requestBody,
        signal: controller.signal,
      })
      return { response, controller }
    } catch (err) {
      controller.abort()
      return { error: err instanceof Error ? err : new Error(String(err)) }
    } finally {
      clearTimeout(connectTimer)
    }
  }

  let opened = await openOnce()
  if ("error" in opened) {
    return { ok: false, error: opened.error }
  }

  // Single pre-stream 401 → refresh → retry. Safe because no body bytes have
  // been consumed yet, so no duplicate output is possible.
  if (opened.response.status === 401) {
    opened.controller.abort()
    const refresh = await supabase.auth.refreshSession()
    if (refresh.error) {
      notifySessionExpired()
      return { ok: false, error: new SessionExpiredError(refresh.error.message) }
    }
    opened = await openOnce()
    if ("error" in opened) {
      return { ok: false, error: opened.error }
    }
    if (opened.response.status === 401) {
      opened.controller.abort()
      notifySessionExpired()
      return { ok: false, error: new SessionExpiredError("401 after refresh") }
    }
  }

  const { response, controller } = opened

  if (!response.ok) {
    controller.abort()
    return {
      ok: false,
      error: new Error(`${functionName}:${action} returned ${response.status}`),
    }
  }

  if (!response.body) {
    return {
      ok: false,
      error: new Error(`${functionName}:${action} returned no body`),
    }
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  const transferEncoding = response.headers.get("transfer-encoding")
  const isStreaming = looksStreamingContentType(contentType, transferEncoding)

  const reader = response.body.getReader()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let hardTimer: ReturnType<typeof setTimeout> | null = null
  let aborted = false
  let abortReason: Error | null = null

  const clearTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (hardTimer) {
      clearTimeout(hardTimer)
      hardTimer = null
    }
  }

  const abortWith = (reason: Error) => {
    if (aborted) return
    aborted = true
    abortReason = reason
    clearTimers()
    try {
      controller.abort(reason)
    } catch {
      // Older runtimes don't accept an abort reason argument.
      try { controller.abort() } catch { /* swallow */ }
    }
  }

  const resetIdle = () => {
    if (aborted) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      abortWith(new StreamIdleTimeoutError(idleMs))
    }, idleMs)
  }

  if (Number.isFinite(hardMs) && hardMs > 0) {
    hardTimer = setTimeout(() => {
      abortWith(new StreamHardCeilingError(hardMs))
    }, hardMs)
  }
  resetIdle()

  async function* iterate(): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          clearTimers()
          return
        }
        resetIdle()
        if (value && value.byteLength > 0) {
          yield value
        }
      }
    } catch (err) {
      clearTimers()
      if (abortReason) throw abortReason
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      clearTimers()
      try { reader.releaseLock() } catch { /* already released */ }
    }
  }

  const iter: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => iterate() }

  const drain = async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of iter) {
      chunks.push(chunk)
      total += chunk.byteLength
    }
    const combined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return combined
  }

  return {
    ok: true,
    response,
    isStreaming,
    contentType,
    iter,
    text: async () => new TextDecoder().decode(await drain()),
    json: async <U = unknown>(): Promise<U> => JSON.parse(new TextDecoder().decode(await drain())) as U,
    abort: () => abortWith(new Error("Aborted by caller")),
  }
}
