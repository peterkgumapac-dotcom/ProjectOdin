import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { chromium } from "playwright"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const PROFILE_DIR = path.join(ROOT, ".odin", "browser-profile")
const WORKER_ID = `odin-${os.hostname()}-${process.pid}`
const JOB_TYPES = [
  "slack_browser_scan",
  "gmail_browser_scan",
  "combined_doo_scan",
  "browser_agent_task",
]
const DEFAULT_DAEMON_PORT = 8787
const BASE_DAEMON_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5174",
  "http://localhost:5174",
  "http://127.0.0.1:5175",
  "http://localhost:5175",
  "http://127.0.0.1:5176",
  "http://localhost:5176",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
])
const parseDaemonOrigins = (rawValue) => {
  if (!rawValue) return []
  return String(rawValue)
    .split(/[,;\n]+/)
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean)
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=")
        return [line.slice(0, index), line.slice(index + 1)]
      })
  )
}

const env = {
  ...readEnvFile(path.join(ROOT, ".env.local")),
  ...readEnvFile(path.join(ROOT, ".env.worker.local")),
  ...process.env,
}

const ALLOWED_DAEMON_ORIGINS = new Set([
  ...BASE_DAEMON_ORIGINS,
  ...parseDaemonOrigins(env.ODIN_BROWSER_ALLOWED_ORIGINS),
])

const supabaseUrl = env.VITE_SUPABASE_URL
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY
const workerEmail = env.ODIN_SUPABASE_EMAIL
const workerPassword = env.ODIN_SUPABASE_PASSWORD
const pollMs = Number(env.ODIN_WORKER_POLL_MS ?? 5000)
const headless = env.ODIN_WORKER_HEADLESS !== "false"
const browserChannel = env.ODIN_WORKER_BROWSER_CHANNEL ?? "playwright"
const browserExecutablePath = env.ODIN_WORKER_EXECUTABLE_PATH
const daemonPort = Number(env.ODIN_BROWSER_DAEMON_PORT ?? DEFAULT_DAEMON_PORT)

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.")
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: true },
})

async function signInWorker() {
  if (!workerEmail || !workerPassword || workerPassword === "replace-me") {
    throw new Error(
      "Create .env.worker.local from .env.worker.local.example and set ODIN_SUPABASE_EMAIL / ODIN_SUPABASE_PASSWORD."
    )
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: workerEmail,
    password: workerPassword,
  })
  if (error) throw error
}

function browserLaunchOptions({ visible = false, channelOverride } = {}) {
  const channel = channelOverride ?? browserChannel
  const launchOptions = {
    headless: visible ? false : headless,
    viewport: { width: 1440, height: 1000 },
  }

  if (browserExecutablePath) {
    launchOptions.executablePath = browserExecutablePath
  } else if (channel && channel !== "playwright") {
    launchOptions.channel = channel
  }

  return launchOptions
}

async function launchContext({ visible = false, channelOverride } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  return chromium.launchPersistentContext(
    PROFILE_DIR,
    browserLaunchOptions({ visible, channelOverride })
  )
}

async function setup({ channelOverride } = {}) {
  const context = await launchContext({ visible: true, channelOverride })
  await context.newPage().then((page) => page.goto("https://app.slack.com/client"))
  await context.newPage().then((page) => page.goto("https://mail.google.com/mail/u/0/#inbox"))
  const label =
    channelOverride === "chrome"
      ? "Chrome"
      : browserExecutablePath
        ? browserExecutablePath
        : browserChannel === "playwright"
          ? "Playwright Chromium"
          : browserChannel
  console.log(`ODIN setup browser opened in ${label}.`)
  console.log("Log into Slack and Gmail, finish any manual config, then press Ctrl+C here.")
  await new Promise(() => {})
}

async function isLoginRequired(page, kind) {
  const url = page.url()
  if (/accounts\.google\.com|signin|login/i.test(url)) return true
  const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase()
  if (kind === "gmail") return body.includes("sign in") || body.includes("use your google account")
  if (kind === "slack") return body.includes("sign in to slack") || body.includes("sign in with")
  return false
}

