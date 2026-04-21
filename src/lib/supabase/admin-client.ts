// ─────────────────────────────────────────────────────────────────────────────
// admin-client.ts — A SECOND, fully-isolated Supabase auth client used
// exclusively by the /admin dashboard.
//
// Why a separate client?
//   The default Supabase auth client in `./client.ts` stores its session under
//   `sb-<project-ref>-auth-token` in localStorage. Only ONE session can occupy
//   that slot at a time, so signing into a non-dev Google account in the main
//   app deletes / rotates the dev session — even though we'd cached its
//   refresh token in a parallel slot, Supabase considers the rotated token
//   invalid on reuse. This is why the previous "cached dev session" fallback
//   broke the moment the user signed in as a regular user.
//
// The fix is architectural: give /admin its OWN auth slot. By passing a
// distinct `storageKey` when constructing a new Supabase client, we get a
// completely independent session that:
//   - Persists across main-app sign-in / sign-out events
//   - Has its own refresh-token lifecycle (never rotated by the main client)
//   - Can be signed in / out from the admin login screen without affecting
//     whatever account the user is using in the main app
//
// This mirrors how professional SaaS products separate operator tooling:
// Stripe admin, Vercel dashboard, AWS console — all have their own auth
// context independent of any embedded user session.
//
// Same Supabase project (same URL + anon key) — just a different storage slot.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// localStorage key that holds the admin session's tokens. Intentionally
// different from Supabase's default `sb-<ref>-auth-token` so the two
// sessions never fight over the same slot.
export const ADMIN_STORAGE_KEY = "ats-admin-auth-token";

let _adminClient: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        auth: {
          storageKey:       ADMIN_STORAGE_KEY,
          persistSession:   true,  // survives reload
          autoRefreshToken: true,  // transparent refresh before expiry
          detectSessionInUrl: false, // prevent this client from consuming
                                     // OAuth redirect fragments meant for
                                     // the main app
        },
      },
    );
  }
  return _adminClient;
}
