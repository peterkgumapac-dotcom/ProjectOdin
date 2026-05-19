import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

const appName = "ODIN.app"
const installDir = process.env.ODIN_DESKTOP_APP_DIR ?? join(homedir(), "Applications", "ODIN-dev")
const installedApp = join(installDir, appName)
const stageDir = join(tmpdir(), `odin-pack-stage-${process.pid}`)
const stagedBuilderApp = join(stageDir, "release", "mac-arm64", appName)

run(process.execPath, ["scripts/clean-desktop-output.mjs"])
run("npm", ["run", "build"])
buildNativeNotchHost()
stabilizeDistAssets()
createPackagingStage(stageDir)
run(
  join("node_modules", ".bin", "electron-builder"),
  ["--mac", "--dir", "--publish=never", "--config.mac.identity=null", "--config.mac.sign=false"],
  { cwd: stageDir, env: { ...process.env, COPYFILE_DISABLE: "1" } }
)

if (!existsSync(stagedBuilderApp)) {
  throw new Error(`Expected ${stagedBuilderApp} to exist after electron-builder finished.`)
}

mkdirSync(installDir, { recursive: true })
removePath(installedApp)
run("ditto", ["--norsrc", "--noextattr", stagedBuilderApp, installedApp])
scrubMacMetadata(installedApp)
run("codesign", [
  "--force",
  "--deep",
  "--sign",
  "-",
  "--options",
  "runtime",
  "--entitlements",
  "electron/entitlements.mac.plist",
  installedApp,
])
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", installedApp])
removePath(stageDir)

