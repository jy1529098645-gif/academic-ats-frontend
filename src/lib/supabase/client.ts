import { createClient } from '@supabase/supabase-js'

let _supabase: ReturnType<typeof createClient> | null = null

export function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    )
  }
  return _supabase
}

// Thin proxy that lazy-creates the real client on first access. We expose the
// surface area actually used in the app: auth (session + listeners), channel
// (Realtime subscriptions on the announcements ticker), and removeChannel
// (cleanup when a component unmounts). Any additional Supabase features
// should be added here explicitly so the import boundary stays visible.
export const supabase = {
  get auth()                                           { return getSupabase().auth },
  channel(name: string, opts?: Parameters<ReturnType<typeof createClient>["channel"]>[1]) {
    return getSupabase().channel(name, opts as any)
  },
  removeChannel(ch: Parameters<ReturnType<typeof createClient>["removeChannel"]>[0]) {
    return getSupabase().removeChannel(ch)
  },
}
