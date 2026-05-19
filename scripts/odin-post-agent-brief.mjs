#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const DEFAULT_URL =
  "https://xbanzimrojdsskavdvkk.supabase.co/functions/v1/odin-orchestrator/ingest"

const BUSINESS_AGENT = {
  stayminty: "claude_stayminty",
  "stay-minty": "claude_stayminty",
  "stay minty": "claude_stayminty",
  dinbnb: "codex_dinbnb",
}

const AGENT_BUSINESS = {
  claude_stayminty: "stayminty",
  codex_dinbnb: "dinbnb",
}

function usage(exitCode = 2) {
  const text = `
Usage:
  npm run odin:post-brief -- --business stayminty --agent claude_stayminty brief.json
  cat brief.json | npm run odin:post-brief -- --business dinbnb --agent codex_dinbnb
  npm run odin:post-brief -- --business stayminty --dry-run brief.json

Accepted item fields:
  title, issue_topic, topic, person, channel
  summary, why_it_needs_peter, why, description, text
  next_action, nextAction, action
  urgency, priority
  source_link, sourceUrl, permalink, url
  source_type, sourceType, source.type
`
  console.error(text.trim())
  process.exit(exitCode)
}

function parseArgs(argv) {
  const opts = {
    business: "",
    agent: "",
    file: "",
    dryRun: false,
    endpoint: process.env.ODIN_INGEST_URL?.trim() || DEFAULT_URL,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") usage(0)
    if (arg === "--dry-run") {
      opts.dryRun = true
      continue
    }
    if (arg === "--business" || arg === "-b") {
      opts.business = argv[++i] ?? ""
      continue
    }
    if (arg === "--agent" || arg === "--source-agent" || arg === "-a") {
      opts.agent = argv[++i] ?? ""
      continue
    }
    if (arg === "--endpoint" || arg === "--url") {
      opts.endpoint = argv[++i] ?? ""
      continue
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`)
    }
    opts.file = arg
  }

  return opts
}

function readStdin() {
  return readFileSync(0, "utf8")
}

function readJson(file) {
  const raw = file ? readFileSync(file, "utf8") : readStdin()
  if (!raw.trim()) usage()
  const body = JSON.parse(raw)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Brief payload must be a JSON object.")
  }
  return body
}

function normalizeBusiness(value) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized in BUSINESS_AGENT) {
    return normalized === "stay-minty" || normalized === "stay minty"
      ? "stayminty"
      : normalized
  }
  if (normalized === "stayminty" || normalized === "dinbnb") return normalized
  return ""
}

function normalizeAgent(value, business) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized) return normalized
  return BUSINESS_AGENT[business] ?? ""
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function normalizeUrgency(value) {
  const raw = String(value ?? "").toLowerCase()
  if (["critical", "urgent", "high", "medium", "low"].includes(raw)) {
    return raw === "urgent" ? "high" : raw
  }
  if (raw.includes("critical")) return "critical"
  if (raw.includes("urgent") || raw.includes("high")) return "high"
  if (raw.includes("low") || raw.includes("noise")) return "low"
  return "medium"
}

function normalizeSourceType(item, fallback) {
  const raw = firstString(
    item.source_type,
    item.sourceType,
    item.source?.type,
    item.type,
    fallback
  ).toLowerCase()
  if (["slack", "gmail", "email", "calendar", "drive", "google_drive"].includes(raw)) {
    if (raw === "email") return "gmail"
    if (raw === "google_drive") return "drive"
    return raw
  }
  return "slack"
}

function normalizeItem(item, fallbackSourceType) {
  if (!item || typeof item !== "object") return null
  const person = firstString(item.person, item.from, item.sender, item.owner)
  const channel = firstString(item.channel, item.channel_name, item.thread)
  const topic = firstString(item.issue_topic, item.topic, item.title, item.subject)
  const title = topic || [person, channel].filter(Boolean).join(" / ") || "Agent signal"
  const summary = firstString(
    item.why_it_needs_peter,
    item.whyNeedsPeter,
    item.summary,
    item.why,
    item.description,
    item.text
  )
  const nextAction = firstString(item.next_action, item.nextAction, item.action)
  const sourceType = normalizeSourceType(item, fallbackSourceType)
  const sourceLink = firstString(
    item.source_link,
    item.sourceLink,
    item.sourceUrl,
    item.permalink,
    item.url,
    item.source?.url,
    item.source?.link
  )

  return {
    title,
    summary: summary || nextAction || title,
    urgency: normalizeUrgency(item.urgency ?? item.priority),
    next_action: nextAction || summary || title,
    person: person || undefined,
    channel: channel || undefined,
    source: sourceType,
    source_type: sourceType,
    source_url: sourceLink || undefined,
    source_link: sourceLink || undefined,
  }
}

function normalizePayload(input, opts) {
  const business =
    normalizeBusiness(opts.business) ||
    normalizeBusiness(input.business) ||
    normalizeBusiness(AGENT_BUSINESS[String(input.agent ?? input.source_agent ?? "").toLowerCase()])
  if (!business) {
    throw new Error("Missing business. Use --business stayminty or --business dinbnb.")
  }

  const sourceAgent = normalizeAgent(opts.agent || input.source_agent || input.agent, business)
  if (!sourceAgent) {
    throw new Error("Missing source agent. Use --agent claude_stayminty or --agent codex_dinbnb.")
  }

  const rawItems = Array.isArray(input.items)
    ? input.items
    : Array.isArray(input.action_items)
      ? input.action_items
      : Array.isArray(input.actions)
        ? input.actions
        : []
  const fallbackSourceType = firstString(input.source_type, input.sourceType, input.source?.type)
  const items = rawItems.map((item) => normalizeItem(item, fallbackSourceType)).filter(Boolean)
  const report = firstString(input.report_markdown, input.report, input.polished_report, input.markdown)
  const summary =
    firstString(input.summary, input.title, input.headline) ||
    (items[0]?.title
      ? `${items.length} item${items.length === 1 ? "" : "s"} from ${sourceAgent}: ${items[0].title}`
      : report.slice(0, 480))

  if (!summary) {
    throw new Error("Missing summary. The ingest contract needs a short summary.")
  }

  return {
    ...input,
    mode: "agent_ingest",
    business,
    agent: sourceAgent,
    source_agent: sourceAgent,
    summary: summary.slice(0, 500),
    report: report || undefined,
    report_markdown: report || undefined,
    items,
    action_items: items,
    replace_pending: input.replace_pending ?? true,
    timestamp: input.timestamp ?? new Date().toISOString(),
    sources:
      Array.isArray(input.sources) && input.sources.length > 0
        ? input.sources
        : Array.from(new Set(items.map((item) => item.source_type))).map((type) => ({ type })),
  }
}

function readKeychainSecret() {
  try {
    return execFileSync("security", [
      "find-generic-password",
      "-a",
      "peterkarlgumapac",
      "-s",
      "ODIN_API_KEY",
      "-w",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

function readOdinApiKey() {
  const envKey = process.env.ODIN_API_KEY?.trim()
  if (envKey) return envKey
  const keychainKey = readKeychainSecret()
  if (keychainKey) return keychainKey
  throw new Error("ODIN_API_KEY is not set and was not found in macOS Keychain.")
}

const opts = parseArgs(process.argv.slice(2))
const body = normalizePayload(readJson(opts.file), opts)

if (opts.dryRun) {
  console.log(JSON.stringify(body, null, 2))
  process.exit(0)
}

const apiKey = readOdinApiKey()
const response = await fetch(opts.endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-odin-api-key": apiKey,
  },
  body: JSON.stringify(body),
})

const text = await response.text()
let data = null
try {
  data = JSON.parse(text)
} catch {
  data = { raw: text }
}

if (!response.ok) {
  console.error(`[odin:post-brief] HTTP ${response.status}`)
  console.error(JSON.stringify(data, null, 2))
  process.exit(1)
}

const result = data?.data ?? data
console.log(
  [
    `[odin:post-brief] HTTP ${response.status}`,
    `source_agent=${result?.source_agent ?? body.source_agent}`,
    `business=${result?.business ?? body.business}`,
    `items=${result?.items ?? body.items.length}`,
    `pending_updated=${result?.pending?.pendingUpdated ?? "unknown"}`,
    `received_at=${result?.received_at ?? "unknown"}`,
  ].join(" ")
)