console.log(`Packaged ODIN development app: ${installedApp}`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`)
  }
}

function removePath(path) {
  if (!existsSync(path)) return
  scrubMacMetadata(path)
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

function scrubMacMetadata(root) {
  if (process.platform !== "darwin" || !existsSync(root)) return

  try {
    execFileSync("xattr", ["-cr", root], { stdio: "ignore" })
  } catch {
    // Continue with targeted cleanup below.
  }

  for (const attr of [
    "com.apple.FinderInfo",
    "com.apple.fileprovider.fpfs#P",
    "com.apple.provenance",
    "com.apple.macl",
  ]) {
    let output = ""
    try {
      output = execFileSync("find", [root, "-xattrname", attr, "-print0"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      continue
    }
    for (const item of output.split("\0").filter(Boolean)) {
      try {
        execFileSync("xattr", ["-d", attr, item], { stdio: "ignore" })
      } catch {
        // FileProvider may reattach some metadata inside synced folders.
      }
    }
  }
}

function cleanupDuplicateViteAssets() {
  const assetsDir = join(process.cwd(), "dist", "assets")
  if (!existsSync(assetsDir)) return

  for (const file of readdirSync(assetsDir)) {
    const match = file.match(/^(.*)\s+\d+(\.[^.]+)$/)
    if (!match) continue

    const canonicalName = `${match[1]}${match[2]}`
    const duplicatePath = join(assetsDir, file)
    const canonicalPath = join(assetsDir, canonicalName)

    if (existsSync(canonicalPath)) {
      removePath(duplicatePath)
      continue
    }

    renameSync(duplicatePath, canonicalPath)
  }
}

function stabilizeDistAssets() {
  const distDir = join(process.cwd(), "dist")
  const assetsDir = join(distDir, "assets")
  if (!existsSync(distDir) || !existsSync(assetsDir)) return

  let stablePasses = 0
  for (let pass = 0; pass < 8; pass += 1) {
    cleanupDuplicateViteAssets()
    restoreKnownMissingAssets(assetsDir)
    const missing = findMissingAssetReferences(distDir, assetsDir)
    if (missing.length === 0) {
      stablePasses += 1
      if (stablePasses >= 2) return
    } else {
      stablePasses = 0
      if (pass === 3) {
        // OneDrive/FileProvider can mutate build output; rerun once if refs are still broken.
        run("npm", ["run", "build"])
      }
    }
    sleep(220)
  }

  const missing = findMissingAssetReferences(distDir, assetsDir)
  if (missing.length > 0) {
    throw new Error(`Missing dist/assets references before packaging: ${missing.slice(0, 8).join(", ")}`)
  }
}

function createPackagingStage(targetDir) {
  removePath(targetDir)
  mkdirSync(targetDir, { recursive: true })

  for (const item of ["package.json", "package-lock.json", "electron", "scripts", "dist", "node_modules"]) {
    if (item === "dist") ensureDistReady()
    copyIntoStage(item, targetDir)
  }
}

function ensureDistReady() {
  const distDir = join(process.cwd(), "dist")
  const assetsDir = join(distDir, "assets")
  const indexPath = join(distDir, "index.html")
  if (existsSync(distDir) && existsSync(assetsDir) && existsSync(indexPath)) return

  run("npm", ["run", "build"])
  stabilizeDistAssets()
  if (!existsSync(distDir) || !existsSync(assetsDir) || !existsSync(indexPath)) {
    throw new Error("dist was not available after rebuilding for desktop packaging.")
  }
}

function buildNativeNotchHost() {
  if (process.platform !== "darwin") return

  const sourceDir = join(process.cwd(), "electron", "native")
  const sources = readdirSync(sourceDir)
    .filter((file) => file.endsWith(".swift"))
    .map((file) => join(sourceDir, file))
    .sort()
  const outputDir = join(process.cwd(), "electron", "native", "build")
  const output = join(outputDir, "OdinNotchHost")

  if (!sources.some((source) => source.endsWith("OdinNotchHost.swift"))) {
    throw new Error(`Missing native notch host source in ${sourceDir}`)
  }

  mkdirSync(outputDir, { recursive: true })
  run("swiftc", [
    ...sources,
    "-o",
    output,
    "-framework",
    "AppKit",
    "-framework",
    "QuartzCore",
    "-framework",
    "SwiftUI",
    "-framework",
    "WebKit",
  ])
  run("chmod", ["755", output])
}

function copyIntoStage(sourceRelativePath, targetDir) {
  const sourcePath = join(process.cwd(), sourceRelativePath)
  const targetPath = join(targetDir, sourceRelativePath)
  mkdirSync(dirname(targetPath), { recursive: true })
  const sourceStat = statSync(sourcePath)
  if (sourceStat.isDirectory()) {
    mkdirSync(targetPath, { recursive: true })
    run("rsync", ["-a", "--delete", `${sourcePath}/`, `${targetPath}/`])
    return
  }
  run("cp", [sourcePath, targetPath])
}

function restoreKnownMissingAssets(assetsDir) {
  for (const file of readdirSync(assetsDir)) {
    const match = file.match(/^(.*)\s+\d+(\.[^.]+)$/)
    if (!match) continue
    const canonicalName = `${match[1]}${match[2]}`
    const canonicalPath = join(assetsDir, canonicalName)
    const duplicatePath = join(assetsDir, file)
    if (existsSync(canonicalPath)) continue
    renameSync(duplicatePath, canonicalPath)
  }
}

function findMissingAssetReferences(distDir, assetsDir) {
  const references = new Set()
  const indexPath = join(distDir, "index.html")
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8")
    for (const match of html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)) {
      references.add(match[1])
    }
  }

  for (const file of readdirSync(assetsDir)) {
    if (!file.endsWith(".js")) continue
    const filePath = join(assetsDir, file)
    const content = readFileSync(filePath, "utf8")
    for (const match of content.matchAll(/\.\/([A-Za-z0-9._-]+\.(?:js|css|woff2?|svg|png|jpg|webp))/g)) {
      references.add(match[1])
    }
  }

  const missing = []
  for (const ref of references) {
    const canonicalPath = join(assetsDir, ref)
    if (existsSync(canonicalPath)) continue

    const alt = readdirSync(assetsDir).find((entry) => {
      const match = entry.match(/^(.*)\s+\d+(\.[^.]+)$/)
      return match ? `${match[1]}${match[2]}` === ref : false
    })
    if (alt) {
      renameSync(join(assetsDir, alt), canonicalPath)
      continue
    }
    missing.push(ref)
  }
  return missing
}

function sleep(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Busy wait for short stabilization windows.
  }
}