async function scanGmail(context) {
  const page = await context.newPage()
  await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(3500)
  if (await isLoginRequired(page, "gmail")) {
    await page.close()
    return { loginRequired: true, message: "Gmail login required in ODIN setup browser." }
  }

  const items = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr[role='row']")).slice(0, 20)
    return rows
      .map((row) => {
        const text = (row.textContent ?? "").replace(/\s+/g, " ").trim()
        if (!text || text.length < 12) return null
        const link = row.querySelector("a[href*='#inbox/'], a[href*='#all/'], a[href*='th=']")
        const href = link instanceof HTMLAnchorElement ? link.href : location.href
        return {
          title: text.slice(0, 120),
          source: "Gmail",
          sourceUrl: href,
          snippet: text.slice(0, 260),
        }
      })
      .filter(Boolean)
      .slice(0, 8)
  })

  await page.close()
  return {
    loginRequired: false,
    result: {
      source: "local_browser",
      kind: "gmail",
      scannedAt: new Date().toISOString(),
      summary: items.length
        ? `Browser scan found ${items.length} visible Gmail inbox rows.`
        : "Browser scan found no visible Gmail inbox rows.",
      items,
      warnings: [],
    },
  }
}

async function scanSlack(context, input = {}) {
  const page = await context.newPage()
  await page.goto("https://app.slack.com/client", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(5000)
  if (await isLoginRequired(page, "slack")) {
    await page.close()
    return { loginRequired: true, message: "Slack login required in ODIN setup browser." }
  }

  const items = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href*='/archives/'], a[href^='slack://']"))
    const seen = new Set()
    return anchors
      .map((anchor) => {
        const href = anchor instanceof HTMLAnchorElement ? anchor.href : ""
        const container = anchor.closest("[data-qa], [role='listitem'], div") ?? anchor
        const text = (container.textContent ?? anchor.textContent ?? "").replace(/\s+/g, " ").trim()
        if (!href || !text || seen.has(href)) return null
        seen.add(href)
        return {
          title: text.slice(0, 120),
          source: "Slack",
          sourceUrl: href,
          snippet: text.slice(0, 300),
        }
      })
      .filter(Boolean)
      .slice(0, 12)
  })

  await page.close()
  const scope = input.channelName ? ` for #${input.channelName}` : ""
  return {
    loginRequired: false,
    result: {
      source: "local_browser",
      kind: "slack",
      scannedAt: new Date().toISOString(),
      summary: items.length
        ? `Browser scan found ${items.length} visible Slack source links${scope}.`
        : `Browser scan found no visible Slack source links${scope}.`,
      items,
      warnings: [],
    },
  }
}

const daemonState = {
  context: null,
  page: null,
  pendingActions: new Map(),
  lastObservation: null,
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "")
  } catch {
    return "current page"
  }
}

function normalizeDaemonUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim()
  if (!value) return "https://www.google.com"
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
  const url = new URL(withProtocol)
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ODIN Browser only opens http and https URLs.")
  }
  return url.toString()
}

async function ensureDaemonPage({ url } = {}) {
  if (!daemonState.context) {
    daemonState.context = await launchContext({ visible: true })
    daemonState.context.on("close", () => {
      daemonState.context = null
      daemonState.page = null
      daemonState.pendingActions.clear()
    })
  }

  if (!daemonState.page || daemonState.page.isClosed()) {
    daemonState.page = daemonState.context.pages()[0] ?? await daemonState.context.newPage()
  }

  await daemonState.page.bringToFront().catch(() => undefined)
  if (url) {
    await daemonState.page.goto(normalizeDaemonUrl(url), { waitUntil: "domcontentloaded" })
      .catch(async () => {
        await daemonState.page.goto(normalizeDaemonUrl(url))
      })
  }
  return daemonState.page
}

async function detectLoginRequiredGeneric(page) {
  const url = page.url()
  if (/accounts\.google\.com|signin|sign-in|login|auth|oauth|2fa|mfa/i.test(url)) return true
  return await page.evaluate(() => {
    const text = (document.body?.innerText ?? "").toLowerCase()
    const hasPassword = Boolean(document.querySelector("input[type='password']"))
    const hasOtp = Boolean(
      document.querySelector(
        "input[autocomplete='one-time-code'], input[name*='otp' i], input[id*='otp' i], input[name*='code' i], input[id*='code' i]"
      )
    )
    return (
      hasPassword ||
      hasOtp ||
      text.includes("sign in") ||
      text.includes("log in") ||
      text.includes("two-factor") ||
      text.includes("verification code")
    )
  }).catch(() => false)
}

function buildSummary({ text, loginRequired, url, title }) {
  if (loginRequired) {
    return `Login required on ${safeHost(url)}. Peter should finish credentials or 2FA manually, then resume ODIN.`
  }
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!cleaned) return `ODIN is viewing ${title || safeHost(url)}. No readable page text was detected.`
  return cleaned.length > 360 ? `${cleaned.slice(0, 357)}...` : cleaned
}

