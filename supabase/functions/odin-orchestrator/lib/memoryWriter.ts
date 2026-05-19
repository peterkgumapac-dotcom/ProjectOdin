import { getAdminClient } from "../../_shared/supabase_admin.ts"

interface LogEpisodicArgs {
  userId: string
  conversationId?: string
  userInput: string
  odinResponse: string
  observation?: string
  contextJson?: Record<string, unknown>
}

function compact(value: string, max = 360): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function observationFor(userInput: string, odinResponse: string): string {
  const input = compact(userInput, 120)
  const response = compact(odinResponse, 160)
  return `Peter asked: "${input}". ODIN answered: "${response}".`
}

export async function logEpisodic(args: LogEpisodicArgs): Promise<void> {
  const observation = args.observation ?? observationFor(args.userInput, args.odinResponse)

  const { error } = await getAdminClient()
    .from("episodic_memory")
    .insert({
      user_id: args.userId,
      conversation_id: args.conversationId ?? null,
      user_input: args.userInput,
      odin_response: args.odinResponse,
      observation,
      user_reaction: "neutral",
      context_json: args.contextJson ?? {},
    })

  if (error) throw new Error(`Failed to log episodic memory: ${error.message}`)
}
