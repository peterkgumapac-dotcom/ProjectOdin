import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const releaseRoot = "release"

run(process.execPath, ["scripts/clean-desktop-output.mjs"])
run(process.execPath, ["scripts/package-desktop-dev.mjs"])

const outputDir = findMacOutputDir(releaseRoot)
const appBundle = join(outputDir, "ODIN.app")
const zipPath = join(releaseRoot, `ODIN-${packageJson.version || "0.0.0"}-${process.arch}-mac.zip`)

if (!existsSync(appBundle)) {
  throw new Error(`Expected ${appBundle} to exist after packaging. Re-check electron-builder output.`)
}

if (existsSync(zipPath)) {
  rmSync(zipPath)
}

run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appBundle, zipPath])
console.log(`Packaged ODIN distribution zip: ${zipPath}`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`)
  }
}

function findMacOutputDir(baseDir) {
  const entries = readdirSync(baseDir, { withFileTypes: true })
  const candidates = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
  if (!candidates.length) {
    throw new Error(`Could not find mac output folder in ${baseDir}`)
  }
  return join(baseDir, (candidates.find((entry) => entry.name.includes(process.arch)) ?? candidates[0]).name)
}
