const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
} = require("electron")
const path = require("node:path")
const fs = require("node:fs")
const http = require("node:http")
const { spawn } = require("node:child_process")
const { pathToFileURL } = require("node:url")

const LOCAL_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5174",
  "http://localhost:5174",
  "http://127.0.0.1:5175",
  "http://localhost:5175",
  "http://127.0.0.1:5176",
  "http://localhost:5176",
])

const ODIN_PROTOCOL = "odin"
const DEFAULT_DESKTOP_ROUTE = "/dashboard?portal=open"
const DEFAULT_DEV_DESKTOP_URL = "http://127.0.0.1:5173/dashboard?portal=open"
const WINDOW_STATE_FILE = "odin-desktop-window.json"
const NOTCH_SESSION_FILE = "odin-notch-session.json"
const DIAG_LOG_FILE = "odin-diag.log"
const DIAG_LOG_MAX_BYTES = 256 * 1024
const ISLAND_TOP_OFFSET = 0
const ISLAND_WINDOW_LEVEL = "screen-saver"
const NATIVE_ISLAND_HOST_NAME = "OdinNotchHost"

let mainWindow = null
let islandWindow = null
let islandHostProcess = null
let islandStaticServer = null
let islandStaticServerUrl = null
let nativeIslandVisible = false
let suppressIslandHostRestart = false
let nativeIslandRestartTimer = null
let tray = null
let wakeMuted = false
let isQuitting = false
let pendingProtocolRoute = null
let nativeNotchGeometry = null
let latestMusicState = null

const ISLAND_COMPACT_SIZE = 44
const ISLAND_COMPACT_GAP = 16
const ISLAND_EXPANDED_MIN_WIDTH = 840
const ISLAND_EXPANDED_MAX_WIDTH = 920
const ISLAND_EXPANDED_HORIZONTAL_MARGIN = 80
const ISLAND_EXPANDED_HEIGHT = 218

const ISLAND_WINDOW_SIZE = {
  width: ISLAND_COMPACT_SIZE,
  height: ISLAND_COMPACT_SIZE,
  minWidth: ISLAND_COMPACT_SIZE,
  minHeight: ISLAND_COMPACT_SIZE,
  maxWidth: ISLAND_EXPANDED_MAX_WIDTH,
  maxHeight: ISLAND_EXPANDED_HEIGHT,
}

const REQUEST_PERMISSIONS_AT_BOOT = process.env.ODIN_REQUEST_PERMISSIONS_AT_BOOT === "1"

const ISLAND_SIZE_MODES = {
  idle: { width: ISLAND_COMPACT_SIZE, height: ISLAND_COMPACT_SIZE },
  calendar: { width: ISLAND_COMPACT_SIZE, height: ISLAND_COMPACT_SIZE },
  priority: { width: ISLAND_COMPACT_SIZE, height: ISLAND_COMPACT_SIZE },
  health: { width: ISLAND_COMPACT_SIZE, height: ISLAND_COMPACT_SIZE },
  music: { width: ISLAND_COMPACT_SIZE, height: ISLAND_COMPACT_SIZE },
  tray: { width: ISLAND_EXPANDED_MAX_WIDTH, height: ISLAND_EXPANDED_HEIGHT },
}

process.env.ODIN_DESKTOP_PACKAGED = app.isPackaged ? "1" : "0"

function safeParseInt(value, fallback) {
  const next = Number.parseInt(value, 10)
  return Number.isFinite(next) ? next : fallback
}

function getWindowStatePath() {
  try {
    return path.join(app.getPath("userData"), WINDOW_STATE_FILE)
  } catch {
    return null
  }
}

function getNotchSessionPath() {
  try {
    return path.join(app.getPath("userData"), NOTCH_SESSION_FILE)
  } catch {
    return path.join(process.cwd(), NOTCH_SESSION_FILE)
  }
}

function getDiagLogPath() {
  try {
    return path.join(app.getPath("userData"), DIAG_LOG_FILE)
  } catch {
    return path.join(process.cwd(), DIAG_LOG_FILE)
  }
}

function rotateDiagLogIfNeeded(file) {
  try {
    const stat = fs.statSync(file)
    if (stat.size <= DIAG_LOG_MAX_BYTES) return
    fs.renameSync(file, `${file}.1`)
  } catch {
    // No log yet or rotation failed; either is fine.
  }
}

