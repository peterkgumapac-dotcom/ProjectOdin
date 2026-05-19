export type OperationsSignalSource =
  | "slack"
  | "gmail"
  | "calendar"
  | "health"
  | "weather"
  | "browser"
  | "manual"
  | "memory"
  | "research"
  | "system"

export type OperationsSignalCategory =
  | "urgent"
  | "today"
  | "waiting"
  | "follow_up"
  | "routine"
  | "quiet"

export type OperationsBusiness = "Stay Minty" | "Dinbnb" | "Personal"

export type OperationsSignalStatus = "open" | "handled" | "deferred" | "waiting"

export interface OperationsSignal {
  id: string
  source: OperationsSignalSource
  category: OperationsSignalCategory
  title: string
  summary: string
  evidence?: string
  nextAction?: string
  suggestedReply?: string
  sourceUrl?: string
  dueAt?: string
  person?: string
  business?: OperationsBusiness
  status: OperationsSignalStatus
}

export interface OperationsSourceHealth {
  id: "gmail" | "slack" | "calendar" | "health" | "weather" | "browser"
  label: string
  state: "healthy" | "syncing" | "disconnected" | "attention"
  detail: string
  checkedAt?: string
}
