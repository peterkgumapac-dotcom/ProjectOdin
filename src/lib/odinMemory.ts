import { supabase } from "@/lib/supabaseClient"

export type OdinMemoryKind =
  | "preference"
  | "business"
  | "person"
  | "tone"
  | "priority"
  | "routine"
  | "source"
  | "decision"
  | "other"

export interface OdinMemory {
  id: string
  user_id: string
  kind: OdinMemoryKind
  title: string
  content: string
  source: "manual" | "odin" | "system" | "user_confirmed"
  confidence: number
  status: "active" | "archived"
  created_at: string
  updated_at: string
}

export async function listOdinMemories(userId: string): Promise<OdinMemory[]> {
  const { data, error } = await supabase
    .from("odin_memories")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as OdinMemory[]
}

export async function createOdinMemory(args: {
  userId: string
  kind: OdinMemoryKind
  title: string
  content: string
  source?: OdinMemory["source"]
  confidence?: number
}): Promise<OdinMemory> {
  const { data, error } = await supabase
    .from("odin_memories")
    .insert({
      user_id: args.userId,
      kind: args.kind,
      title: args.title,
      content: args.content,
      source: args.source ?? "manual",
      confidence: args.confidence ?? 1,
      status: "active",
    })
    .select("*")
    .single()

  if (error) throw new Error(error.message)
  return data as OdinMemory
}

export async function createOdinDecisionMemory(args: {
  userId: string
  title: string
  content: string
}): Promise<OdinMemory> {
  return createOdinMemory({
    userId: args.userId,
    kind: "decision",
    title: args.title,
    content: args.content,
    source: "user_confirmed",
    confidence: 0.95,
  })
}

export async function archiveOdinMemory(id: string) {
  const { error } = await supabase
    .from("odin_memories")
    .update({ status: "archived" })
    .eq("id", id)

  if (error) throw new Error(error.message)
}
