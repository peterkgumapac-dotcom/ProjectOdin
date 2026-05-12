import type { ReactNode } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { AuthProvider, useAuth } from "@/hooks/useAuth"
import { Login } from "@/pages/Login"
import { Dashboard } from "@/pages/Dashboard"

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
      Loading...
    </div>
  )
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!session) return <Navigate to="/login" replace />
  return <>{children}</>
}

function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (session) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="/login"
          element={
            <RedirectIfAuthed>
              <Login />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  )
}
