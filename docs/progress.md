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

## 2026-05-12 — Phase 3: Postgres schema (sync + rules)
- 7 tables live in Supabase project `xbanzimrojdsskavdvkk` (jarvis-hub), all RLS-enabled, all with `set_updated_at()` trigger.
- Tables: users, connected_accounts, emails, slack_messages, calendar_events, personal_routines, priority_rules.
- Policies: 4 per table (select/insert/update/delete own), scoped by `auth.uid() = user_id` (or `id` for users).
- Indexes: per-user fast paths for received_at (emails), sent_at + channel + mention (slack), start_at + range (calendar), next_run_at where active (routines), is_active + sort_order (rules).
- Unique constraints: (user_id, provider), (user_id, message_id), (user_id, workspace_id, channel_id, message_ts), (user_id, event_id).
- Idempotent migration checked in: `supabase/migrations/20260512000000_init_schema.sql`.
- TS types generated via MCP into `src/types/database.ts`. `supabaseClient` typed with `createClient<Database>`.
