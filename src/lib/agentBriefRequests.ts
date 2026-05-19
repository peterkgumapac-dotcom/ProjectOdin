import { createAgentJob } from "@/lib/agentJobs"

export type AgentBriefRequestSource = "slack" | "gmail" | "drive"

export interface AgentBriefFocusDoc {
  title: string
  url: string
  sourceType: "drive"
  purpose: string
}

export interface AgentBriefEmailTarget {
  business: string
  agent: string
  accountHint: string
  labels?: string[]
  labelQuery?: string
  purpose: string
}

export const STAYMINTY_EMAIL_LABELS = ["stayminty"] as const

export const STAYMINTY_FOCUS_MARKETS = ["Smokies", "Nashville"] as const

export const STAYMINTY_WEEKLY_PRIORITY_DOCS: AgentBriefFocusDoc[] = [
  {
    title: "Stay Minty weekly priority source - Smokies",
    url: "https://docs.google.com/document/d/1vJx7_MAs2sR1I8mJcB70Na3tX8gr5GQq5ldFkfdiTRw/edit?tab=t.vycwuwgn3mod",
    sourceType: "drive",
    purpose:
      "Use as a current weekly source of truth for Smokies priorities, property context, guest/owner/vendor follow-ups, and open operational asks.",
  },
  {
    title: "Stay Minty weekly priority source - Nashville",
    url: "https://docs.google.com/document/d/1EoiNgrsrWXYyssEyplwVb-SErdM5GJwp21OS4FLB_Kc/edit?tab=t.1dxn6ismhzyr",
    sourceType: "drive",
    purpose:
      "Use as a current weekly source of truth for Nashville priorities, property context, guest/owner/vendor follow-ups, and open operational asks.",
  },
]

export interface QueueAgentBriefRequestArgs {
  userId: string
  requestedAt: string
  requestedBy: "dashboard_live_scan" | "council_scan" | string
  sources?: AgentBriefRequestSource[]
  scanWindowDays?: number
  businesses?: string[]
  sourceAgents?: string[]
  emailTargets?: AgentBriefEmailTarget[]
  focusDocs?: AgentBriefFocusDoc[]
  focusMarkets?: string[]
  briefObjective?: string
  instructions?: string[]
}

export async function queueAgentBriefRequest({
  userId,
  requestedAt,
  requestedBy,
  sources = ["slack", "gmail"],
  scanWindowDays = 7,
  businesses = ["stayminty", "dinbnb"],
  sourceAgents = ["claude_stayminty", "codex_dinbnb"],
  emailTargets = [
    {
      business: "stayminty",
      agent: "claude_stayminty",
      accountHint: "peter@stayminty.com",
      purpose: "Scan Peter's StayMinty Gmail and Slack surfaces for items needing Peter.",
    },
    {
      business: "dinbnb",
      agent: "codex_dinbnb",
      accountHint: "peter@dinbnb.no",
      purpose: "Scan Peter's Dinbnb Gmail and Slack surfaces for items needing Peter.",
    },
  ],
  focusDocs = [],
  focusMarkets = [],
  briefObjective = "Find only items that need Peter's decision, reply, approval, or awareness today.",
  instructions = [],
}: QueueAgentBriefRequestArgs) {
  return createAgentJob(userId, "browser_agent_task", {
    kind: "agent_brief_request",
    requestedAt,
    requestedBy,
    businesses,
    sourceAgents,
    sources,
    emailTargets,
    focusDocs,
    focusMarkets,
    scanWindowDays,
    briefObjective,
    outputContract: {
      endpoint: "/functions/v1/odin-orchestrator/ingest",
      auth: "x-odin-api-key",
      mode: "external_brief",
      requiredItemFields: [
        "business",
        "source_agent",
        "person_or_channel",
        "issue_topic",
        "why_it_needs_peter",
        "urgency",
        "next_action",
        "source_link",
        "source_type",
      ],
      acceptedSourceTypes: ["slack", "gmail", "drive"],
    },
    instructions: [
      "Scan fresh Slack and Gmail through Claude/Codex MCP access; do not reuse ODIN's last-known pending rows.",
      briefObjective,
      "Filter acknowledgements, FYIs, group chatter without asks, promos, newsletters, and stale completed work.",
      "Keep each item concise: topic, urgency, why Peter is needed, one next action, and evidence link when available.",
      "POST the structured brief to ODIN ingest immediately after scanning so the dashboard can replace stale rows.",
      ...instructions,
    ],
  })
}

export async function queueStayMintyLiveSyncRequest({
  userId,
  requestedAt,
  requestedBy,
  scanWindowDays = 7,
}: Pick<QueueAgentBriefRequestArgs, "userId" | "requestedAt" | "requestedBy" | "scanWindowDays">) {
  return queueAgentBriefRequest({
    userId,
    requestedAt,
    requestedBy,
    sources: ["slack", "gmail", "drive"],
    scanWindowDays,
    businesses: ["stayminty"],
    sourceAgents: ["claude_stayminty"],
    emailTargets: [
      {
        business: "stayminty",
        agent: "claude_stayminty",
        accountHint: "peter@stayminty.com",
        labels: [...STAYMINTY_EMAIL_LABELS],
        labelQuery: "label:stayminty newer_than:7d",
        purpose:
          "Read only Peter's Stay Minty-labeled Gmail threads by default. Use the last 7 days unless a current weekly priority doc explicitly requires older context.",
      },
    ],
    focusDocs: STAYMINTY_WEEKLY_PRIORITY_DOCS,
    focusMarkets: [...STAYMINTY_FOCUS_MARKETS],
    briefObjective:
      "Produce the current Stay Minty priority brief for Peter, focused on Smokies and Nashville, using the linked Google Docs as weekly priority anchors and Stay Minty-labeled Gmail/Slack as fresh evidence.",
    instructions: [
      "Stay Minty-only scope for this request. Do not scan Dinbnb or unrelated personal labels.",
      "Claude is the scanner for Stay Minty. ODIN must not perform its own Slack/Gmail discovery for this request.",
      "Use Claude's Slack access for Stay Minty channels, DMs, and group DMs; this is where live Slack calls should happen.",
      "Use the two Google Docs as the weekly/base-priority source of truth for Smokies and Nashville. If Google Docs conflict with Slack/Gmail, call out the conflict and prefer the newest dated evidence.",
      "Gmail scope is label:stayminty only. Do not scan All Mail or unrelated labels unless Peter explicitly asks for a deeper search.",
      "Pull email threads only when they relate to guest escalation, owner approval, vendor or maintenance, finance/billables/refund, arrival/access/check-in, cleaning/turnover, operations staffing, or coverage.",
      "Return no more than 8 priority items. Sort urgent/personal first, then time-sensitive ops, then quick actions. Put awareness-only items last.",
      "For each item include business=stayminty, source_agent=claude_stayminty, person_or_channel, issue_topic, why_it_needs_peter, urgency, next_action, source_type, and source_link when available.",
      "Use source_type=drive when an item is grounded primarily in one of the Google Docs.",
      "Do not include newsletters, promos, confirmations with no ask, closed work, or old pending rows unless the fresh scan confirms they are still open.",
    ],
  })
}
