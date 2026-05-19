import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"

export const config = {
  maxDuration: 120,
}

type ApiRequest = {
  method?: string
  headers: Record<string, string | string[] | undefined>
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: unknown) => void
}

type JsonRecord = Record<string, unknown>

interface AgentJob {
  id: string
  user_id: string
  type: string
  status: string
  input: JsonRecord
}

interface GoogleAccount {
  id: string
  account_email: string | null
  access_token: string
  refresh_token: string | null
  token_expires_at: string | null
  is_primary: boolean
}

interface EmailTarget {
  business?: string
  agent?: string
  accountHint?: string
  labels?: string[]
  labelQuery?: string
  purpose?: string
}

interface FocusDoc {
  title?: string
  url?: string
  purpose?: string
}

interface GmailMessage {
  id: string
  account: string | null
  subject: string
  from: string
  date: string
  snippet: string
  body: string
  link: string
}

interface DriveDocText {
  id: string
  title: string
  url: string
  text: string
}

interface RunnerPendingItem {
  id?: string
  business?: string
  source?: string
  sourceAgent?: string
  title?: string
  summary?: string
  priority?: number
  dueHint?: string
  links?: string[]
  rawRefs?: string[]
  person_or_channel?: string
  issue_topic?: string
  why_it_needs_peter?: string
  next_action?: string
  source_type?: string
  source_link?: string
}

interface RunnerBrief {
  summary?: string
  urgency_score?: number
  items?: RunnerPendingItem[]
}

interface JobResult {
  jobId: string
  business: string
  status: "completed" | "failed" | "skipped"
  itemsEmitted: number
  msElapsed: number
  error?: string
}

const MAX_JOBS_PER_INVOCATION = 3
const JOB_TIMEOUT_MS = 90_000
const STALE_RUNNING_MINUTES = 10
const MAX_GMAIL_MESSAGES_PER_TARGET = 16
const MAX_MESSAGE_BODY_CHARS = 5_000
const MAX_DOC_CHARS = 18_000

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const odinApiKey = process.env.ODIN_API_KEY
const cronSecret = process.env.CRON_SECRET

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Vercel cron uses GET." })
  }

  const authorization = headerValue(req.headers.authorization)
  if (!cronSecret) {
    return res.status(500).json({ error: "CRON_SECRET is not configured." })
  }
  if (authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" })
  }
  if (!supabase || !supabaseUrl || !odinApiKey) {
    return res.status(500).json({
      error: "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ODIN_API_KEY are required.",
    })
  }

  const summary = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: [] as JobResult[],
  }

  await resetStaleRunningJobs()

  for (let index = 0; index < MAX_JOBS_PER_INVOCATION; index += 1) {
    const job = await claimNextJob()
    if (!job) break

    const result = await runWithTimeout(
      processJob(job),
      JOB_TIMEOUT_MS,
      `Job ${job.id} timed out after ${JOB_TIMEOUT_MS / 1000}s`
    )
    summary.processed += 1
    summary.results.push(result)
    if (result.status === "completed") summary.succeeded += 1
    if (result.status === "failed") summary.failed += 1
    if (result.status === "skipped") summary.skipped += 1
  }

  return res.status(200).json(summary)
}

async function resetStaleRunningJobs() {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MINUTES * 60_000).toISOString()
  const { error } = await supabase!
    .from("agent_jobs")
    .update({
      status: "queued",
      worker_id: null,
      locked_by: null,
      started_at: null,
      claimed_at: null,
      updated_at: new Date().toISOString(),
      error: "Reset after stale runner lock.",
      error_message: "Reset after stale runner lock.",
    })
    .eq("status", "running")
    .lt("started_at", staleBefore)

  if (error) throw new Error(`Failed to reset stale running jobs: ${error.message}`)
}

async function claimNextJob(): Promise<AgentJob | null> {
  const workerId = `vercel-odin-runner-${Date.now()}`
  const { data, error } = await supabase!.rpc("claim_next_agent_job", {
    p_worker_id: workerId,
  })
  if (error) throw new Error(`Failed to claim agent job: ${error.message}`)
  if (!data) return null
  const row = data as AgentJob
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    status: row.status,
    input: asRecord(row.input),
  }
}

