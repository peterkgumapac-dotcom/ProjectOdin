import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  BellOff,
  Check,
  CircleDot,
  Loader2,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  LightPageHeader,
  LightPageShell,
} from "@/components/dashboard/LightPageChrome"
import { ConnectionStatusChip } from "@/components/shared/ConnectionStatusChip"
import { useAuth } from "@/hooks/useAuth"
import { useConnectedAccounts, type ConnectedAccount } from "@/hooks/useConnectedAccounts"
import {
  DEFAULT_BUSINESSES,
  DEFAULT_PRIORITY_TOPICS,
  generateOnboardingDraft,
  isIncludedInHall,
  saveOnboardingDraft,
  summarizeAccount,
} from "@/lib/onboarding"
import {
  archiveOdinMemory,
  createOdinMemory,
  listOdinMemories,
  type OdinMemory,
  type OdinMemoryKind,
} from "@/lib/odinMemory"
import {
  archiveOdinLearningEvent,
  listOdinLearningEvents,
  type OdinLearningEvent,
} from "@/lib/odinResponsibility"
import type {
  OnboardingAnswers,
  OnboardingBusiness,
  OnboardingDraft,
  OnboardingSourceType,
  PriorityRuleDraft,
} from "@/types/onboarding"

const STEPS = [
  {
    id: "businesses",
    label: "Businesses",
    title: "What should ODIN watch?",
  },
  {
    id: "sources",
    label: "Sources",
    title: "Which connected sources feed the Hall?",
  },
  {
    id: "people",
    label: "People",
    title: "Who should cut through the noise?",
  },
  {
    id: "topics",
    label: "Priorities",
    title: "Which topics matter first?",
  },
  {
    id: "suppressions",
    label: "Suppressions",
    title: "What should stay quiet?",
  },
  {
    id: "review",
    label: "Review",
    title: "Review the generated setup before saving.",
  },
] as const

const SOURCE_OPTIONS: Array<{
  value: OnboardingSourceType
  label: string
  detail: string
}> = [
  {
    value: "gmail",
    label: "Gmail",
    detail: "Owner, vendor, guest, payment, booking, and deadline signals.",
  },
  {
    value: "slack",
    label: "Slack",
    detail: "DMs, mentions, blockers, approvals, and team decisions.",
  },
  {
    value: "calendar",
    label: "Calendar",
    detail: "Today commitments, meetings, and time-sensitive follow-ups.",
  },
]

const initialAnswers: OnboardingAnswers = {
  businesses: [...DEFAULT_BUSINESSES],
  connectedSources: ["gmail", "slack", "calendar"],
  importantPeople:
    "Meredith, owners, cleaners, maintenance vendors, team leads, guest support contacts",
  priorityTopics: [...DEFAULT_PRIORITY_TOPICS],
  suppressions:
    "Login-only Gmail accounts, promotions, newsletters, automated system alerts unless they mention account access or payment, casual team chatter, old resolved threads",
  accountInclusion: {},
  notes:
    "ODIN is Peter's calm central operations hub for business and personal operations. Prioritize what waits on Peter, not generic unread volume.",
}

const MEMORY_KINDS: OdinMemoryKind[] = [
  "preference",
  "business",
  "person",
  "tone",
  "priority",
  "routine",
  "source",
  "decision",
  "other",
]

function readableTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "recent"
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function accountKey(accounts: ConnectedAccount[]): string {
  return accounts
    .map((account) => `${account.id}:${account.workflowRules.length}`)
    .join("|")
}

function toggleList<T extends string>(items: T[], value: T): T[] {
  return items.includes(value)
    ? items.filter((item) => item !== value)
    : [...items, value]
}

function shortProvider(account: ConnectedAccount): string {
  if (account.provider === "google") return "Gmail / Calendar"
  if (account.provider === "slack") return "Slack"
  return "Spotify"
}

function priorityPatch(
  rule: PriorityRuleDraft,
  patch: Partial<PriorityRuleDraft>
): PriorityRuleDraft {
  return { ...rule, ...patch }
}