function appendDiagEntry(entry) {
  const file = getDiagLogPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    rotateDiagLogIfNeeded(file)
    const payload =
      entry && typeof entry === "object"
        ? entry
        : { ts: new Date().toISOString(), source: "main", message: String(entry ?? "") }
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 })
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function writeMainErrorLog(kind, err) {
  const description = err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : typeof err === "string"
      ? { message: err }
      : { message: JSON.stringify(err) }
  appendDiagEntry({
    ts: new Date().toISOString(),
    source: `main:${kind}`,
    ...description,
  })
}

process.on("uncaughtException", (err) => writeMainErrorLog("uncaughtException", err))
process.on("unhandledRejection", (reason) => writeMainErrorLog("unhandledRejection", reason))

function normalizeNotchSession(sessionPayload) {
  if (!sessionPayload || typeof sessionPayload !== "object") return null
  const accessToken = typeof sessionPayload.access_token === "string" ? sessionPayload.access_token : ""
  const refreshToken = typeof sessionPayload.refresh_token === "string" ? sessionPayload.refresh_token : ""
  if (!accessToken || !refreshToken) return null
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    user: sessionPayload.user && typeof sessionPayload.user === "object" ? sessionPayload.user : null,
  }
}

function writeNotchSession(sessionPayload) {
  const file = getNotchSessionPath()
  const normalized = normalizeNotchSession(sessionPayload)
  try {
    if (!normalized) {
      fs.rmSync(file, { force: true })
      return { ok: true, path: file, empty: true }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(normalized), { mode: 0o600 })
    return { ok: true, path: file, empty: false }
  } catch (error) {
    return { ok: false, path: file, error: error instanceof Error ? error.message : String(error) }
  }
}

function loadWindowState() {
  const file = getWindowStatePath()
  if (!file) return null

  try {
    const raw = fs.readFileSync(file, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null

    const x = safeParseInt(parsed.x, NaN)
    const y = safeParseInt(parsed.y, NaN)
    const width = safeParseInt(parsed.width, NaN)
    const height = safeParseInt(parsed.height, NaN)

    return {
      x: Number.isFinite(x) ? x : undefined,
      y: Number.isFinite(y) ? y : undefined,
      width: Number.isFinite(width) ? Math.max(900, width) : 1440,
      height: Number.isFinite(height) ? Math.max(700, height) : 920,
      isMaximized: Boolean(parsed.isMaximized),
      route: safeRoute(typeof parsed.route === "string" ? parsed.route : undefined),
    }
  } catch {
    return null
  }
}

function loadStartupState() {
  const state = loadWindowState()
  if (!state || !state.width || !state.height) return null
  return state
}

function routeFromWebUrl(rawUrl = "") {
  try {
    const splitHash = rawUrl.split("#")[1]
    if (splitHash) return safeRoute(decodeURIComponent(splitHash))

    const parsed = new URL(rawUrl)
    return safeRoute(`${parsed.pathname}${parsed.search}`)
  } catch {
    return DEFAULT_DESKTOP_ROUTE
  }
}

function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const file = getWindowStatePath()
  if (!file) return

  const bounds = mainWindow.getBounds()
  const nextState = {
    ...bounds,
    isMaximized: mainWindow.isMaximized(),
    route: routeFromWebUrl(mainWindow.webContents.getURL()),
    updatedAt: new Date().toISOString(),
    wakeMuted,
  }

  try {
    fs.writeFileSync(file, JSON.stringify(nextState), "utf8")
  } catch {
    // Persisting window state is best-effort.
  }
}

let windowStateWriteTimer = null

function scheduleWindowStateSave() {
  if (windowStateWriteTimer) {
    clearTimeout(windowStateWriteTimer)
  }
  windowStateWriteTimer = setTimeout(() => {
    persistWindowState()
    windowStateWriteTimer = null
  }, 250)
}

function attachWindowStatePersistence(win) {
  const events = ["resize", "move", "maximize", "unmaximize", "restore"]
  for (const event of events) {
    win.on(event, scheduleWindowStateSave)
  }
  win.on("close", persistWindowState)
}