async function processJob(job: AgentJob): Promise<JobResult> {
  const started = Date.now()
  const input = asRecord(job.input)
  const business = firstString(input.businesses) ?? "stayminty"

  try {
    if (input.kind !== "agent_brief_request") {
      await completeJob(job.id, 0, { skipped: true, reason: "Unsupported job kind", kind: input.kind })
      const result = finish(job.id, business, "skipped", 0, started)
      logJob(result)
      return result
    }

    const scanSources = stringArray(input.sources)
    const emailTargets = recordArray(input.emailTargets) as EmailTarget[]
    const focusDocs = recordArray(input.focusDocs) as FocusDoc[]
    const warnings: string[] = []
    const gmailMessages =
      scanSources.includes("gmail") && emailTargets.length > 0
        ? await fetchGmailMessages(job.user_id, emailTargets)
        : []
    const driveDocs =
      scanSources.includes("drive") && focusDocs.length > 0
        ? await fetchDriveDocs(job.user_id, emailTargets, focusDocs)
        : []

    if (scanSources.includes("slack")) {
      warnings.push(
        "Slack source is delegated to Claude/Codex MCP. This runner does not have MCP Slack access, so it uses posted briefs plus Gmail/Docs evidence only."
      )
    }

    const brief = await askClaudeForBrief({
      input,
      business,
      gmailMessages,
      driveDocs,
      warnings,
    })
    const items = normalizeClaudeItems(brief, business, firstString(input.sourceAgents) ?? "claude_stayminty")
    await postIngest(job.id, business, firstString(input.sourceAgents) ?? "claude_stayminty", brief, items, [
      ...gmailMessages.map((message) => ({ label: message.subject, type: "gmail", url: message.link })),
      ...driveDocs.map((doc) => ({ label: doc.title, type: "drive", url: doc.url })),
    ])
    await completeJob(job.id, items.length, {
      business,
      warnings,
      gmail_messages: gmailMessages.length,
      drive_docs: driveDocs.length,
      items_emitted: items.length,
    })
    const result = finish(job.id, business, "completed", items.length, started)
    logJob(result)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown runner failure"
    await failJob(job.id, message)
    const result = finish(job.id, business, "failed", 0, started, message)
    logJob(result)
    return result
  }
}

async function fetchGmailMessages(userId: string, targets: EmailTarget[]): Promise<GmailMessage[]> {
  const messages: GmailMessage[] = []
  for (const target of targets) {
    const account = await resolveGoogleAccount(userId, target.accountHint)
    const query = target.labelQuery ?? buildGmailQuery(target.labels ?? [], 7)
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages")
    listUrl.searchParams.set("q", query)
    listUrl.searchParams.set("maxResults", String(MAX_GMAIL_MESSAGES_PER_TARGET))
    const listed = await googleJson<{ messages?: { id: string }[] }>(account, listUrl.toString())
    for (const messageRef of listed.messages ?? []) {
      const messageUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageRef.id}?format=full`
      const raw = await googleJson<JsonRecord>(account, messageUrl)
      messages.push(parseGmailMessage(raw, account.account_email))
    }
  }
  return messages
}

async function fetchDriveDocs(
  userId: string,
  targets: EmailTarget[],
  focusDocs: FocusDoc[]
): Promise<DriveDocText[]> {
  const account = await resolveGoogleAccount(userId, targets[0]?.accountHint)
  const docs: DriveDocText[] = []
  for (const focusDoc of focusDocs) {
    const url = focusDoc.url ?? ""
    const id = extractGoogleDocId(url)
    if (!id) throw new Error(`Invalid Google Doc URL: ${url || "missing URL"}`)
    const doc = await googleJson<JsonRecord>(account, `https://docs.googleapis.com/v1/documents/${id}`)
    const title = typeof doc.title === "string" ? doc.title : focusDoc.title ?? id
    docs.push({
      id,
      title,
      url,
      text: extractGoogleDocText(doc).slice(0, MAX_DOC_CHARS),
    })
  }
  return docs
}

async function resolveGoogleAccount(userId: string, accountHint?: string): Promise<GoogleAccount> {
  let query = supabase!
    .from("connected_accounts")
    .select("id,account_email,access_token,refresh_token,token_expires_at,is_primary,created_at")
    .eq("user_id", userId)
    .eq("provider", "google")
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })

  if (accountHint) query = query.ilike("account_email", accountHint)

  let { data, error } = await query.limit(1)
  if (error) throw new Error(`Failed to read Google connected account: ${error.message}`)
  if ((!data || data.length === 0) && accountHint) {
    const fallback = await supabase!
      .from("connected_accounts")
      .select("id,account_email,access_token,refresh_token,token_expires_at,is_primary,created_at")
      .eq("user_id", userId)
      .eq("provider", "google")
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
    data = fallback.data
    error = fallback.error
    if (error) throw new Error(`Failed to read Google fallback account: ${error.message}`)
  }

  const account = data?.[0] as GoogleAccount | undefined
  if (!account?.access_token) throw new Error("No connected Google account with an access token.")
  if (!isGoogleTokenExpired(account)) return account
  if (!account.refresh_token) throw new Error("Google token expired and no refresh token is available.")
  return refreshGoogleAccount(account)
}