function browserActionRisk(label) {
  return /\b(send|submit|delete|remove|buy|purchase|pay|confirm|cancel|share|grant|approve|post|archive|transfer|checkout)\b/i.test(
    label
  )
    ? "high"
    : "normal"
}

async function observePage(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined)
  const [title, loginRequired, extracted] = await Promise.all([
    page.title().catch(() => ""),
    detectLoginRequiredGeneric(page),
    page.evaluate(() => {
      const cssEscape = (value) => {
        if (globalThis.CSS?.escape) return globalThis.CSS.escape(value)
        return String(value).replace(/["\\#.;:[\]>+~*^$|=(),\s]/g, "\\$&")
      }
      const selectorFor = (element) => {
        if (!(element instanceof Element)) return ""
        const direct =
          element.getAttribute("data-testid") ||
          element.getAttribute("data-qa") ||
          element.getAttribute("aria-label")
        if (direct) {
          const attr = element.getAttribute("data-testid")
            ? "data-testid"
            : element.getAttribute("data-qa")
              ? "data-qa"
              : "aria-label"
          return `${element.tagName.toLowerCase()}[${attr}="${cssEscape(direct)}"]`
        }
        if (element.id) return `#${cssEscape(element.id)}`

        const parts = []
        let current = element
        while (current && current instanceof Element && current !== document.body && parts.length < 5) {
          let part = current.tagName.toLowerCase()
          const parent = current.parentElement
          if (parent) {
            const sameTag = Array.from(parent.children).filter(
              (child) => child.tagName === current.tagName
            )
            if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`
          }
          parts.unshift(part)
          current = parent
        }
        return parts.join(" > ")
      }
      const labelFor = (element) => {
        const input = element instanceof HTMLInputElement ? element : null
        const inputType = input?.type?.toLowerCase() ?? ""
        const id = element.getAttribute("id")
        const label = id ? document.querySelector(`label[for="${cssEscape(id)}"]`)?.textContent : ""
        const aria = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? ""
        const placeholder =
          input && !["password", "hidden"].includes(inputType)
            ? input.getAttribute("placeholder") ?? ""
            : ""
        const valueLabel =
          input && ["button", "submit", "reset"].includes(inputType) ? input.value : ""
        return [aria, label, element.textContent, placeholder, valueLabel]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      }

      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 2400)
      const controls = Array.from(
        document.querySelectorAll("a[href], button, input, textarea, select, [role='button'], [role='link']")
      )
        .map((element) => {
          if (!(element instanceof HTMLElement)) return null
          const rect = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            style.visibility === "hidden" ||
            style.display === "none"
          ) {
            return null
          }
          const input = element instanceof HTMLInputElement ? element : null
          const type = input?.type?.toLowerCase() ?? element.tagName.toLowerCase()
          const isSensitive =
            type === "password" ||
            /password|otp|token|secret|code/i.test(
              `${element.getAttribute("name") ?? ""} ${element.getAttribute("id") ?? ""} ${element.getAttribute("autocomplete") ?? ""}`
            )
          const label = labelFor(element)
          if (!label && !element.getAttribute("href")) return null
          return {
            label: label.slice(0, 140) || element.getAttribute("href") || "Untitled control",
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role") ?? "",
            type,
            href: element instanceof HTMLAnchorElement ? element.href : "",
            selector: isSensitive ? "" : selectorFor(element),
            sensitive: isSensitive,
          }
        })
        .filter(Boolean)
        .slice(0, 80)
      return { text, controls }
    }).catch(() => ({ text: "", controls: [] })),
  ])

  const observation = {
    source: "local_browser",
    kind: "generic",
    scannedAt: new Date().toISOString(),
    url: page.url(),
    title,
    loginRequired,
    summary: buildSummary({ text: extracted.text, loginRequired, url: page.url(), title }),
    items: extracted.controls.slice(0, 24).map((item) => ({
      title: item.label,
      source: item.tag === "a" ? "Link" : item.tag === "button" ? "Button" : "Control",
      sourceUrl: item.href || page.url(),
      snippet: item.sensitive
        ? "Sensitive input detected. Peter must handle this manually."
        : [item.role, item.type].filter(Boolean).join(" · "),
      selector: item.selector,
      sensitive: item.sensitive,
    })),
    proposed_actions: [],
    warnings: loginRequired
      ? ["Login required. ODIN will not read or store passwords, verification codes, or private field values."]
      : [],
  }

  daemonState.lastObservation = observation
  return observation
}

async function proposeBrowserActions(prompt, mode = "act") {
  const page = await ensureDaemonPage()
  const observation = await observePage(page)
  const words = String(prompt ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
  const candidates = observation.items
    .filter((item) => item.selector && !item.sensitive)
    .map((item) => {
      const label = item.title.toLowerCase()
      const score = words.reduce((total, word) => total + (label.includes(word) ? 1 : 0), 0)
      return { item, score }
    })
    .filter((entry) => entry.score > 0 || words.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  const proposedActions = candidates.map(({ item }) => {
    const id = randomUUID()
    const risk = browserActionRisk(item.title)
    const action = {
      id,
      type: "click",
      label: `Click ${item.title}`,
      target: item.title,
      selector: item.selector,
      risk,
      requires_confirmation: true,
      mode,
    }
    daemonState.pendingActions.set(id, action)
    return action
  })

  return {
    ...observation,
    summary: proposedActions.length
      ? `ODIN found ${proposedActions.length} possible action${proposedActions.length === 1 ? "" : "s"} on ${safeHost(observation.url)}. Confirm one before ODIN clicks.`
      : `ODIN observed ${safeHost(observation.url)}, but found no safe click action matching that task. Text entry stays manual in v1.`,
    proposed_actions: proposedActions,
    warnings: [
      ...observation.warnings,
      "ODIN will not type passwords, verification codes, payment data, or messages without an explicit future tool path.",
    ],
  }
}

async function executeConfirmedAction(actionId) {
  const action = daemonState.pendingActions.get(actionId)
  if (!action) throw new Error("That browser action is no longer pending. Observe the page and try again.")
  const page = await ensureDaemonPage()
  await page.locator(action.selector).click({ timeout: 8000 })
  daemonState.pendingActions.delete(actionId)
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined)
  const observation = await observePage(page)
  return {
    ...observation,
    summary: `Confirmed action completed: ${action.label}. ${observation.summary}`,
    warnings: observation.warnings,
  }
}

function daemonCorsHeaders(origin) {
  const allowedOrigin = ALLOWED_DAEMON_ORIGINS.has(origin) ? origin : "http://127.0.0.1:5173"
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "content-type": "application/json; charset=utf-8",
  }
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

function writeJson(res, statusCode, body, origin) {
  res.writeHead(statusCode, daemonCorsHeaders(origin))
  res.end(JSON.stringify(body))
}

async function daemonStatus() {
  const page = daemonState.page && !daemonState.page.isClosed() ? daemonState.page : null
  const title = page ? await page.title().catch(() => "") : ""
  const loginRequired = page ? await detectLoginRequiredGeneric(page) : false
  return {
    ok: true,
    running: true,
    provider: "local_playwright",
    hasSession: Boolean(page),
    profileDir: PROFILE_DIR,
    url: page?.url() ?? null,
    title,
    loginRequired,
    pendingActionCount: daemonState.pendingActions.size,
  }
}

async function handleDaemonRequest(req, res) {
  const origin = req.headers.origin ?? ""
  if (origin && !ALLOWED_DAEMON_ORIGINS.has(origin)) {
    writeJson(res, 403, { ok: false, error: "Origin is not allowed for ODIN Browser daemon." }, origin)
    return
  }
  if (req.method === "OPTIONS") {
    writeJson(res, 204, {}, origin)
    return
  }

  const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${daemonPort}`)
  try {
    if (req.method === "GET" && requestUrl.pathname === "/status") {
      writeJson(res, 200, await daemonStatus(), origin)
      return
    }

    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Method not allowed." }, origin)
      return
    }

    const body = await readJsonBody(req)
    if (requestUrl.pathname === "/session/open") {
      const page = await ensureDaemonPage({ url: body.url })
      writeJson(res, 200, { ok: true, result: await observePage(page) }, origin)
      return
    }
    if (requestUrl.pathname === "/navigate") {
      const page = await ensureDaemonPage({ url: body.url })
      writeJson(res, 200, { ok: true, result: await observePage(page) }, origin)
      return
    }
    if (requestUrl.pathname === "/observe") {
      const page = await ensureDaemonPage()
      writeJson(res, 200, { ok: true, result: await observePage(page) }, origin)
      return
    }
    if (requestUrl.pathname === "/task") {
      writeJson(res, 200, {
        ok: true,
        result: await proposeBrowserActions(body.prompt, body.mode),
      }, origin)
      return
    }
    if (requestUrl.pathname === "/confirm") {
      writeJson(res, 200, {
        ok: true,
        result: await executeConfirmedAction(body.actionId),
      }, origin)
      return
    }
    if (requestUrl.pathname === "/stop") {
      if (daemonState.context) await daemonState.context.close()
      daemonState.context = null
      daemonState.page = null
      daemonState.pendingActions.clear()
      daemonState.lastObservation = null
      writeJson(res, 200, { ok: true, stopped: true }, origin)
      return
    }

    writeJson(res, 404, { ok: false, error: "Unknown ODIN Browser daemon endpoint." }, origin)
  } catch (err) {
    writeJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : "ODIN Browser daemon failed.",
    }, origin)
  }
}

async function startDaemon() {
  const server = http.createServer((req, res) => {
    void handleDaemonRequest(req, res)
  })
  await new Promise((resolve) => server.listen(daemonPort, "127.0.0.1", resolve))
  console.log(`ODIN Browser daemon listening on http://127.0.0.1:${daemonPort}`)
  console.log("Open /browser in ODIN, then use the page controls. Credentials stay in the visible browser.")
}

async function claimNextJob() {
  const { data, error } = await supabase
    .from("agent_jobs")
    .select("*")
    .eq("status", "queued")
    .in("type", JOB_TYPES)
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) throw error
  const job = data?.[0]
  if (!job) return null
  const { data: updated, error: updateError } = await supabase
    .from("agent_jobs")
    .update({
      status: "running",
      worker_id: WORKER_ID,
      started_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", job.id)
    .eq("status", "queued")
    .select("*")
    .single()
  if (updateError) return null
  return updated
}

async function finishJob(job, payload) {
  const update =
    payload.loginRequired === true
      ? {
          status: "login_required",
          error: payload.message,
          completed_at: new Date().toISOString(),
        }
      : {
          status: "completed",
          result: payload.result,
          error: null,
          completed_at: new Date().toISOString(),
        }
  const { error } = await supabase.from("agent_jobs").update(update).eq("id", job.id)
  if (error) throw error
}

async function failJob(job, err) {
  const message = err instanceof Error ? err.message : "Unknown worker error"
  await supabase
    .from("agent_jobs")
    .update({
      status: "failed",
      error: message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id)
}

async function processJob(context, job) {
  if (job.type === "browser_agent_task" && job.input?.kind === "agent_brief_request") {
    return finishJob(job, {
      result: {
        source: "local_browser",
        kind: "agent_brief_request",
        scannedAt: new Date().toISOString(),
        summary:
          "Agent brief request recorded. Awaiting Claude/Codex MCP scanners to post fresh items to ODIN /ingest.",
        items: [],
        warnings: [
          "The local browser worker does not scan Slack/Gmail priority items for ODIN. Use npm run odin:post-brief after a Claude/Codex scan.",
        ],
      },
    })
  }
  if (job.type === "gmail_browser_scan") return finishJob(job, await scanGmail(context))
  if (job.type === "slack_browser_scan") return finishJob(job, await scanSlack(context, job.input ?? {}))
  if (job.type === "combined_doo_scan") {
    const [slack, gmail] = await Promise.all([scanSlack(context, job.input ?? {}), scanGmail(context)])
    if (slack.loginRequired || gmail.loginRequired) {
      return finishJob(job, {
        loginRequired: true,
        message: [slack.message, gmail.message].filter(Boolean).join(" "),
      })
    }
    return finishJob(job, {
      result: {
        source: "local_browser",
        kind: "combined",
        scannedAt: new Date().toISOString(),
        summary: "Combined browser scan completed.",
        items: [...(slack.result?.items ?? []), ...(gmail.result?.items ?? [])],
        warnings: [],
      },
    })
  }
  throw new Error(`Unsupported job type: ${job.type}`)
}

async function run({ once = false } = {}) {
  await signInWorker()
  const context = await launchContext()
  console.log(`ODIN browser worker ${WORKER_ID} started. Headless=${headless}`)
  try {
    while (true) {
      const job = await claimNextJob()
      if (job) {
        console.log(`Processing ${job.type} ${job.id}`)
        try {
          await processJob(context, job)
        } catch (err) {
          console.error(err)
          await failJob(job, err)
        }
      } else if (once) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, once ? 500 : pollMs))
    }
  } finally {
    await context.close()
  }
}

const command = process.argv[2] ?? "run"
if (command === "setup") await setup()
else if (command === "setup:chrome") await setup({ channelOverride: "chrome" })
else if (command === "once") await run({ once: true })
else if (command === "run") await run()
else if (command === "daemon") await startDaemon()
else {
  console.log(
    "Usage: npm run worker:setup | npm run worker:setup:chrome | npm run worker:run | npm run worker:once | npm run worker:daemon"
  )
  process.exitCode = 1
}
