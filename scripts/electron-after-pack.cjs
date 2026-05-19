const { execFileSync } = require("node:child_process")

module.exports = async function afterPack(context) {
  if (process.platform !== "darwin") {
    return
  }

  scrubMacMetadata(context.appOutDir)
}

function scrubMacMetadata(root) {
  execFileSync("xattr", ["-cr", root], { stdio: "ignore" })

  for (const attr of [
    "com.apple.FinderInfo",
    "com.apple.fileprovider.fpfs#P",
    "com.apple.provenance",
    "com.apple.macl",
  ]) {
    const result = execFileSync("find", [root, "-xattrname", attr, "-print0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    for (const item of result.split("\0").filter(Boolean)) {
      try {
        execFileSync("xattr", ["-d", attr, item], { stdio: "ignore" })
      } catch {
        // Best effort: some FileProvider attributes are reattached by macOS.
      }
    }
  }
}