function routeForDesktopAction(action) {
  if (action === "scan") return "/dashboard?portal=open&action=scan"
  if (action === "brief") return "/dashboard?portal=open&action=brief"
  if (action === "hub") return DEFAULT_DESKTOP_ROUTE
  if (action === "ops") return DEFAULT_DESKTOP_ROUTE
  return DEFAULT_DESKTOP_ROUTE
}

function executeTrayAction(action) {
  const route = routeForDesktopAction(action)
  if (!route) return
  openMainRoute(route)
}

function loginAtBootEnabled() {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

function toggleLaunchAtLogin() {
  try {
    const enabled = loginAtBootEnabled()
    app.setLoginItemSettings({ openAtLogin: !enabled })
  } catch {
    // Non-fatal.
  }
}

const isLocalOdinUrl = (rawUrl = "") => {
  try {
    const url = new URL(rawUrl)
    return LOCAL_ORIGINS.has(url.origin) || url.protocol === "file:"
  } catch {
    return false
  }
}

const isOdinProtocolUrl = (rawUrl = "") => {
  try {
    return new URL(rawUrl).protocol === `${ODIN_PROTOCOL}:`
  } catch {
    return false
  }
}

const microphoneStatus = () => {
  if (process.platform !== "darwin") return "unknown"
  return systemPreferences.getMediaAccessStatus("microphone")
}

function desktopBaseOrigin() {
  const targetUrl = process.env.ODIN_DESKTOP_URL || DEFAULT_DEV_DESKTOP_URL
  try {
    const url = new URL(targetUrl)
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin
  } catch {
    // Fall through to the dev origin.
  }
  return "http://127.0.0.1:5173"
}

function safeRoute(route) {
  if (typeof route !== "string") return DEFAULT_DESKTOP_ROUTE
  if (!route.startsWith("/") || route.startsWith("//")) return DEFAULT_DESKTOP_ROUTE
  return route
}

function withPortalOpen(route) {
  const [pathname, rawSearch = ""] = safeRoute(route).split("?")
  if (pathname !== "/dashboard") return safeRoute(route)
  const params = new URLSearchParams(rawSearch)
  params.set("portal", "open")
  const search = params.toString()
  return search ? `${pathname}?${search}` : DEFAULT_DESKTOP_ROUTE
}

function startupRoute(route) {
  const next = safeRoute(route)
  if (next === "/login") return next
  if (next.startsWith("/dashboard")) return withPortalOpen(next)
  return DEFAULT_DESKTOP_ROUTE
}

function routeFromOdinProtocol(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== `${ODIN_PROTOCOL}:`) return null
    const encodedRoute = url.hostname === "open"
      ? `${url.pathname || DEFAULT_DESKTOP_ROUTE}${url.search}`
      : `/${url.hostname}${url.pathname === "/" ? "" : url.pathname}${url.search}`
    const decodedRoute = decodeURIComponent(encodedRoute)
    if (url.hostname === "open") {
      return safeRoute(decodedRoute || DEFAULT_DESKTOP_ROUTE)
    }
    return safeRoute(decodedRoute)
  } catch {
    return null
  }
}

function packagedRouteUrl(route) {
  const indexUrl = pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).toString()
  return `${indexUrl}#${safeRoute(route)}`
}

function routeUrl(route) {
  if (app.isPackaged) return packagedRouteUrl(route)
  return `${desktopBaseOrigin()}${safeRoute(route)}`
}

function islandMimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8"
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8"
  if (filePath.endsWith(".svg")) return "image/svg+xml"
  if (filePath.endsWith(".png")) return "image/png"
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg"
  if (filePath.endsWith(".webp")) return "image/webp"
  if (filePath.endsWith(".woff")) return "font/woff"
  if (filePath.endsWith(".woff2")) return "font/woff2"
  return "application/octet-stream"
}

