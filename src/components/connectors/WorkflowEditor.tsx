import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { supabase } from "@/lib/supabaseClient"
import type {
  ConnectedAccount,
  WorkflowAction,
  WorkflowRule,
  WorkflowTrigger,
} from "@/hooks/useConnectedAccounts"

interface TriggerOption {
  value: WorkflowTrigger
  label: string
  placeholder: string
  numeric?: boolean
}

const GOOGLE_TRIGGERS: TriggerOption[] = [
  { value: "new_email", label: "New email arrives", placeholder: "(no condition)" },
  {
    value: "unread_over",
    label: "Unread count exceeds",
    placeholder: "e.g. 50",
    numeric: true,
  },
  { value: "from_sender", label: "Email from sender", placeholder: "name@example.com" },
  { value: "subject_contains", label: "Subject contains", placeholder: "keyword" },
  { value: "to_address", label: "Email to address", placeholder: "alias@example.com" },
]

const SLACK_TRIGGERS: TriggerOption[] = [
  { value: "new_message", label: "New message in channel", placeholder: "#channel" },
  { value: "mentioned", label: "I am mentioned", placeholder: "(no condition)" },
  { value: "keyword_in_channel", label: "Keyword appears", placeholder: "keyword" },
  { value: "from_user", label: "Message from user", placeholder: "@person" },
  {
    value: "channel_unread_over",
    label: "Channel unread exceeds",
    placeholder: "e.g. 10",
    numeric: true,
  },
]

interface ActionOption {
  value: WorkflowAction
  label: string
  icon: string
}

const ACTIONS: ActionOption[] = [
  { value: "notify_odin", label: "Notify ODIN", icon: "🔔" },
  { value: "label_urgent", label: "Label URGENT", icon: "⚡" },
  { value: "summarize_counsel", label: "Summarize in Counsel", icon: "📋" },
  { value: "skip_inbox", label: "Suppress", icon: "🔇" },
  { value: "auto_followup", label: "Auto-tag follow-up", icon: "📩" },
  { value: "highlight_channel", label: "Highlight channel", icon: "✨" },
]

const ACCOUNT_FOCUS_RULE_ID = "account_focus_suppressed"

function isAccountFocusRule(rule: WorkflowRule): boolean {
  return rule.id === ACCOUNT_FOCUS_RULE_ID
}

function accountFocusRule(): WorkflowRule {
  return {
    id: ACCOUNT_FOCUS_RULE_ID,
    trigger: "new_email",
    condition: "account",
    action: "skip_inbox",
    enabled: true,
  }
}

function isIncludedInHall(rules: WorkflowRule[]): boolean {
  return !rules.some((rule) => isAccountFocusRule(rule) && rule.enabled)
}