async function refreshGoogleAccount(account: GoogleAccount): Promise<GoogleAccount> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured")

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: account.refresh_token ?? "",
    grant_type: "refresh_token",
  })
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!response.ok) throw new Error(`Google token refresh failed: ${await response.text()}`)
  const token = (await response.json()) as { access_token: string; expires_in: number; refresh_token?: string }
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString()
  await supabase!
    .from("connected_accounts")
    .update({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? account.refresh_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id)

  return {
    ...account,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? account.refresh_token,
    token_expires_at: expiresAt,
  }
}

async function googleJson<T>(account: GoogleAccount, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${account.access_token}` },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Google API ${response.status}: ${text.slice(0, 500)}`)
  }
  return (await response.json()) as T
}

async function askClaudeForBrief(args: {
  input: JsonRecord
  business: string
  gmailMessages: GmailMessage[]
  driveDocs: DriveDocText[]
  warnings: string[]
}): Promise<RunnerBrief> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.")
  const anthropic = new Anthropic({ apiKey })
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7"
  const message = await anthropic.messages.create({
    model,
    max_tokens: 2200,
    temperature: 0.1,
    system: "You are ODIN's Stay Minty operations brief generator. Output JSON only, no prose.",
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          scan_contract: args.input,
          business: args.business,
          rules: [
            "Return only JSON with keys summary, urgency_score, items.",
            "items must be an array with fields id, business, source, sourceAgent, title, summary, priority, dueHint, links, rawRefs, person_or_channel, issue_topic, why_it_needs_peter, next_action, source_type, source_link.",
            "Use source_type gmail or drive for evidence from this runner. Do not invent Slack items unless Slack evidence was provided in a posted brief.",
            "Filter noise: newsletters, promos, FYIs, acknowledgements, and closed work.",
            "Only include items needing Peter's decision, reply, approval, scheduling, or awareness today.",
          ],
          warnings: args.warnings,
          gmail_messages: args.gmailMessages,
          drive_docs: args.driveDocs,
        }),
      },
    ],
  })
  const text = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim()
  return parseClaudeJson(text)
}

async function postIngest(
  jobId: string,
  business: string,
  sourceAgent: string,
  brief: RunnerBrief,
  items: RunnerPendingItem[],
  sources: { label: string; type: string; url: string }[]
) {
  const agent = sourceAgent.startsWith("codex") ? "codex" : sourceAgent.startsWith("claude") ? "claude" : "runner"
  const ingestUrl = `${supabaseUrl!.replace(/\/$/, "")}/functions/v1/odin-orchestrator/ingest`
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": jobId,
      "x-odin-api-key": odinApiKey!,
    },
    body: JSON.stringify({
      mode: "agent_ingest",
      agent,
      business: normalizeBusinessKey(business),
      summary: limitText(brief.summary ?? summarizeItems(items), 500),
      urgency_score: clampInt(brief.urgency_score ?? maxUrgencyScore(items), 0, 10),
      items,
      sources,
      timestamp: new Date().toISOString(),
      replace_pending: true,
    }),
  })
  if (!response.ok) throw new Error(`ODIN ingest failed ${response.status}: ${(await response.text()).slice(0, 800)}`)
}

function normalizeClaudeItems(brief: RunnerBrief, business: string, sourceAgent: string): RunnerPendingItem[] {
  return (brief.items ?? []).slice(0, 12).map((item, index) => {
    const sourceType = normalizeSourceType(item.source_type ?? item.source ?? "gmail")
    const title = limitText(item.title ?? item.issue_topic ?? `Priority item ${index + 1}`, 140)
    const summary = limitText(item.summary ?? item.why_it_needs_peter ?? item.next_action ?? title, 600)
    const links = Array.isArray(item.links) ? item.links.filter((link): link is string => typeof link === "string") : []
    return {
      id: item.id ?? stableItemId(business, title, index),
      business: normalizeBusinessKey(item.business ?? business),
      source: sourceType,
      sourceAgent,
      title,
      summary,
      priority: clampInt(item.priority ?? 3, 1, 5),
      dueHint: typeof item.dueHint === "string" ? item.dueHint : nullishString(item.dueHint),
      links,
      rawRefs: Array.isArray(item.rawRefs) ? item.rawRefs.filter((ref): ref is string => typeof ref === "string") : [],
      person_or_channel: item.person_or_channel ?? nullishString(item.rawRefs?.[0]) ?? null,
      issue_topic: item.issue_topic ?? title,
      why_it_needs_peter: item.why_it_needs_peter ?? summary,
      next_action: item.next_action ?? summary,
      source_type: sourceType,
      source_link: item.source_link ?? links[0] ?? null,
    }
  })
}

