import type {
  ConnectedAccount,
  WorkflowRule,
} from "@/hooks/useConnectedAccounts"

export type OnboardingSourceType = "gmail" | "slack" | "calendar" | "manual"

export type OnboardingBusiness = "Stay Minty" | "Dinbnb" | "Personal"

export interface PriorityRuleDraft {
  name: string
  description: string
  source_type: OnboardingSourceType
  conditions: Array<Record<string, unknown>>
  priority_score: number
  action_tags: string[]
  notify: boolean
  sort_order: number
}

export interface AccountRuleDraft {
  accountId: string
  workflowRules: WorkflowRule[]
}

export interface OnboardingDraft {
  priorityRules: PriorityRuleDraft[]
  accountRules: AccountRuleDraft[]
}

export interface AccountInclusion {
  accountId: string
  includeInHall: boolean
}

export interface OnboardingAnswers {
  businesses: OnboardingBusiness[]
  connectedSources: OnboardingSourceType[]
  importantPeople: string
  priorityTopics: string[]
  suppressions: string
  accountInclusion: Record<string, boolean>
  notes: string
}

export interface ConnectedAccountSummary {
  id: string
  provider: ConnectedAccount["provider"]
  label: string
  identifier: string
  workspaceName: string | null
  includeInHall: boolean
}