async function readMainMusicState() {
  if (latestMusicState && typeof latestMusicState === "object") {
    return latestMusicState
  }
  if (!mainWindow || mainWindow.isDestroyed()) return null
  try {
    const raw = await mainWindow.webContents.executeJavaScript(
      'window.localStorage.getItem("odin.music.surface.v1")',
      true
    )
    if (typeof raw !== "string" || !raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    return parsed
  } catch {
    return null
  }
}

function startIslandStaticServer() {
  if (islandStaticServerUrl) return Promise.resolve(islandStaticServerUrl)

  return new Promise((resolve, reject) => {
    const distRoot = path.join(app.getAppPath(), "dist")
    const server = http.createServer((request, response) => {
      try {
        const parsedUrl = new URL(request.url || "/", "http://127.0.0.1")
        if (parsedUrl.pathname === "/__odin/music-state") {
          void readMainMusicState().then((state) => {
            response.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            })
            response.end(JSON.stringify({ ok: true, state }))
          }).catch(() => {
            response.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            })
            response.end(JSON.stringify({ ok: true, state: null }))
          })
          return
        }

        let pathname = decodeURIComponent(parsedUrl.pathname)
        if (pathname === "/" || !path.extname(pathname)) {
          pathname = "/index.html"
        }

        const normalizedPath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "")
        const filePath = path.join(distRoot, normalizedPath)
        if (!filePath.startsWith(distRoot)) {
          response.writeHead(403)
          response.end("Forbidden")
          return
        }

        fs.readFile(filePath, (error, data) => {
          if (error) {
            response.writeHead(404)
            response.end("Not found")
            return
          }
          response.writeHead(200, {
            "Content-Type": islandMimeType(filePath),
            "Cache-Control": "no-store",
          })
          response.end(data)
        })
      } catch {
        response.writeHead(500)
        response.end("ODIN island host error")
      }
    })

    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("ODIN island static server did not return a TCP address."))
        return
      }
      islandStaticServer = server
      islandStaticServerUrl = `http://127.0.0.1:${address.port}`
      resolve(islandStaticServerUrl)
    })
  })
}

function stopIslandStaticServer() {
  if (!islandStaticServer) return
  islandStaticServer.close()
  islandStaticServer = null
  islandStaticServerUrl = null
}

function loadRoute(win, route) {
  void win.loadURL(routeUrl(route))
}

function openProtocolRoute(route) {
  if (!route) return
  const normalizedRoute = safeRoute(route)
  if (!app.isReady()) {
    pendingProtocolRoute = normalizedRoute
    return
  }
  openMainRoute(normalizedRoute)

  const queryStart = normalizedRoute.indexOf("?")
  const query = queryStart >= 0 ? normalizedRoute.slice(queryStart + 1) : ""
  const voiceCommand = new URLSearchParams(query).get("voice")
  if (voiceCommand === "start" || voiceCommand === "stop") {
    setTimeout(() => {
      sendToMain("odin:voice-command", { command: voiceCommand })
    }, 200 + 20)
  }
}

async function requestMicrophoneAccess() {
  if (process.platform !== "darwin") return true
  if (microphoneStatus() === "granted") return true
  return await systemPreferences.askForMediaAccess("microphone")
}

function permissionSnapshot() {
  return {
    platform: process.platform,
    microphone: microphoneStatus(),
  }
}

async function requestRequiredPermissions() {
  const snapshot = permissionSnapshot()
  if (snapshot.platform !== "darwin") return snapshot
  if (snapshot.microphone === "granted") return snapshot
  await requestMicrophoneAccess()
  return permissionSnapshot()
}

function configureMediaPermissions() {
  const filter = ({ requestingUrl, embeddingOrigin }) =>
    isLocalOdinUrl(requestingUrl) || isLocalOdinUrl(embeddingOrigin)

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === "media" && filter(details ?? {})) {
      if (process.platform !== "darwin") {
        callback(true)
        return
      }
      callback(microphoneStatus() === "granted")
      return
    }
    callback(false)
  })

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission !== "media") return false
    return filter({
      requestingUrl: requestingOrigin,
      embeddingOrigin: details?.embeddingOrigin,
    })
  })
}

