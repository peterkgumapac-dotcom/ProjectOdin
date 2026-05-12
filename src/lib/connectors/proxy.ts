import { supabase } from "@/lib/supabaseClient"

interface ProxyEnvelope<T> {
  data?: T
  error?: string
}

export async function invokeProxy<T = unknown>(
  functionName: string,
  action: string,
  params?: Record<string, unknown>
): Promise<{ data: T | null; error: Error | null }> {
  const { data, error } = await supabase.functions.invoke<ProxyEnvelope<T>>(
    functionName,
    { body: { action, params } }
  )
  if (error) {
    return { data: null, error: new Error(error.message) }
  }
  if (data?.error) {
    return { data: null, error: new Error(data.error) }
  }
  if (data?.data === undefined) {
    return { data: null, error: new Error(`Empty response from ${functionName}`) }
  }
  return { data: data.data as T, error: null }
}
