import { extractText, invokeClaude } from "@/lib/claudeClient"
import { supabase } from "@/lib/supabaseClient"
import type { Json } from "@/types/database"
import type {
  ConnectedAccount,
  WorkflowAction,
  WorkflowRule,
  WorkflowTrigger,
} from "@/hooks/useConnectedAccounts"
import type {
  ConnectedAccountSummary,
  OnboardingAnswers,
  OnboardingDraft,
  OnboardingSourceType,
  PriorityRuleDraft,
} from "@/types/onboarding"

export const ONBOARDING_TAG = "odin_onboarding_v1"
export const ONBOARDING_RULE_PREFIX = "onboarding_"
export const ACCOUNT_FOCUS_RULE_ID = "account_focus_suppressed"

const SOURCE_TYPES = new Set<OnboardingSourceType>([
  "gmail",
  "slack",
  "calendar",
  "manual",
])

const WORKFLOW_TRIGGERS = new Set<WorkflowTrigger>([
  "new_email",
  "unread_over",
  "from_sender",
  "subject_contains",
  "to_address",
  "new_message",
  "mentioned",
  "keyword_in_channel",
  "from_user",
  "channel_unread_over",
])

const WORKFLOW_ACTIONS = new Set<WorkflowAction>([
  "notify_odin",
  "label_urgent",
  "summarize_counsel",
  "skip_inbox",
  "auto_followup",
  "highlight_channel",
])

export const DEFAULT_PRIORITY_TOPICS = [
  "Guest issues",
  "Owner approvals",
  "Vendor blockers",
  "Billables",
  "Deadlines",
  "Team updates",
]

export const DEFAULT_BUSINESSES = ["Stay Minty", "Dinbnb", "Personal"] as const

function cleanJsonText(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const firstBrace = candidate.indexOf("{")
  const lastBrace = candidate.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1)
  }
  return candidate
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return 50
  return Math.max(0, Math.min(100, Math.round(n)))
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function conditionsArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

function normalizePriorityRule(raw: unknown, index: number): PriorityRuleDraft {
  if (!isRecord(raw)) {
    throw new Error(`Priority rule ${index + 1} is not an object.`)
  }
  const sourceType = raw.source_type
  if (typeof sourceType !== "string" || !SOURCE_TYPES.has(sourceType as OnboardingSourceType)) {
    throw new Error(`Priority rule ${index + 1} has an invalid source_type.`)
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    throw new Error(`Priority rule ${index + 1} needs a name.`)
  }
  return {
    name: raw.name.trim().slice(0, 120),
    description:
      typeof raw.description === "string" ? raw.description.trim().slice(0, 500) : "",
    source_type: sourceType as OnboardingSourceType,
    conditions: conditionsArray(raw.conditions),
    priority_score: clampScore(raw.priority_score),
    action_tags: stringArray(raw.action_tags).slice(0, 8),
    notify: raw.notify !== false,
    sort_order:
      typeof raw.sort_order === "number" && Number.isFinite(raw.sort_order)
        ? Math.round(raw.sort_order)
        : index,
  }
}

function normalizeWorkflowRule(raw: unknown, index: number): WorkflowRule {
  if (!isRecord(raw)) {
    throw new Error(`Workflow rule ${index + 1} is not an object.`)
  }
  if (typeof raw.trigger !== "string" || !WORKFLOW_TRIGGERS.has(raw.trigger as WorkflowTrigger)) {
    throw new Error(`Workflow rule ${index + 1} has an invalid trigger.`)
  }
  if (typeof raw.action !== "string" || !WORKFLOW_ACTIONS.has(raw.action as WorkflowAction)) {
    throw new Error(`Workflow rule ${index + 1} has an invalid action.`)
  }
  const id =
    typeof raw.id === "string" && raw.id.trim().length > 0
      ? raw.id.trim()
      : `${ONBOARDING_RULE_PREFIX}${index + 1}`

  return {
    id: id === ACCOUNT_FOCUS_RULE_ID ? id : `${ONBOARDING_RULE_PREFIX}${id.replace(/^onboarding_/, "")}`,
    trigger: raw.trigger as WorkflowTrigger,
    condition: typeof raw.condition === "string" ? raw.condition.trim() : "",
    action: raw.action as WorkflowAction,
    enabled: raw.enabled !== false,
  }
}