function configureNavigation(win) {
  win.webContents.on("will-navigate", (event, url) => {
    const protocolRoute = routeFromOdinProtocol(url)
    if (protocolRoute) {
      event.preventDefault()
      openProtocolRoute(protocolRoute)
      return
    }
    if (app.isPackaged && !isLocalOdinUrl(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    const protocolRoute = routeFromOdinProtocol(url)
    if (protocolRoute) {
      openProtocolRoute(protocolRoute)
      return { action: "deny" }
    }
    if (isLocalOdinUrl(url)) return { action: "allow" }
    void shell.openExternal(url)
    return { action: "deny" }
  })
}

function createMainWindow(initialRoute = DEFAULT_DESKTOP_ROUTE, options = {}) {
  const startupState = pendingProtocolRoute ? null : loadStartupState()
  const resolvedRoute = pendingProtocolRoute
    ? safeRoute(pendingProtocolRoute)
    : startupRoute(startupState?.route || initialRoute)
  const showOnReady = Boolean(options.showOnReady)
  const win = new BrowserWindow({
    x: startupState?.x,
    y: startupState?.y,
    width: startupState?.width || 1440,
    height: startupState?.height || 920,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: "#030608",
    show: false,
    title: "ODIN by GUMAPAC",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  })

  mainWindow = win
  if (startupState?.isMaximized) {
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.maximize()
    })
  }

  win.once("ready-to-show", () => {
    if (!win.isDestroyed() && showOnReady) win.show()
  })
  attachWindowStatePersistence(win)

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null
    hideIslandWindow()
  })

  configureNavigation(win)
  loadRoute(win, resolvedRoute)

  if (pendingProtocolRoute) {
    pendingProtocolRoute = null
  }

  return win
}

function showOrCreateMainWindow(route = DEFAULT_DESKTOP_ROUTE) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(route, { showOnReady: true })
    return
  }
  mainWindow.show()
}

function fallbackIslandGeometry() {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.bounds
  return {
    notchX: 0,
    notchY: 0,
    notchWidth: 0,
    notchHeight: 0,
    leftSafeWidth: width / 2,
    rightSafeWidth: width / 2,
    menuBarHeight: 0,
    screenWidth: width,
    screenHeight: height,
    hasNotch: false,
  }
}

function currentIslandGeometry() {
  return nativeNotchGeometry || fallbackIslandGeometry()
}

function islandSizeForMode(mode, width, height) {
  const base = ISLAND_SIZE_MODES[mode] || ISLAND_SIZE_MODES.idle
  const geometry = currentIslandGeometry()
  const expandedTargetWidth = Math.round(
    Math.max(
      ISLAND_EXPANDED_MIN_WIDTH,
      Math.min(ISLAND_EXPANDED_MAX_WIDTH, geometry.screenWidth * 0.52)
    )
  )
  const maxExpandedByDisplay = Math.max(
    ISLAND_COMPACT_SIZE,
    Math.round(geometry.screenWidth - ISLAND_EXPANDED_HORIZONTAL_MARGIN)
  )
  const maxWidth = mode === "tray"
    ? Math.min(expandedTargetWidth, maxExpandedByDisplay)
    : Math.min(ISLAND_WINDOW_SIZE.maxWidth, geometry.screenWidth)
  const baseWidth = mode === "tray" ? maxWidth : base.width
  const baseHeight = mode === "tray" ? ISLAND_EXPANDED_HEIGHT : base.height
  return {
    width: Math.round(Math.min(maxWidth, Math.max(ISLAND_WINDOW_SIZE.minWidth, Number(width) || baseWidth))),
    height: Math.round(Math.min(ISLAND_WINDOW_SIZE.maxHeight, Math.max(ISLAND_WINDOW_SIZE.minHeight, Number(height) || baseHeight))),
  }
}

function positionIslandWindow(size) {
  if (nativeIslandVisible) return
  if (!islandWindow || islandWindow.isDestroyed()) return
  const display = screen.getPrimaryDisplay()
  const current = islandWindow.getBounds()
  const nextSize = size || { width: current.width, height: current.height }
  const { x, y, width } = display.bounds
  const geometry = currentIslandGeometry()
  const isExpandedIsland = nextSize.width > ISLAND_COMPACT_SIZE || nextSize.height > ISLAND_COMPACT_SIZE
  const nextX = isExpandedIsland
    ? x + ((geometry.screenWidth - nextSize.width) / 2)
    : geometry.hasNotch
      ? x + geometry.notchX - ISLAND_COMPACT_GAP - nextSize.width
      : x + ((width - nextSize.width) / 2)
  const nextY = y
  islandWindow.setBounds({
    x: Math.round(nextX),
    y: Math.round(nextY),
    width: nextSize.width,
    height: nextSize.height,
  })
}

