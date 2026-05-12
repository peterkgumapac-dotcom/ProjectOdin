# Jarvis Control Center

Personal command center aggregating Gmail (multi-account), Slack (multi-workspace), Google Calendar, and personal routines into one dashboard with voice and text interfaces.

## Stack
React + Vite + TypeScript + Tailwind + shadcn/ui frontend. Supabase for Postgres, Auth, Edge Functions, Realtime. Anthropic Claude API for NLU. Web Speech API for voice. Vercel hosting.

## Structure
/src/components, /src/pages, /src/lib (supabaseClient.ts, claudeClient.ts), /src/hooks, /src/types
/supabase/migrations, /supabase/functions

## Style
TypeScript strict mode, functional components, named exports. Tailwind utilities, shadcn/ui primitives. No em dashes, no bullet points in user-facing copy.

## Current Phase
Phase 1: Foundation. Vite scaffold, Supabase auth, login screen, dashboard skeleton with four sections (Email, Slack, Calendar, Today).

## Database Tables
users, connected_accounts, emails, slack_messages, calendar_events, personal_routines, priority_rules. RLS scoped by user_id.

## Security
ANTHROPIC_API_KEY is server-side only. Never expose via VITE_ prefix. All Claude calls go through Supabase Edge Functions, not the browser.

## TODOs
