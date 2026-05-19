import electronPath from "electron"
import { spawn } from "node:child_process"

const rootUrl = process.env.ODIN_DESKTOP_DEV_URL ?? "http://127.0.0.1:5173"
const dashboardUrl = `${rootUrl}/dashboard`

async function waitForVite(url, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return false
}

async function hasServer(url) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

const viteAlreadyRunning = await hasServer(rootUrl)
let viteProcess = null

if (!viteAlreadyRunning) {
  viteProcess = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173"],
    {
      stdio: "inherit",
    }
  )

  const ready = await waitForVite(rootUrl)
  if (!ready) {
    viteProcess.kill()
    throw new Error("ODIN Desktop could not start the Vite dev server.")
  }
}

const electronProcess = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: {
    ...process.env,
    ODIN_DESKTOP_URL: dashboardUrl,
  },
})

function stopChild(child) {
  if (!child || child.killed) return
  child.kill()
}

electronProcess.on("exit", (code) => {
  stopChild(viteProcess)
  process.exit(code ?? 0)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopChild(electronProcess)
    stopChild(viteProcess)
  })
}