function resizeIslandWindow(mode, width, height) {
  if (!islandWindow || islandWindow.isDestroyed()) return false
  const size = islandSizeForMode(mode, width, height)
  positionIslandWindow(size)
  if (!islandWindow.isVisible()) islandWindow.showInactive()
  return true
}

function userPathForKey(pathKey) {
  const home = app.getPath("home")
  if (pathKey === "downloads") return app.getPath("downloads")
  if (pathKey === "documents") return app.getPath("documents")
  if (pathKey === "screenshots") return path.join(home, "Desktop")
  if (pathKey === "recent") return app.getPath("downloads")
  return app.getPath("downloads")
}

async function openUserPath(pathKey) {
  if (typeof pathKey === "string" && path.isAbsolute(pathKey)) {
    const result = await shell.openPath(pathKey)
    if (result) throw new Error(result)
    return true
  }
  const targetPath = userPathForKey(pathKey)
  const result = await shell.openPath(targetPath)
  if (result) throw new Error(result)
  return true
}

function nativeIslandHostPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, NATIVE_ISLAND_HOST_NAME)
  }
  return path.join(__dirname, "native", "build", NATIVE_ISLAND_HOST_NAME)
}

function canUseNativeIslandHost() {
  return process.platform === "darwin" && fs.existsSync(nativeIslandHostPath())
}

function isNativeIslandHostRunning() {
  return Boolean(islandHostProcess && !islandHostProcess.killed && nativeIslandVisible)
}

function handleNativeIslandOutput(chunk, streamName) {
  const text = String(chunk || "")
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    console.log(`[OdinNotchHost:${streamName}] ${line}`)
    const match = line.match(/ODIN_NOTCH_GEOMETRY\s+reason=\S+\s+({.*})$/)
    if (!match) continue
    try {
      nativeNotchGeometry = JSON.parse(match[1])
    } catch (error) {
      console.warn("[OdinNotchHost] Failed to parse NotchGeometry", error)
    }
  }
}

function scheduleNativeIslandHostRestart() {
  if (isQuitting || suppressIslandHostRestart) return
  if (nativeIslandRestartTimer) {
    clearTimeout(nativeIslandRestartTimer)
    nativeIslandRestartTimer = null
  }
  nativeIslandRestartTimer = setTimeout(() => {
    nativeIslandRestartTimer = null
    if (!isQuitting && !suppressIslandHostRestart && !isNativeIslandHostRunning()) {
      void showIslandWindow()
    }
  }, 850)
}

async function startNativeIslandHost() {
  if (!canUseNativeIslandHost()) return false
  if (isNativeIslandHostRunning()) return true
  suppressIslandHostRestart = false

  const baseUrl = await startIslandStaticServer()
  const child = spawn(nativeIslandHostPath(), [
    "--url",
    `${baseUrl}/notch-tray`,
    "--width",
    String(ISLAND_WINDOW_SIZE.width),
    "--height",
    String(ISLAND_WINDOW_SIZE.height),
    "--session-path",
    getNotchSessionPath(),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })

  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk) => handleNativeIslandOutput(chunk, "stdout"))
  child.stderr?.on("data", (chunk) => handleNativeIslandOutput(chunk, "stderr"))
  child.stdout?.unref?.()
  child.stderr?.unref?.()

  islandHostProcess = child
  nativeIslandVisible = true
  child.once("error", () => {
    if (islandHostProcess === child) islandHostProcess = null
    nativeIslandVisible = false
    scheduleNativeIslandHostRestart()
    refreshMenus()
  })
  child.once("exit", () => {
    if (islandHostProcess === child) islandHostProcess = null
    nativeIslandVisible = false
    scheduleNativeIslandHostRestart()
    refreshMenus()
  })
  child.unref()
  refreshMenus()
  return true
}

