import type {
  OdinCommandMode,
  OdinCommandResponse,
  OdinTone,
} from "@/lib/odinOrchestrator"

export const ODIN_PERSONA_SUMMARY =
  "ODIN is composed, useful, lightly witty when safe, and serious when the work is serious."

const casualLocalReplies: Array<{ pattern: RegExp; reply: string }> = [
  {
    pattern:
      /^(hey|hi|hello|yo)?\s*odin\s*(are you awake|you awake|are you there|wake up)?$/,
    reply: "Awake, Peter. Regrettably alert.",
  },
  {
    pattern: /\b(are you awake|you there|wake up odin)\b/,
    reply: "Awake, Peter. Regrettably alert.",
  },
  {
    pattern: /\b(what can you do|help|how do i use you)\b/,
    reply:
      "I can scan operations, read the day, research a problem, open the right page, and spare you a little inbox archaeology. Try asking, 'What should I handle first?'",
  },
  {
    pattern: /\b(joke|make me laugh|something funny)\b/,
    reply:
      "I asked the inbox to behave. It responded with 107,000 counterarguments.",
  },
  {
    pattern: /\b(can you hear me|do you hear me|testing|test voice)\b/,
    reply: "Clearly. The microphone has survived another trial.",
  },
  {
    pattern: /\b(how are you|how are we|status)\b/,
    reply: "Online, clear, and ready. A rare combination, but here we are. I would start with the brief, then deal with anything wearing the word urgent like a cheap costume.",
  },
  {
    pattern: /\b(good morning|morning odin)\b/,
    reply: "Good morning, sir. Karl. I am ready when you are.",
  },
  {
    pattern: /\b(thank you|thanks|good job)\b/,
    reply: "Of course, Peter. I live for competent delegation.",
  },
  {
    pattern: /\b(be quiet|silence|stop talking|cancel)\b/,
    reply: "Standing down.",
  },
]

const localSuggestions = [
  "What needs me today?",
  "Read my calendar.",
  "Scan urgent Gmail from 7 days.",
]

export function toneForMode(mode: OdinCommandMode): OdinTone {
  if (mode === "chat") return "witty"
  return "standard"
}

export function localConversationResponse(
  command: string
): OdinCommandResponse | null {
  const normalized = command
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const match = casualLocalReplies.find((item) => item.pattern.test(normalized))
  if (!match) return null

  return {
    spokenText: match.reply,
    displayText: match.reply,
    signals: [],
    sourceLinks: [],
    drafts: [],
    warnings: [],
    toolRuns: [{ tool: "odin-local-persona", status: "ok" }],
    suggestions: localSuggestions,
    conversationState: {
      activeTopic: "local_voice_check",
      unresolvedQuestion: null,
    },
  }
}
