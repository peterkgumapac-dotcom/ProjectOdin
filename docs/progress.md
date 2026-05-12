# Jarvis Progress Log

## 2026-05-12 — Phase 1: Scaffold
- Vite + React 19 + TypeScript 6 + Tailwind v4 + shadcn/ui (radix-nova preset, dark mode default).
- Folder structure: src/{components,pages,lib,hooks,types,utils}, docs/, supabase/{migrations,functions}.
- Path alias `@/*` wired in tsconfig + vite.config.
- shadcn components: button, card, input, dialog, tabs.
- `.env.local.example` and `.gitignore` configured. ANTHROPIC_API_KEY flagged server-side only.

## 2026-05-12 — Phase 2: Supabase auth + dashboard skeleton
- `src/lib/supabaseClient.ts` with env validation.
- `AuthProvider` + `useAuth` hook (password sign in/up, magic link, sign out).
- `/login` page: shadcn Card + Tabs (Password / Magic link).
- `/dashboard` page: header (email + sign-out) + 2x2 grid (Email/Slack/Calendar/Today).
- Router wired: `ProtectedRoute` + `RedirectIfAuthed` guards.
- Removed Vite scaffold defaults (App.css, src/assets, public/icons.svg).