function stopNativeIslandHost() {
  suppressIslandHostRestart = true
  if (nativeIslandRestartTimer) {
    clearTimeout(nativeIslandRestartTimer)
    nativeIslandRestartTimer = null
  }
  if (!islandHostProcess) {
    nativeIslandVisible = false
    setTimeout(() => {
      suppressIslandHostRestart = false
    }, 160)
    return
  }
  const child = islandHostProcess
  islandHostProcess = null
  nativeIslandVisible = false
  try {
    child.kill()
  } catch {
    // Best effort.
  }
  setTimeout(() => {
    suppressIslandHostRestart = false
  }, 160)
  refreshMenus()
}

function createIslandWindow() {
  if (islandWindow && !islandWindow.isDestroyed()) return islandWindow

  const win = new BrowserWindow({
    width: ISLAND_WINDOW_SIZE.width,
    height: ISLAND_WINDOW_SIZE.height,
    minWidth: ISLAND_WINDOW_SIZE.minWidth,
    minHeight: ISLAND_WINDOW_SIZE.minHeight,
    maxWidth: ISLAND_WINDOW_SIZE.maxWidth,
    maxHeight: ISLAND_WINDOW_SIZE.maxHeight,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#00000000",
    title: "ODIN Island",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  })

  islandWindow = win
  positionIslandWindow()
  win.setAlwaysOnTop(true, ISLAND_WINDOW_LEVEL)
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      positionIslandWindow()
      win.showInactive()
    }
  })

  win.on("close", (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })

  win.on("closed", () => {
    if (islandWindow === win) islandWindow = null
  })

  configureNavigation(win)

  loadRoute(win, "/notch-tray")
  return win
}

async function showIslandWindow() {
  try {
    if (await startNativeIslandHost()) {
      await new Promise((resolve) => setTimeout(resolve, 220))
      if (isNativeIslandHostRunning()) return
      stopNativeIslandHost()
    }
  } catch {
    stopNativeIslandHost()
  }

  const win = createIslandWindow()
  positionIslandWindow()
  win.showInactive()
}

function hideIslandWindow() {
  stopNativeIslandHost()
  if (!islandWindow || islandWindow.isDestroyed()) return
  islandWindow.hide()
}

function toggleIslandWindow() {
  if (isNativeIslandHostRunning()) {
    hideIslandWindow()
    return
  }
  if (islandWindow && !islandWindow.isDestroyed() && islandWindow.isVisible()) {
    hideIslandWindow()
    return
  }
  void showIslandWindow()
}

function openMainRoute(route) {
  showOrCreateMainWindow(route)
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  loadRoute(win, safeRoute(route))
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: "ODIN",
      submenu: [
        {
          label: "Open ODIN",
          click: () => openMainRoute(DEFAULT_DESKTOP_ROUTE),
        },
        {
          label: "Open Operations",
          click: () => executeTrayAction("ops"),
        },
        {
          type: "separator",
        },
        {
          label: "Run Live Scan",
          click: () => executeTrayAction("scan"),
        },
        {
          label: "Run Morning Brief",
          click: () => executeTrayAction("brief"),
        },
        { type: "separator" },
        {
          label: wakeMuted ? "Unmute Wake" : "Mute Wake",
          click: () => {
            wakeMuted = !wakeMuted
            sendToMain("odin:wake-muted", { muted: wakeMuted })
            refreshMenus()
          },
        },
        {
          label: loginAtBootEnabled() ? "Disable Launch at Login" : "Enable Launch at Login",
          click: () => {
            toggleLaunchAtLogin()
            refreshMenus()
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ])
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Open ODIN",
      click: () => openMainRoute("/dashboard?portal=open"),
    },
    {
      label: "Open Operations",
      click: () => executeTrayAction("ops"),
    },
    {
      type: "separator",
    },
    {
      label: "Run Live Scan",
      click: () => executeTrayAction("scan"),
    },
    {
      label: "Run Morning Brief",
      click: () => executeTrayAction("brief"),
    },
    { type: "separator" },
    {
      label:
        isNativeIslandHostRunning() ||
        (islandWindow && !islandWindow.isDestroyed() && islandWindow.isVisible())
          ? "Hide Island"
          : "Show Island",
      click: () => toggleIslandWindow(),
    },
    {
      label: wakeMuted ? "Unmute Wake" : "Mute Wake",
      click: () => {
        wakeMuted = !wakeMuted
        sendToMain("odin:wake-muted", { muted: wakeMuted })
        refreshMenus()
      },
    },
    { type: "separator" },
    {
      label: loginAtBootEnabled() ? "Disable Launch at Login" : "Enable Launch at Login",
      click: () => {
        toggleLaunchAtLogin()
        refreshMenus()
      },
    },
    { type: "separator" },
    {
      label: "Request Microphone Permission",
      click: () => void requestMicrophoneAccess(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ])
}

