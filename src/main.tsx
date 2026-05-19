import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, HashRouter } from "react-router-dom"
import { App } from "@/App"
import { RootErrorBoundary } from "@/components/system/RootErrorBoundary"
import { installGlobalDiagnostics } from "@/lib/diagnostics"
import "@/index.css"

installGlobalDiagnostics()

const rootEl = document.getElementById("root")
if (!rootEl) {
  throw new Error("Missing #root element in index.html")
}

const isFileProtocol = typeof window !== "undefined" && window.location.protocol === "file:"
const Router = isFileProtocol ? HashRouter : BrowserRouter

createRoot(rootEl).render(
  <StrictMode>
    <RootErrorBoundary>
      <Router>
        <App />
      </Router>
    </RootErrorBoundary>
  </StrictMode>,
)
