import { existsSync, readdirSync, renameSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

cleanupDuplicateViteAssets()

for (const path of ["dist", "release"]) {
  if (!existsSync(path)) {
    continue
  }

  if (process.platform === "darwin") {
    try {
      execFileSync("xattr", ["-cr", path], { stdio: "ignore" })
    } catch {
      // Best effort: stale FileProvider/Finder metadata should not block cleanup.
    }
  }

  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

function cleanupDuplicateViteAssets() {
  const assetsDir = join("dist", "assets")
  if (!existsSync(assetsDir)) return

  for (const file of readdirSync(assetsDir)) {
    const match = file.match(/^(.*)\s+\d+(\.[^.]+)$/)
    if (!match) continue

    const canonicalName = `${match[1]}${match[2]}`
    const duplicatePath = join(assetsDir, file)
    const canonicalPath = join(assetsDir, canonicalName)

    if (existsSync(canonicalPath)) {
      rmSync(duplicatePath, { force: true })
      continue
    }

    renameSync(duplicatePath, canonicalPath)
  }
}
