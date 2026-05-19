import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const explicitIdentity = process.env.CSC_NAME
const detectedIdentity = explicitIdentity ? null : findDeveloperIdIdentity()
const signingIdentity = explicitIdentity ?? detectedIdentity

if (!signingIdentity) {
  throw new Error(
    [
      "No Developer ID Application signing identity found.",
      "Install an Apple Developer ID Application certificate in Keychain, or run with CSC_NAME=\"Developer ID Application: ...\".",
      "Use npm run desktop:pack for the local ad-hoc signed development app.",
    ].join(" ")
  )
}

console.log(`Using macOS signing identity: ${signingIdentity}`)
run(process.execPath, ["scripts/clean-desktop-output.mjs"])
run("npm", ["run", "build"])
buildNativeNotchHost()
run("node_modules/.bin/electron-builder", ["--mac", "--publish=never"], {
  env: {
    ...process.env,
    COPYFILE_DISABLE: "1",
    CSC_NAME: signingIdentity,
  },
})

console.log("Packaged signed ODIN macOS distribution in release/.")

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

function buildNativeNotchHost() {
  if (process.platform !== "darwin") return

  const source = join(process.cwd(), "electron", "native", "OdinNotchHost.swift")
  const outputDir = join(process.cwd(), "electron", "native", "build")
  const output = join(outputDir, "OdinNotchHost")

  if (!existsSync(source)) {
    throw new Error(`Missing native notch host source: ${source}`)
  }

  mkdirSync(outputDir, { recursive: true })
  run("swiftc", [
    source,
    "-o",
    output,
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
  ])
  run("chmod", ["755", output])
}

function findDeveloperIdIdentity() {
  if (process.platform !== "darwin") return null
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  })
  if (result.status !== 0) return null
  const line = result.stdout
    .split("\n")
    .find((value) => value.includes("Developer ID Application:"))
  const match = line?.match(/"([^"]+)"/)
  return match?.[1] ?? null
}