export function accountFocusRule(account: ConnectedAccount): WorkflowRule {
  return {
    id: ACCOUNT_FOCUS_RULE_ID,
    trigger: account.provider === "slack" ? "new_message" : "new_email",
    condition: "account",
    action: "skip_inbox",
    enabled: true,
  }
}

export function isAccountFocusRule(rule: WorkflowRule): boolean {
  return rule.id === ACCOUNT_FOCUS_RULE_ID
}

export function isIncludedInHall(account: ConnectedAccount): boolean {
  return !account.workflowRules.some(
    (rule) =>
      rule.enabled &&
      (isAccountFocusRule(rule) ||
        (rule.action === "skip_inbox" &&
          rule.condition.toLowerCase() === "account"))
  )
}

export function summarizeAccount(account: ConnectedAccount): ConnectedAccountSummary {
  const identifier =
    account.provider === "slack"
      ? account.workspaceName ?? account.accountLabel
      : account.accountEmail ?? account.accountLabel

  return {
    id: account.id,
    provider: account.provider,
    label: account.accountLabel,
    identifier,
    workspaceName: account.workspaceName,
    includeInHall: isIncludedInHall(account),
  }
}

export function parseOnboardingDraft(
  rawText: string,
  allowedAccountIds: Set<string>
): OnboardingDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(cleanJsonText(rawText))
  } catch {
    throw new Error("The setup draft did not return valid JSON. Retry the draft.")
  }

  if (!isRecord(parsed)) {
    throw new Error("Draft JSON must be an object.")
  }

  const priorityRulesRaw = parsed.priorityRules
  const accountRulesRaw = parsed.accountRules
  if (!Array.isArray(priorityRulesRaw)) {
    throw new Error("Draft JSON is missing priorityRules.")
  }
  if (!Array.isArray(accountRulesRaw)) {
    throw new Error("Draft JSON is missing accountRules.")
  }

  const priorityRules = priorityRulesRaw
    .map(normalizePriorityRule)
    .filter((rule) => rule.name.length > 0)

  const accountRules = accountRulesRaw.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Account rule ${index + 1} is not an object.`)
    }
    if (typeof raw.accountId !== "string" || !allowedAccountIds.has(raw.accountId)) {
      throw new Error(`Account rule ${index + 1} references an unknown account.`)
    }
    if (!Array.isArray(raw.workflowRules)) {
      throw new Error(`Account rule ${index + 1} is missing workflowRules.`)
    }
    return {
      accountId: raw.accountId,
      workflowRules: raw.workflowRules.map(normalizeWorkflowRule),
    }
  })

  return { priorityRules, accountRules }
}

export function applyAccountInclusionRules(
  draft: OnboardingDraft,
  accounts: ConnectedAccount[],
  inclusion: Record<string, boolean>
): OnboardingDraft {
  const accountRules = new Map(
    draft.accountRules.map((entry) => [entry.accountId, [...entry.workflowRules]])
  )

  for (const account of accounts) {
    if (inclusion[account.id] === false) {
      const rules = accountRules.get(account.id) ?? []
      const withoutFocus = rules.filter((rule) => !isAccountFocusRule(rule))
      accountRules.set(account.id, [...withoutFocus, accountFocusRule(account)])
    }
  }

  return {
    priorityRules: draft.priorityRules,
    accountRules: Array.from(accountRules.entries()).map(
      ([accountId, workflowRules]) => ({ accountId, workflowRules })
    ),
  }
}

function buildPrompt(
  answers: OnboardingAnswers,
  accounts: ConnectedAccountSummary[]
): string {
  return JSON.stringify(
    {
      task: "Draft ODIN central operations onboarding setup.",
      output: {
        priorityRules:
          "Array of global priority rules for priority_rules. Use source_type gmail, slack, calendar, or manual.",
        accountRules:
          "Array of per-account workflow rules for connected_accounts.workflow_rules. Use only account IDs provided.",
      },
      allowedWorkflowTriggers: Array.from(WORKFLOW_TRIGGERS),
      allowedWorkflowActions: Array.from(WORKFLOW_ACTIONS),
      requiredJsonShape: {
        priorityRules: [
          {
            name: "Owner approval needed",
            description: "Owner approvals should surface before ordinary chatter.",
            source_type: "slack",
            conditions: [
              {
                field: "topic",
                op: "includes_any",
                value: ["owner approval", "signature", "deposit"],
              },
            ],
            priority_score: 90,
            action_tags: ["owner_approval"],
            notify: true,
            sort_order: 10,
          },
        ],
        accountRules: [
          {
            accountId: "connected-account-id",
            workflowRules: [
              {
                id: "onboarding_example",
                trigger: "from_sender",
                condition: "owner@example.com",
                action: "notify_odin",
                enabled: true,
              },
            ],
          },
        ],
      },
      rules: [
        "Return compact JSON only. No markdown, prose, comments, or trailing commas.",
        "Do not invent new accounts, tables, or sources.",
        "Prefer calm central operations signals, not urgent-only COO/DOO escalation language.",
        "Create high-signal rules for guest issues, owner approvals, vendor blockers, billables, deadlines, and team decisions when selected.",
        `For any includeInHall=false account, include a workflow rule with id ${ACCOUNT_FOCUS_RULE_ID}, action skip_inbox, condition account, enabled true.`,
        "Keep the draft concise: exactly 5 priorityRules and only useful accountRules.",
        "Keep every description under 120 characters and every conditions value list at 3 items or fewer.",
      ],
      answers,
      connectedAccounts: accounts,
    },
    null,
    2
  )
}

export async function generateOnboardingDraft(
  answers: OnboardingAnswers,
  accounts: ConnectedAccount[]
): Promise<OnboardingDraft> {
  const summaries = accounts.map(summarizeAccount).map((account) => ({
    ...account,
    includeInHall: answers.accountInclusion[account.id] ?? account.includeInHall,
  }))
  const result = await withTimeout(
    invokeClaude({
      temperature: 0.1,
      maxTokens: 4000,
      system:
        "You are ODIN's operations setup architect. You convert interview answers into strict JSON configuration for a central operations dashboard. Return JSON only.",
      messages: [
        {
          role: "user",
          content: buildPrompt(answers, summaries),
        },
      ],
    }),
    35_000,
    "Setup draft timed out. Retry the draft."
  )
  if (result.error) throw result.error
  if (!result.data) throw new Error("No setup draft returned.")
  const allowedIds = new Set(accounts.map((account) => account.id))
  return applyAccountInclusionRules(
    parseOnboardingDraft(extractText(result.data), allowedIds),
    accounts,
    answers.accountInclusion
  )
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

function isGeneratedWorkflowRule(rule: WorkflowRule): boolean {
  return rule.id.startsWith(ONBOARDING_RULE_PREFIX) || isAccountFocusRule(rule)
}

export async function saveOnboardingDraft(
  userId: string,
  accounts: ConnectedAccount[],
  draft: OnboardingDraft
): Promise<void> {
  const taggedRules = draft.priorityRules.map((rule, index) => ({
    user_id: userId,
    name: rule.name,
    description: rule.description,
    source_type: rule.source_type,
    conditions: [
      { generated_by: ONBOARDING_TAG },
      ...rule.conditions,
    ] as unknown as Json,
    priority_score: rule.priority_score,
    action_tags: Array.from(new Set([...rule.action_tags, ONBOARDING_TAG])),
    notify: rule.notify,
    is_active: true,
    sort_order: rule.sort_order ?? index,
  }))

  const { error: deleteError } = await supabase
    .from("priority_rules")
    .delete()
    .eq("user_id", userId)
    .contains("action_tags", [ONBOARDING_TAG])
  if (deleteError) throw new Error(deleteError.message)

  if (taggedRules.length > 0) {
    const { error: insertError } = await supabase
      .from("priority_rules")
      .insert(taggedRules)
    if (insertError) throw new Error(insertError.message)
  }

  const accountRules = new Map(
    draft.accountRules.map((entry) => [entry.accountId, entry.workflowRules])
  )

  for (const account of accounts) {
    const preserved = account.workflowRules.filter(
      (rule) => !isGeneratedWorkflowRule(rule)
    )
    const generated = accountRules.get(account.id) ?? []
    const { error: updateError } = await supabase
      .from("connected_accounts")
      .update({
        workflow_rules: [...preserved, ...generated] as unknown as Json,
      })
      .eq("id", account.id)
      .eq("user_id", userId)
    if (updateError) throw new Error(updateError.message)
  }
}