export function Settings() {
  const { user } = useAuth()
  const { google, slack, spotify, withings, loading, refresh } = useConnectedAccounts()
  const accounts = useMemo(
    () => [...google, ...slack, ...spotify, ...withings],
    [google, slack, spotify, withings]
  )
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<OnboardingAnswers>(initialAnswers)
  const [draft, setDraft] = useState<OnboardingDraft | null>(null)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [memories, setMemories] = useState<OdinMemory[]>([])
  const [memoryKind, setMemoryKind] = useState<OdinMemoryKind>("preference")
  const [memoryTitle, setMemoryTitle] = useState("")
  const [memoryContent, setMemoryContent] = useState("")
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [learningEvents, setLearningEvents] = useState<OdinLearningEvent[]>([])

  const connectedAccountKey = accountKey(accounts)

  const loadMemories = useCallback(async () => {
    if (!user) return
    try {
      const [nextMemories, nextLearningEvents] = await Promise.all([
        listOdinMemories(user.id),
        listOdinLearningEvents(user.id),
      ])
      setMemories(nextMemories)
      setLearningEvents(nextLearningEvents)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load ODIN memory.")
    }
  }, [user])

  useEffect(() => {
    setAnswers((prev) => {
      const next = { ...prev.accountInclusion }
      let changed = false
      for (const account of accounts) {
        if (typeof next[account.id] === "undefined") {
          next[account.id] = isIncludedInHall(account)
          changed = true
        }
      }
      return changed ? { ...prev, accountInclusion: next } : prev
    })
  }, [accounts, connectedAccountKey])

  useEffect(() => {
    if (!user) return
    void loadMemories()
  }, [loadMemories, user])

  const current = STEPS[step]
  const canGoNext = step < STEPS.length - 1
  const canGoBack = step > 0
  const calendarLinked = google.length > 0
  const spotifyLinked = spotify.length > 0
  const withingsLinked = withings.length > 0

  const setAccountIncluded = (accountId: string, included: boolean) => {
    setDraft(null)
    setAnswers((prev) => ({
      ...prev,
      accountInclusion: {
        ...prev.accountInclusion,
        [accountId]: included,
      },
    }))
  }

  const updateAnswers = (patch: Partial<OnboardingAnswers>) => {
    setDraft(null)
    setSaved(null)
    setAnswers((prev) => ({ ...prev, ...patch }))
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    setSaved(null)
    try {
      const nextDraft = await generateOnboardingDraft(answers, accounts)
      setDraft(nextDraft)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "ODIN could not generate setup JSON. Retry the draft."
      )
    } finally {
      setGenerating(false)
    }
  }

  const handleSave = async () => {
    if (!user || !draft) return
    setSaving(true)
    setError(null)
    setSaved(null)
    try {
      await saveOnboardingDraft(user.id, accounts, draft)
      await refresh()
      setSaved("Onboarding setup saved. Hall priorities will use the updated account rules on refresh.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.")
    } finally {
      setSaving(false)
    }
  }

  const updatePriorityRule = (
    index: number,
    patch: Partial<PriorityRuleDraft>
  ) => {
    setDraft((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        priorityRules: prev.priorityRules.map((rule, i) =>
          i === index ? priorityPatch(rule, patch) : rule
        ),
      }
    })
  }

  const removePriorityRule = (index: number) => {
    setDraft((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        priorityRules: prev.priorityRules.filter((_rule, i) => i !== index),
      }
    })
  }

  const removeWorkflowRule = (accountId: string, ruleId: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        accountRules: prev.accountRules.map((entry) =>
          entry.accountId === accountId
            ? {
                ...entry,
                workflowRules: entry.workflowRules.filter(
                  (rule) => rule.id !== ruleId
                ),
              }
            : entry
        ),
      }
    })
  }

  const handleAddMemory = async () => {
    if (!user || !memoryTitle.trim() || !memoryContent.trim()) return
    setMemoryBusy(true)
    setError(null)
    setSaved(null)
    try {
      const created = await createOdinMemory({
        userId: user.id,
        kind: memoryKind,
        title: memoryTitle.trim(),
        content: memoryContent.trim(),
      })
      setMemories((prev) => [created, ...prev])
      setMemoryTitle("")
      setMemoryContent("")
      setSaved("ODIN memory saved. Future voice and brief answers can use it as context.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save ODIN memory.")
    } finally {
      setMemoryBusy(false)
    }
  }

  const handleArchiveMemory = async (id: string) => {
    setMemoryBusy(true)
    setError(null)
    try {
      await archiveOdinMemory(id)
      setMemories((prev) => prev.filter((memory) => memory.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive ODIN memory.")
    } finally {
      setMemoryBusy(false)
    }
  }

  const handleArchiveLearning = async (id: string) => {
    setMemoryBusy(true)
    setError(null)
    try {
      await archiveOdinLearningEvent(id)
      setLearningEvents((prev) => prev.filter((event) => event.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive learning event.")
    } finally {
      setMemoryBusy(false)
    }
  }

  const handlePinLearning = async (event: OdinLearningEvent) => {
    if (!user) return
    setMemoryBusy(true)
    setError(null)
    setSaved(null)
    try {
      const memory = await createOdinMemory({
        userId: user.id,
        kind:
          event.event_type === "rule"
            ? "priority"
            : event.event_type === "memory" || event.event_type === "correction"
              ? "preference"
              : "other",
        title: `Pinned learning: ${event.summary.slice(0, 80)}`,
        content: event.summary,
        source: "user_confirmed",
        confidence: 0.95,
      })
      setMemories((prev) => [memory, ...prev])
      setSaved("Learning pinned as ODIN memory.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not pin learning event.")
    } finally {
      setMemoryBusy(false)
    }
  }

  const handleCorrectLearning = (event: OdinLearningEvent) => {
    setMemoryKind("preference")
    setMemoryTitle(`Correction: ${event.event_type}`)
    setMemoryContent(event.summary)
    setSaved("Edit the correction, then press Remember to make it a high-confidence memory.")
  }

  return (
    <LightPageShell>
      <div className="mx-auto max-w-[1800px] space-y-10">
          <LightPageHeader
            title="Memory"
            subtitle="onboarding session"
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <ConnectionStatusChip
                  label="Spotify"
                  tone={loading ? "attention" : spotifyLinked ? "connected" : "disconnected"}
                  detail={loading ? "checking" : spotifyLinked ? "linked" : "not linked"}
                />
                <ConnectionStatusChip
                  label="Calendar"
                  tone={loading ? "attention" : calendarLinked ? "connected" : "disconnected"}
                  detail={loading ? "checking" : calendarLinked ? "linked" : "not linked"}
                />
                <ConnectionStatusChip
                  label="Withings"
                  tone={loading ? "attention" : withingsLinked ? "connected" : "disconnected"}
                  detail={loading ? "checking" : withingsLinked ? "linked" : "not linked"}
                />
              </div>
            }
          />
          <p className="-mt-7 max-w-4xl text-2xl font-medium leading-tight text-muted-foreground">
            Teach ODIN your workflows, important people, priority topics, and
            suppressions. Nothing saves until you review and approve the generated setup.
          </p>

          {(error || saved) && (
            <div
              className={[
                "rounded-md border px-4 py-3 text-sm",
                error
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-success/40 bg-success/10 text-success",
              ].join(" ")}
              role={error ? "alert" : "status"}
            >
              {error ?? saved}
            </div>
          )}

          <section className="odin-light-card rounded-3xl p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-4xl font-extrabold tracking-[-0.04em] text-foreground">
                  Manual context
                  <span className="ml-3 text-xl font-semibold tracking-normal text-tertiary">
                    — add a durable fact
                  </span>
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  Add durable facts ODIN should remember: preferences, businesses,
                  people, tone, and recurring priorities. Raw Slack and Gmail bodies
                  are not stored here.
                </p>
              </div>
              <div className="rounded-full border border-gold/40 bg-gold/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-gold">
                {memories.length} active
              </div>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-[180px_1fr]">
              <div>
                <label className="label-track text-tertiary">Kind</label>
                <select
                  value={memoryKind}
                  onChange={(event) =>
                    setMemoryKind(event.target.value as OdinMemoryKind)
                  }
                  className="odin-light-control mt-2 h-11 w-full px-0 text-xl font-bold"
                >
                  {MEMORY_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </div>
              <Input
                value={memoryTitle}
                onChange={(event) => setMemoryTitle(event.target.value)}
                placeholder="Example: Meredith escalation style"
                className="self-end border-0 border-b border-border bg-transparent text-xl font-bold shadow-none focus-visible:ring-0"
              />
              <div className="lg:col-span-2">
                <textarea
                  value={memoryContent}
                  onChange={(event) => setMemoryContent(event.target.value)}
                  placeholder="Example: If Meredith flags billables, ODIN should treat it as high-risk and suggest a direct completion note with evidence."
                  rows={4}
                  className="min-h-32 w-full resize-none rounded-2xl border border-border bg-[#f9f0df] px-5 py-4 text-lg text-foreground outline-none focus:border-gold/60"
                />
              </div>
              <div className="lg:col-span-2 flex justify-end">
                <Button
                  type="button"
                  onClick={handleAddMemory}
                  disabled={memoryBusy || !memoryTitle.trim() || !memoryContent.trim()}
                  className="odin-light-action odin-light-action-primary px-8 py-6 text-lg"
                >
                  {memoryBusy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Remember
                </Button>
              </div>
            </div>

            {memories.length > 0 && (
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {memories.slice(0, 8).map((memory) => (
                  <div
                    key={memory.id}
                    className="odin-light-card rounded-3xl p-7"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="label-track text-gold">{memory.kind}</div>
                        <div className="mt-1 font-semibold text-foreground">
                          {memory.title}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleArchiveMemory(memory.id)}
                        disabled={memoryBusy}
                        className="rounded-md border border-border p-2 text-tertiary transition hover:border-destructive/50 hover:text-destructive"
                        aria-label={`Archive ${memory.title}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                      {memory.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="odin-light-card rounded-3xl p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="label-track text-gold">LEARNING LOG</div>
                <h2 className="mt-2 font-display text-xl tracking-[0.16em] text-foreground">
                  AUTOMATIC ODIN LEARNING
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  Review what ODIN learned from conversations and manual scans.
                  Archive noise, pin useful facts, or turn a shaky observation into a corrected memory.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadMemories()}
                disabled={memoryBusy}
                className="border-border bg-background/40"
              >
                {memoryBusy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Refresh
              </Button>
            </div>

            {learningEvents.length === 0 ? (
              <div className="mt-5 rounded-md border border-success/25 bg-success/10 px-4 py-4 text-sm text-success">
                No automatic learning events are waiting for review.
              </div>
            ) : (
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {learningEvents.slice(0, 12).map((event) => (
                  <article
                    key={event.id}
                    className="rounded-md border border-border bg-background/60 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="label-track text-gold">
                          {event.source_type} / {event.event_type}
                        </div>
                        <div className="mt-1 text-xs text-tertiary">
                          {readableTimestamp(event.created_at)}
                        </div>
                      </div>
                      <span className="rounded-full border border-border px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-tertiary">
                        {event.status}
                      </span>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                      {event.summary}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handlePinLearning(event)}
                        disabled={memoryBusy}
                        className="border-gold/50 bg-gold/15 text-gold hover:bg-gold/20"
                      >
                        <Check size={13} />
                        Pin
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleCorrectLearning(event)}
                        disabled={memoryBusy}
                        className="border-border bg-background/40"
                      >
                        <Sparkles size={13} />
                        Correct
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleArchiveLearning(event.id)}
                        disabled={memoryBusy}
                        className="border-border bg-background/40 text-tertiary hover:border-destructive/50 hover:text-destructive"
                      >
                        <Trash2 size={13} />
                        Archive
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="grid grid-cols-12 gap-6">
            <aside className="col-span-12 lg:col-span-3 space-y-2">
              {STEPS.map((item, index) => {
                const active = index === step
                const complete = index < step
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setStep(index)}
                    className={[
                      "w-full rounded-md border px-3 py-3 text-left transition-colors",
                      active
                        ? "border-gold/50 bg-gold/[0.08]"
                        : "border-border bg-surface/40 hover:border-border-accent",
                    ].join(" ")}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={[
                          "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]",
                          active || complete
                            ? "border-gold text-gold"
                            : "border-border text-tertiary",
                        ].join(" ")}
                      >
                        {complete ? <Check size={12} /> : index + 1}
                      </span>
                      <span className="label-track text-xs text-foreground">
                        {item.label}
                      </span>
                    </span>
                    <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
                      {item.title}
                    </span>
                  </button>
                )
              })}
              <SetupMap
                answers={answers}
                accounts={accounts}
                draft={draft}
              />
            </aside>

            <section className="col-span-12 lg:col-span-9 rounded-md border border-border bg-surface/70 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="label-track text-tertiary">
                    STEP {step + 1} OF {STEPS.length}
                  </div>
                  <h2 className="mt-2 font-display text-xl tracking-[0.16em] text-gold">
                    {current.title}
                  </h2>
                </div>
                <SettingsIcon size={18} className="text-gold/70" />
              </div>

              <div className="mt-6">
                {step === 0 && (
                  <BusinessStep answers={answers} onChange={updateAnswers} />
                )}
                {step === 1 && (
                  <SourcesStep
                    answers={answers}
                    accounts={accounts}
                    loading={loading}
                    onChange={updateAnswers}
                    onAccountIncluded={setAccountIncluded}
                  />
                )}
                {step === 2 && (
                  <PeopleStep answers={answers} onChange={updateAnswers} />
                )}
                {step === 3 && (
                  <TopicsStep answers={answers} onChange={updateAnswers} />
                )}
                {step === 4 && (
                  <SuppressionsStep
                    answers={answers}
                    accounts={accounts}
                    onChange={updateAnswers}
                    onAccountIncluded={setAccountIncluded}
                  />
                )}
                {step === 5 && (
                  <ReviewStep
                    accounts={accounts}
                    draft={draft}
                    generating={generating}
                    saving={saving}
                    onGenerate={handleGenerate}
                    onSave={handleSave}
                    onUpdatePriorityRule={updatePriorityRule}
                    onRemovePriorityRule={removePriorityRule}
                    onRemoveWorkflowRule={removeWorkflowRule}
                  />
                )}
              </div>

              <div className="mt-8 flex items-center justify-between border-t border-border/60 pt-4">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!canGoBack}
                  onClick={() => setStep((prev) => Math.max(0, prev - 1))}
                  className="text-tertiary hover:text-foreground"
                >
                  <ArrowLeft size={14} />
                  Back
                </Button>
                {canGoNext ? (
                  <Button
                    type="button"
                    onClick={() =>
                      setStep((prev) => Math.min(STEPS.length - 1, prev + 1))
                    }
                    className="border-gold/50 bg-gold/15 text-gold hover:bg-gold/20"
                  >
                    Continue
                    <ArrowRight size={14} />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={draft ? handleSave : handleGenerate}
                    disabled={generating || saving}
                    className="border-gold/50 bg-gold/15 text-gold hover:bg-gold/20"
                  >
                    {generating || saving ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : draft ? (
                      <Save size={14} />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    {draft ? "Save Setup" : "Generate Setup"}
                  </Button>
                )}
              </div>
            </section>
          </div>
      </div>
    </LightPageShell>
  )
}

function BusinessStep({
  answers,
  onChange,
}: {
  answers: OnboardingAnswers
  onChange: (patch: Partial<OnboardingAnswers>) => void
}) {
  return (
    <div className="space-y-5">
      <OptionGrid>
        {DEFAULT_BUSINESSES.map((business) => (
          <CheckboxTile
            key={business}
            label={business}
            checked={answers.businesses.includes(business)}
            onChange={() =>
              onChange({
                businesses: toggleList(
                  answers.businesses,
                  business as OnboardingBusiness
                ),
              })
            }
          />
        ))}
      </OptionGrid>
      <TextareaField
        label="Operating notes"
        value={answers.notes}
        onChange={(notes) => onChange({ notes })}
        placeholder="How should ODIN think about your work?"
      />
    </div>
  )
}

function SourcesStep({
  answers,
  accounts,
  loading,
  onChange,
  onAccountIncluded,
}: {
  answers: OnboardingAnswers
  accounts: ConnectedAccount[]
  loading: boolean
  onChange: (patch: Partial<OnboardingAnswers>) => void
  onAccountIncluded: (accountId: string, included: boolean) => void
}) {
  return (
    <div className="space-y-5">
      <OptionGrid>
        {SOURCE_OPTIONS.map((source) => (
          <CheckboxTile
            key={source.value}
            label={source.label}
            detail={source.detail}
            checked={answers.connectedSources.includes(source.value)}
            onChange={() =>
              onChange({
                connectedSources: toggleList(
                  answers.connectedSources,
                  source.value
                ),
              })
            }
          />
        ))}
      </OptionGrid>
      <AccountInclusionList
        accounts={accounts}
        loading={loading}
        inclusion={answers.accountInclusion}
        onAccountIncluded={onAccountIncluded}
      />
    </div>
  )
}

function PeopleStep({
  answers,
  onChange,
}: {
  answers: OnboardingAnswers
  onChange: (patch: Partial<OnboardingAnswers>) => void
}) {
  return (
    <TextareaField
      label="Important people, senders, vendors, owners, and workspaces"
      value={answers.importantPeople}
      onChange={(importantPeople) => onChange({ importantPeople })}
      placeholder="Names, emails, Slack handles, vendor names, owner names..."
      rows={9}
    />
  )
}

function TopicsStep({
  answers,
  onChange,
}: {
  answers: OnboardingAnswers
  onChange: (patch: Partial<OnboardingAnswers>) => void
}) {
  return (
    <div className="space-y-5">
      <OptionGrid>
        {DEFAULT_PRIORITY_TOPICS.map((topic) => (
          <CheckboxTile
            key={topic}
            label={topic}
            checked={answers.priorityTopics.includes(topic)}
            onChange={() =>
              onChange({
                priorityTopics: toggleList(answers.priorityTopics, topic),
              })
            }
          />
        ))}
      </OptionGrid>
      <p className="text-xs leading-relaxed text-muted-foreground">
        These become central operations signals, not raw unread counts. ODIN
        should use them to decide what waits on Peter.
      </p>
    </div>
  )
}

function SuppressionsStep({
  answers,
  accounts,
  onChange,
  onAccountIncluded,
}: {
  answers: OnboardingAnswers
  accounts: ConnectedAccount[]
  onChange: (patch: Partial<OnboardingAnswers>) => void
  onAccountIncluded: (accountId: string, included: boolean) => void
}) {
  return (
    <div className="space-y-5">
      <TextareaField
        label="Noise and login-only rules"
        value={answers.suppressions}
        onChange={(suppressions) => onChange({ suppressions })}
        placeholder="Promos, newsletters, login-only inboxes, noisy channels, low-priority senders..."
        rows={7}
      />
      <AccountInclusionList
        accounts={accounts}
        inclusion={answers.accountInclusion}
        onAccountIncluded={onAccountIncluded}
      />
    </div>
  )
}

function ReviewStep({
  accounts,
  draft,
  generating,
  saving,
  onGenerate,
  onSave,
  onUpdatePriorityRule,
  onRemovePriorityRule,
  onRemoveWorkflowRule,
}: {
  accounts: ConnectedAccount[]
  draft: OnboardingDraft | null
  generating: boolean
  saving: boolean
  onGenerate: () => void
  onSave: () => void
  onUpdatePriorityRule: (
    index: number,
    patch: Partial<PriorityRuleDraft>
  ) => void
  onRemovePriorityRule: (index: number) => void
  onRemoveWorkflowRule: (accountId: string, ruleId: string) => void
}) {
  const accountMap = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )

  if (!draft) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/30 p-8 text-center">
        <Sparkles className="mx-auto text-gold" size={24} />
        <h3 className="mt-4 font-display tracking-[0.16em] text-foreground">
          GENERATE REVIEW DRAFT
        </h3>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
          ODIN will convert the interview into global priority
          rules and account-level include/suppress workflow rules. You review
          before anything saves.
        </p>
        <div className="mx-auto mt-5 grid max-w-xl grid-cols-3 gap-2 text-left">
          {[
            ["1", "Interview"],
            ["2", "Draft rules"],
            ["3", "Approve save"],
          ].map(([number, label]) => (
            <div
              key={number}
              className="rounded-md border border-border/70 bg-surface/50 px-3 py-2"
            >
              <div className="font-mono-data text-xs text-gold">{number}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </div>
            </div>
          ))}
        </div>
        <Button
          type="button"
          onClick={onGenerate}
          disabled={generating}
          className="mt-5 border-gold/50 bg-gold/15 text-gold hover:bg-gold/20"
        >
          {generating ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
          Generate Setup
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="label-track text-tertiary">GENERATED SETUP</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Edit the essentials, remove anything too noisy, then save.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onGenerate}
            disabled={generating || saving}
            className="text-tertiary hover:text-foreground"
          >
            <RefreshCw size={14} />
            Retry Draft
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={generating || saving}
            className="border-gold/50 bg-gold/15 text-gold hover:bg-gold/20"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save Setup
          </Button>
        </div>
      </div>

      <section className="space-y-3">
        <div className="label-track text-gold">GLOBAL PRIORITY RULES</div>
        {draft.priorityRules.length === 0 ? (
          <EmptyLine text="No priority rules returned. Retry the draft." />
        ) : (
          <ul className="space-y-3">
            {draft.priorityRules.map((rule, index) => (
              <li
                key={`${rule.name}-${index}`}
                className="rounded-md border border-border bg-background/30 p-4"
              >
                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-12 md:col-span-7 space-y-2">
                    <Input
                      value={rule.name}
                      onChange={(e) =>
                        onUpdatePriorityRule(index, { name: e.target.value })
                      }
                      className="font-medium"
                      aria-label="Priority rule name"
                    />
                    <textarea
                      value={rule.description}
                      onChange={(e) =>
                        onUpdatePriorityRule(index, {
                          description: e.target.value,
                        })
                      }
                      className="min-h-16 w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm text-foreground outline-none focus:border-gold/50"
                      aria-label="Priority rule description"
                    />
                  </div>
                  <div className="col-span-12 md:col-span-5 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={rule.source_type}
                        onChange={(e) =>
                          onUpdatePriorityRule(index, {
                            source_type: e.target.value as OnboardingSourceType,
                          })
                        }
                        className="rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs text-foreground"
                      >
                        <option value="gmail">Gmail</option>
                        <option value="slack">Slack</option>
                        <option value="calendar">Calendar</option>
                        <option value="manual">Manual</option>
                      </select>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={rule.priority_score}
                        onChange={(e) =>
                          onUpdatePriorityRule(index, {
                            priority_score: Number(e.target.value),
                          })
                        }
                        aria-label="Priority score"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={rule.notify}
                        onChange={(e) =>
                          onUpdatePriorityRule(index, {
                            notify: e.target.checked,
                          })
                        }
                        className="accent-[var(--accent-gold)]"
                      />
                      Notify ODIN when this fires
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemovePriorityRule(index)}
                      className="text-tertiary hover:text-destructive"
                    >
                      <Trash2 size={13} />
                      Remove
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="label-track text-gold">ACCOUNT WORKFLOW RULES</div>
        {draft.accountRules.length === 0 ? (
          <EmptyLine text="No account-specific rules in this draft." />
        ) : (
          <ul className="space-y-3">
            {draft.accountRules.map((entry) => {
              const account = accountMap.get(entry.accountId)
              return (
                <li
                  key={entry.accountId}
                  className="rounded-md border border-border bg-background/30 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-foreground">
                        {account
                          ? summarizeAccount(account).identifier
                          : entry.accountId}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {account ? shortProvider(account) : "Connected account"}
                      </div>
                    </div>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-tertiary">
                      {entry.workflowRules.length} rule
                      {entry.workflowRules.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {entry.workflowRules.map((rule) => (
                      <li
                        key={rule.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-surface/50 px-3 py-2 text-xs"
                      >
                        <span className="text-muted-foreground">
                          <span className="text-foreground">{rule.trigger}</span>{" "}
                          when "{rule.condition || "any"}" then{" "}
                          <span className="text-gold">{rule.action}</span>
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            onRemoveWorkflowRule(entry.accountId, rule.id)
                          }
                          className="text-tertiary hover:text-destructive"
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function SetupMap({
  answers,
  accounts,
  draft,
}: {
  answers: OnboardingAnswers
  accounts: ConnectedAccount[]
  draft: OnboardingDraft | null
}) {
  const mutedCount = accounts.filter(
    (account) => answers.accountInclusion[account.id] === false
  ).length
  const activeSources = answers.connectedSources
    .map((source) => source.toUpperCase())
    .join(" / ")

  return (
    <div className="mt-4 rounded-md border border-border bg-surface/60 p-4">
      <div className="label-track text-gold">LIVE SETUP MAP</div>
      <div className="mt-4 space-y-3 text-xs">
        <MapLine
          active
          label="Central Ops Profile"
          value={`${answers.businesses.length} realm${answers.businesses.length === 1 ? "" : "s"}`}
        />
        <MapLine
          label="Sources"
          value={activeSources || "None selected"}
        />
        <MapLine
          label="Priority Topics"
          value={`${answers.priorityTopics.length} selected`}
        />
        <MapLine
          label="Suppressions"
          value={
            mutedCount > 0
              ? `${mutedCount} account${mutedCount === 1 ? "" : "s"} muted`
              : "No accounts muted"
          }
        />
        <MapLine
          label="Generated Setup"
          value={
            draft
              ? `${draft.priorityRules.length} global / ${draft.accountRules.length} account`
              : "Pending review draft"
          }
        />
      </div>
    </div>
  )
}

function MapLine({
  label,
  value,
  active = false,
}: {
  label: string
  value: string
  active?: boolean
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <CircleDot
          size={13}
          className={active ? "text-gold" : "text-tertiary"}
        />
        <span className="mt-1 h-6 w-px bg-border" />
      </div>
      <div className="min-w-0 pb-1">
        <div className="font-medium text-foreground">{label}</div>
        <div className="mt-0.5 truncate text-tertiary">{value}</div>
      </div>
    </div>
  )
}

function AccountInclusionList({
  accounts,
  loading = false,
  inclusion,
  onAccountIncluded,
}: {
  accounts: ConnectedAccount[]
  loading?: boolean
  inclusion: Record<string, boolean>
  onAccountIncluded: (accountId: string, included: boolean) => void
}) {
  if (loading && accounts.length === 0) {
    return <EmptyLine text="Loading connected accounts..." />
  }
  if (accounts.length === 0) {
    return <EmptyLine text="No Gmail or Slack accounts are connected yet." />
  }
  return (
    <div className="space-y-3">
      <div className="label-track text-tertiary">HALL PRIORITY INCLUSION</div>
      <ul className="space-y-2">
        {accounts.map((account) => {
          const summary = summarizeAccount(account)
          const included = inclusion[account.id] ?? summary.includeInHall
          return (
            <li
              key={account.id}
              className="rounded-md border border-border bg-background/30 p-3"
            >
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={included}
                  onChange={(e) =>
                    onAccountIncluded(account.id, e.target.checked)
                  }
                  className="mt-1 accent-[var(--accent-gold)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {summary.identifier}
                    </span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-tertiary">
                      {shortProvider(account)}
                    </span>
                    {!included && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-gold/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-gold">
                        <BellOff size={10} />
                        Muted
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {included
                      ? "Allowed to influence the Hall brief and priority queue."
                      : "Still connected for drill-downs, but muted from central priorities."}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function OptionGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{children}</div>
}

function CheckboxTile({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string
  detail?: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <label
      className={[
        "block rounded-md border p-4 transition-colors",
        checked
          ? "border-gold/50 bg-gold/[0.08]"
          : "border-border bg-background/30 hover:border-border-accent",
      ].join(" ")}
    >
      <span className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onChange}
          className="accent-[var(--accent-gold)]"
        />
        <span className="text-sm font-semibold text-foreground">{label}</span>
      </span>
      {detail && (
        <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
          {detail}
        </span>
      )}
    </label>
  )
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 5,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  rows?: number
}) {
  return (
    <label className="block space-y-2">
      <span className="label-track text-tertiary">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full rounded-md border border-border bg-background/40 px-3 py-2 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-tertiary focus:border-gold/50"
      />
    </label>
  )
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/30 px-4 py-5 text-center text-sm text-tertiary">
      {text}
    </div>
  )
}
