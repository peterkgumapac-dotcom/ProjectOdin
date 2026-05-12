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

## 2026-05-12 — Phase 4a: User profile trigger
- `handle_new_user()` function (`security definer`, owner = postgres) inserts a `public.users` row on every `auth.users` insert.
- Trigger `on_auth_user_created` after insert on `auth.users`.
- Backfill query covered any pre-existing auth users (0 at apply time).
- Migration: `supabase/migrations/20260512000100_user_profile_trigger.sql`.
- Dev server smoke: boots in 167ms, serves `<html class="dark">` with title `Jarvis Control Center`.
- Live signup smoke: `peterkgumapac@gmail.com` (id `3e44b0c2-…`) created an `auth.users` row, trigger fired, matching `public.users` row appeared with `email_confirmed = true`.

## 2026-05-12 — Phase 4b: Claude edge function
- `supabase/functions/claude/index.ts`: Deno edge function deployed to project `xbanzimrojdsskavdvkk`, status ACTIVE v2, `verify_jwt = true`.
- `ANTHROPIC_API_KEY` set as Supabase secret (server-side only).
- `src/lib/claudeClient.ts`: `invokeClaude()` browser wrapper via `supabase.functions.invoke`, typed request/response with `extractText()` helper.
- Temporary `AskClaudePanel` on the Dashboard for E2E smoke; uses a "concise Jarvis" system prompt.
- End-to-end verified in browser: prompt "how's my day look like?" returned a coherent Claude reply.
- Edge function logs show POST 200 in ~2-4 s including CORS preflight.

## 2026-05-12 — Phase 5a: chat persistence
- New table `chat_messages` (id, user_id, role, content, model, tokens_input, tokens_output, created_at). RLS-enabled with own-row select/insert/delete. No update — messages are immutable.
- Index `chat_messages_user_created_idx` on (user_id, created_at desc) for fast history loads.
- Migration: `supabase/migrations/20260512000200_chat_messages.sql`.
- TS types regenerated; `chat_messages` row + insert types now available.
- New `ChatPanel` component (`src/components/chat/ChatPanel.tsx`) replaces the temporary AskClaudePanel:
  - Loads last 30 messages on mount, ordered ascending.
  - Optimistic user-message insert, then persists, then calls Claude with last 12 messages of context, then persists the assistant reply.
  - Records model + input/output token usage.
  - "Clear history" deletes all of the user's chat rows (RLS-scoped).
  - Auto-scroll to latest message.