async function completeJob(jobId: string, resultCount: number, result: JsonRecord) {
  const { error } = await supabase!
    .from("agent_jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      result_count: resultCount,
      result,
      error: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
  if (error) throw new Error(`Failed to complete job ${jobId}: ${error.message}`)
}

async function failJob(jobId: string, message: string) {
  await supabase!
    .from("agent_jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: message,
      error_message: message,
      result_count: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
}

function parseGmailMessage(raw: JsonRecord, account: string | null): GmailMessage {
  const payload = asRecord(raw.payload)
  const headers = recordArray(payload.headers)
  const id = typeof raw.id === "string" ? raw.id : "unknown"
  return {
    id,
    account,
    subject: header(headers, "subject") ?? "(no subject)",
    from: header(headers, "from") ?? "unknown sender",
    date: header(headers, "date") ?? "",
    snippet: typeof raw.snippet === "string" ? raw.snippet : "",
    body: extractGmailBody(payload).slice(0, MAX_MESSAGE_BODY_CHARS),
    link: `https://mail.google.com/mail/u/0/#all/${id}`,
  }
}

function extractGmailBody(payload: JsonRecord): string {
  const body = asRecord(payload.body)
  if (typeof body.data === "string") return decodeBase64Url(body.data)
  const parts = recordArray(payload.parts)
  for (const part of parts) {
    const mimeType = typeof part.mimeType === "string" ? part.mimeType : ""
    if (mimeType.includes("text/plain")) {
      const data = asRecord(part.body).data
      if (typeof data === "string") return decodeBase64Url(data)
    }
  }
  for (const part of parts) {
    const nested = extractGmailBody(part)
    if (nested) return nested
  }
  return ""
}

function extractGoogleDocText(doc: JsonRecord): string {
  const content = recordArray(asRecord(doc.body).content)
  const chunks: string[] = []
  for (const block of content) {
    const paragraph = asRecord(block.paragraph)
    for (const element of recordArray(paragraph.elements)) {
      const textRun = asRecord(element.textRun)
      if (typeof textRun.content === "string") chunks.push(textRun.content)
    }
  }
  return chunks.join("").replace(/\n{3,}/g, "\n\n").trim()
}

function parseClaudeJson(text: string): RunnerBrief {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error("Claude did not return a JSON object.")
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as RunnerBrief
  if (!Array.isArray(parsed.items)) parsed.items = []
  return parsed
}

function header(headers: JsonRecord[], name: string): string | null {
  const found = headers.find((item) => String(item.name ?? "").toLowerCase() === name.toLowerCase())
  return typeof found?.value === "string" ? found.value : null
}

function extractGoogleDocId(url: string): string | null {
  return url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? null
}

function buildGmailQuery(labels: string[], days: number): string {
  const labelQuery = labels.map((label) => `label:${label}`).join(" ")
  return `${labelQuery} newer_than:${days}d`.trim()
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
}

function isGoogleTokenExpired(account: GoogleAccount): boolean {
  if (!account.token_expires_at) return false
  return new Date(account.token_expires_at).getTime() < Date.now() + 60_000
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === "object")) : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function firstString(value: unknown): string | null {
  return stringArray(value)[0] ?? null
}

function nullishString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function normalizeBusinessKey(value: unknown): "stayminty" | "dinbnb" {
  const text = String(value ?? "").toLowerCase().replace(/\s+/g, "")
  return text.includes("dinbnb") ? "dinbnb" : "stayminty"
}

function normalizeSourceType(value: unknown): "gmail" | "drive" | "slack" {
  const text = String(value ?? "").toLowerCase()
  if (text.includes("drive") || text.includes("doc")) return "drive"
  if (text.includes("slack")) return "slack"
  return "gmail"
}

function clampInt(value: unknown, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : min
  return Math.max(min, Math.min(max, number))
}

function maxUrgencyScore(items: RunnerPendingItem[]): number {
  return Math.max(0, ...items.map((item) => clampInt(item.priority ?? 3, 1, 5) * 2))
}

function summarizeItems(items: RunnerPendingItem[]): string {
  if (items.length === 0) return "No current pending items found from the runner scan."
  return `${items.length} pending item${items.length === 1 ? "" : "s"} found: ${items
    .slice(0, 3)
    .map((item) => item.title ?? item.issue_topic)
    .join("; ")}`
}

function stableItemId(business: string, title: string, index: number): string {
  return `${normalizeBusinessKey(business)}-${index}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`
}

function limitText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

async function runWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, timer])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function finish(
  jobId: string,
  business: string,
  status: JobResult["status"],
  itemsEmitted: number,
  started: number,
  error?: string
): JobResult {
  return {
    jobId,
    business,
    status,
    itemsEmitted,
    msElapsed: Date.now() - started,
    error,
  }
}

function logJob(result: JobResult) {
  console.log(
    JSON.stringify({
      job_id: result.jobId,
      business: result.business,
      items_emitted: result.itemsEmitted,
      ms_elapsed: result.msElapsed,
      status: result.status,
    })
  )
}