function newRuleId(): string {
  return `rule_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
}

function defaultRule(provider: "google" | "slack"): WorkflowRule {
  const triggers = provider === "google" ? GOOGLE_TRIGGERS : SLACK_TRIGGERS
  return {
    id: newRuleId(),
    trigger: triggers[0].value,
    condition: "",
    action: "notify_odin",
    enabled: true,
  }
}

export interface WorkflowEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: ConnectedAccount | null
  onSaved: () => void
}

export function WorkflowEditor({
  open,
  onOpenChange,
  account,
  onSaved,
}: WorkflowEditorProps) {
  const provider = account?.provider === "slack" ? "slack" : "google"
  const triggers = provider === "google" ? GOOGLE_TRIGGERS : SLACK_TRIGGERS

  const [label, setLabel] = useState(account?.accountLabel ?? "")
  const [rules, setRules] = useState<WorkflowRule[]>(
    account?.workflowRules.filter((rule) => !isAccountFocusRule(rule)) ?? []
  )
  const [includeInHall, setIncludeInHall] = useState(
    isIncludedInHall(account?.workflowRules ?? [])
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !account) return
    setLabel(account.accountLabel)
    setRules(account.workflowRules.filter((rule) => !isAccountFocusRule(rule)))
    setIncludeInHall(isIncludedInHall(account.workflowRules))
    setError(null)
  }, [open, account])

  if (!account) return null

  const addRule = () => {
    setRules((prev) => [...prev, defaultRule(provider)])
  }

  const updateRule = (id: string, patch: Partial<WorkflowRule>) => {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    )
  }

  const removeRule = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id))
  }

  const handleSave = async () => {
    setBusy(true)
    setError(null)
    const trimmedLabel = label.trim() || "Account"
    const savedRules = includeInHall ? rules : [...rules, accountFocusRule()]
    const { error: updateError } = await supabase
      .from("connected_accounts")
      .update({
        account_label: trimmedLabel,
        workflow_rules: savedRules as unknown as never,
      })
      .eq("id", account.id)
    setBusy(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    onSaved()
    onOpenChange(false)
  }

  const identifier =
    provider === "google" ? account.accountEmail : account.workspaceName

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="font-display tracking-[0.2em] text-gold">
            Workflow Rules
          </DialogTitle>
          <p className="text-xs text-muted-foreground">{identifier}</p>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          <div className="space-y-1.5">
            <label className="label-track text-tertiary" htmlFor="wf-label">
              Account Label
            </label>
            <Input
              id="wf-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
            />
          </div>

          <div className="rounded-md border border-border bg-surface/60 p-3">
            <label className="flex items-start gap-3 text-sm text-foreground">
              <input
                type="checkbox"
                checked={includeInHall}
                onChange={(e) => setIncludeInHall(e.target.checked)}
                className="mt-1 accent-[var(--accent-gold)]"
              />
              <span>
                <span className="block font-medium">
                  Include this account in Hall priorities
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  Turn this off for login-only or noisy accounts. ODIN keeps the
                  account connected, but it will not drive the Hall brief or
                  priority queue.
                </span>
              </span>
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="label-track text-tertiary">Rules</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addRule}
                className="text-gold hover:bg-gold/10"
              >
                <Plus size={14} className="mr-1" />
                Add Rule
              </Button>
            </div>

            {rules.length === 0 ? (
              <p className="text-xs text-tertiary py-4 text-center border border-dashed border-border rounded-md">
                No rules yet. Add one to start surfacing this account's signals
                into ODIN's Counsel.
              </p>
            ) : (
              <ul className="space-y-2">
                {rules.map((rule) => {
                  const triggerMeta =
                    triggers.find((t) => t.value === rule.trigger) ?? triggers[0]
                  return (
                    <li
                      key={rule.id}
                      className="rounded-md border border-border bg-surface/60 p-3 space-y-2"
                    >
                      <div className="grid grid-cols-12 gap-2 items-center">
                        <select
                          value={rule.trigger}
                          onChange={(e) =>
                            updateRule(rule.id, {
                              trigger: e.target.value as WorkflowTrigger,
                              condition: "",
                            })
                          }
                          className="col-span-5 bg-background border border-border rounded-md text-xs px-2 py-1.5 text-foreground"
                        >
                          {triggers.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>

                        <Input
                          value={rule.condition}
                          onChange={(e) =>
                            updateRule(rule.id, { condition: e.target.value })
                          }
                          type={triggerMeta.numeric ? "number" : "text"}
                          placeholder={triggerMeta.placeholder}
                          className="col-span-4 text-xs"
                        />

                        <select
                          value={rule.action}
                          onChange={(e) =>
                            updateRule(rule.id, {
                              action: e.target.value as WorkflowAction,
                            })
                          }
                          className="col-span-3 bg-background border border-border rounded-md text-xs px-2 py-1.5 text-foreground"
                        >
                          {ACTIONS.map((a) => (
                            <option key={a.value} value={a.value}>
                              {a.icon} {a.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(e) =>
                              updateRule(rule.id, {
                                enabled: e.target.checked,
                              })
                            }
                            className="accent-[var(--accent-gold)]"
                          />
                          {rule.enabled ? "Enabled" : "Disabled"}
                        </label>
                        <button
                          type="button"
                          onClick={() => removeRule(rule.id)}
                          className="text-xs text-tertiary hover:text-destructive transition-colors flex items-center gap-1"
                        >
                          <Trash2 size={12} /> Remove
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={busy}>
              {busy ? "Saving..." : "Save Workflow"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