function refreshMenus() {
  Menu.setApplicationMenu(buildAppMenu())
  if (tray) {
    tray.setContextMenu(buildTrayMenu())
  }
}

function sendToMain(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  mainWindow.webContents.send(channel, payload)
  return true
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="12" fill="none" stroke="black" stroke-width="3"/>
      <circle cx="16" cy="16" r="5" fill="black"/>
      <path d="M6 16h5M21 16h5" stroke="black" stroke-width="2" stroke-linecap="round"/>
    </svg>`
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  )
  icon.setTemplateImage(true)
  return icon
}

function createTray() {
  if (tray) return tray
  tray = new Tray(createTrayIcon())
  tray.setToolTip("ODIN")
  tray.setContextMenu(buildTrayMenu())
  tray.on("click", () => toggleIslandWindow())
  return tray
}

app.setName("ODIN")
app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer")
if (app.isPackaged) {
  app.setAsDefaultProtocolClient(ODIN_PROTOCOL)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv) => {
    const protocolUrl = argv.find((arg) => isOdinProtocolUrl(arg))
    const route = protocolUrl ? routeFromOdinProtocol(protocolUrl) : null
    openProtocolRoute(route ?? DEFAULT_DESKTOP_ROUTE)
  })
}

app.on("open-url", (event, url) => {
  event.preventDefault()
  openProtocolRoute(routeFromOdinProtocol(url) ?? DEFAULT_DESKTOP_ROUTE)
})

ipcMain.handle("odin:microphone-status", () => microphoneStatus())
ipcMain.handle("odin:request-microphone-access", () => requestMicrophoneAccess())
ipcMain.handle("odin:permission-snapshot", () => permissionSnapshot())
ipcMain.handle("odin:request-required-permissions", () => requestRequiredPermissions())
ipcMain.handle("odin:open-external", (_event, url) => {
  if (typeof url === "string") void shell.openExternal(url)
})
ipcMain.handle("odin:open-route", (_event, route) => {
  openMainRoute(route)
})
ipcMain.handle("odin:session-export", (_event, sessionPayload) => writeNotchSession(sessionPayload))
ipcMain.handle("odin:open-path", (_event, pathKey) => openUserPath(pathKey))
ipcMain.handle("odin:voice-start", () => {
  openMainRoute("/dashboard?portal=open&voice=start")
  return true
})
ipcMain.handle("odin:voice-stop", () => sendToMain("odin:voice-command", { command: "stop" }))
ipcMain.handle("odin:music-state-update", (_event, payload) => {
  if (payload && typeof payload === "object") {
    latestMusicState = payload
  }
  return true
})
ipcMain.handle("odin:append-diag", (_event, payload) => appendDiagEntry(payload))

app.whenReady().then(() => {
  configureMediaPermissions()
  void showIslandWindow()
  setTimeout(() => {
    const electronIslandVisible = Boolean(
      islandWindow && !islandWindow.isDestroyed() && islandWindow.isVisible()
    )
    if (!isNativeIslandHostRunning() && !electronIslandVisible) {
      void showIslandWindow()
    }
  }, 1200)
  createTray()
  if (REQUEST_PERMISSIONS_AT_BOOT) {
    void requestRequiredPermissions()
  }
  if (pendingProtocolRoute) {
    const route = pendingProtocolRoute
    pendingProtocolRoute = null
    openProtocolRoute(route)
  }
  screen.on("display-metrics-changed", positionIslandWindow)
  screen.on("display-added", positionIslandWindow)
  screen.on("display-removed", positionIslandWindow)
  refreshMenus()

  app.on("activate", () => {
    positionIslandWindow()
    void showIslandWindow()
  })
})

app.on("before-quit", () => {
  isQuitting = true
  stopNativeIslandHost()
  stopIslandStaticServer()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
