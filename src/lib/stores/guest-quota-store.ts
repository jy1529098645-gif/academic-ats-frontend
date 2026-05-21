// ─────────────────────────────────────────────────────────────────────────────
// guest-quota-store — tracks per-device usage caps for anonymous (Supabase
// `is_anonymous`) sessions. The auth gate now offers a "try without signing
// in" path that creates a real Supabase anonymous session; this store gates
// search execution on top of that so anonymous users get a strictly bounded
// trial (2 Quick searches + 1 Curated) before being prompted to sign in.
//
// Why client-side: the backend already does its own per-user quota
// accounting on the JWT subject. The values we enforce here are TIGHTER
// than backend (which is generous to make the product usable), so we treat
// this as a marketing/conversion gate rather than a security boundary —
// determined attackers can clear localStorage, but doing so is friction
// enough to convert most genuine visitors.
//
// Server-sourced limits: `loadServerLimits()` pulls the effective per-tier
// caps from `GET /api/quota-limits` and overwrites the in-memory limits
// the selectors read. The exported `GUEST_QUICK_MAX` / `GUEST_CURATED_MAX`
// constants stay as compile-time fallbacks (used until the fetch resolves,
// and as the bootstrap value during SSR) so behaviour is identical to the
// pre-sync version when the network is unavailable. When the backend
// changes a tier limit through the admin DB-override table, every device
// picks up the new cap on its next page load without a frontend redeploy.
//
// Migration: bump STORAGE_KEY's suffix (`-v1` → `-v2`) if the cap changes
// or the schema needs to drop legacy values.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from "zustand";
import { fetchWithApiFallback } from "@/lib/api";

/** Compile-time default — used until the server-sourced value
 *  arrives, and as the fallback for SSR / offline / fetch-failure
 *  paths. Mirrors backend TIER_LIMITS["anonymous"]["quick_search"] in
 *  quota.py; KEEP IN SYNC when bumping either side. */
export const GUEST_QUICK_MAX   = 20;
/** Compile-time default — mirrors backend
 *  TIER_LIMITS["anonymous"]["deep_search"] in quota.py. */
export const GUEST_CURATED_MAX = 6;

const STORAGE_KEY = "ats-guest-quota-v1";

type GuestQuotaState = {
  quickUsed:   number;
  curatedUsed: number;
  /** Effective max for Quick — server-sourced when known, else
   *  GUEST_QUICK_MAX. Selectors below read THIS, not the constant,
   *  so a backend-side override flows through automatically. */
  quickLimit:   number;
  /** Effective max for Curated — see quickLimit. */
  curatedLimit: number;
  /** True after `hydrate()` has loaded any prior counters from
   *  localStorage. SSR-safe — stays false on the server. */
  hydrated: boolean;
  /** True once a server-limits fetch has resolved (success OR failure).
   *  Used by callers that want to delay rendering "X / Y" badges until
   *  the authoritative numbers are in, so the user doesn't see "1 / 2"
   *  briefly turn into "0 / 0" when the server has tightened a cap. */
  limitsLoaded: boolean;

  hydrate:          () => void;
  incrementQuick:   () => void;
  incrementCurated: () => void;
  /** Fetch effective limits from the backend and overwrite local
   *  defaults. Safe to call repeatedly — the backend caches its
   *  response for 30 s so cost is negligible. Never throws; on
   *  failure the existing (compile-time-default) limits stay in
   *  place and `limitsLoaded` flips to true so callers can stop
   *  waiting on a value that will never come. */
  loadServerLimits: () => Promise<void>;
  /** Wipe both counters — call on conversion (anonymous → full account)
   *  or for explicit dev reset, NOT during normal flow. Does NOT reset
   *  the limits; those follow the server. */
  reset: () => void;
};

/** Today's date in UTC, formatted YYYY-MM-DD. The backend's quota
 *  buckets reset at 00:00 UTC, so we mirror that exact boundary on the
 *  client — a guest who has burned their counter yesterday should get a
 *  fresh allowance the moment UTC midnight crosses, NOT the next
 *  device-local midnight. */
function _utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function _persist(quickUsed: number, curatedUsed: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ quickUsed, curatedUsed, day: _utcDateKey() }),
    );
  } catch { /* quota / privacy mode — ignore */ }
}

export const useGuestQuotaStore = create<GuestQuotaState>((set, get) => ({
  quickUsed:    0,
  curatedUsed:  0,
  quickLimit:   GUEST_QUICK_MAX,
  curatedLimit: GUEST_CURATED_MAX,
  hydrated:     false,
  limitsLoaded: false,

  hydrate: () => {
    if (typeof window === "undefined") {
      set({ hydrated: true });
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Daily UTC reset — if the persisted counters are from a
        // previous UTC day, drop them. The backend quota buckets reset
        // at 00:00 UTC and previously the client store had no matching
        // reset path, so a device that exhausted its allowance on Day N
        // stayed at "0 remaining" indefinitely — Day N+1 visitors
        // (or returning ones) couldn't search at all. Silent-cap bug:
        // the search button "did nothing" because the exhaust-modal had
        // its own cooldown (see page.tsx). We now reset counters every
        // UTC day so the local store stays in sync with the server.
        const today = _utcDateKey();
        const persistedDay = typeof parsed?.day === "string" ? parsed.day : "";
        if (persistedDay && persistedDay !== today) {
          // Stale — wipe counters but preserve hydrated state. Persist
          // the fresh zeroed value so a subsequent crash / hydrate
          // doesn't re-trigger the same reset (idempotent).
          _persist(0, 0);
          set({ quickUsed: 0, curatedUsed: 0, hydrated: true });
          return;
        }
        set({
          quickUsed:   Number.isFinite(parsed?.quickUsed)   ? Math.max(0, parsed.quickUsed)   : 0,
          curatedUsed: Number.isFinite(parsed?.curatedUsed) ? Math.max(0, parsed.curatedUsed) : 0,
          hydrated:    true,
        });
        return;
      }
    } catch { /* ignore */ }
    set({ hydrated: true });
  },

  incrementQuick: () => {
    const next = get().quickUsed + 1;
    _persist(next, get().curatedUsed);
    set({ quickUsed: next });
  },

  incrementCurated: () => {
    const next = get().curatedUsed + 1;
    _persist(get().quickUsed, next);
    set({ curatedUsed: next });
  },

  loadServerLimits: async () => {
    try {
      const res = await fetchWithApiFallback("/api/quota-limits");
      if (!res.ok) {
        // 404 / 5xx — keep compile-time defaults, mark loaded so callers
        // unblock. The backend may simply not have shipped this endpoint
        // yet on an older deploy.
        set({ limitsLoaded: true });
        return;
      }
      const data = await res.json();
      // Server payload shape:
      //   { tiers: { anonymous: { quick_search, deep_search, synthesis, ... }, ... }, ... }
      // `null` means unlimited; we collapse to a very large number so the
      // "remaining" math never produces NaN. Frontend doesn't display
      // "unlimited" for guests anyway — anon tier always has finite caps.
      const anon = data?.tiers?.anonymous ?? {};
      const quickRaw   = anon.quick_search;
      // Frontend "Curated" maps to backend "deep_search" (Curated = Deep
      // mode, see ai_gateway._QUOTA_FEATURE_MAP where deep_analysis →
      // deep_search). Earlier the frontend hard-coded curatedLimit=1 but
      // the backend ships anonymous.deep_search=0; this resolves the
      // mismatch in favour of the server.
      const curatedRaw = anon.deep_search;
      const next: Partial<GuestQuotaState> = { limitsLoaded: true };
      if (Number.isFinite(quickRaw)   && quickRaw   >= 0) next.quickLimit   = Math.floor(quickRaw);
      if (Number.isFinite(curatedRaw) && curatedRaw >= 0) next.curatedLimit = Math.floor(curatedRaw);
      set(next);
    } catch {
      // Network failure — fall back to compile-time defaults silently.
      // The user can still use the guest trial; the only downside is the
      // displayed cap may briefly disagree with what the server enforces,
      // and a 429 will surface that mismatch on the next click.
      set({ limitsLoaded: true });
    }
  },

  reset: () => {
    _persist(0, 0);
    set({ quickUsed: 0, curatedUsed: 0 });
  },
}));

// ── Convenience selectors / predicates ──────────────────────────────────────

export const selectGuestQuickUsed   = (s: GuestQuotaState): number => s.quickUsed;
export const selectGuestCuratedUsed = (s: GuestQuotaState): number => s.curatedUsed;
export const selectGuestQuickLimit   = (s: GuestQuotaState): number => s.quickLimit;
export const selectGuestCuratedLimit = (s: GuestQuotaState): number => s.curatedLimit;
export const selectGuestQuickRemaining   = (s: GuestQuotaState): number => Math.max(0, s.quickLimit   - s.quickUsed);
export const selectGuestCuratedRemaining = (s: GuestQuotaState): number => Math.max(0, s.curatedLimit - s.curatedUsed);

/** True if the device has exhausted Quick + Curated allowance — used to
 *  decide whether the next click should fire a search or open the
 *  sign-in popup. Reads the current store snapshot so the result
 *  reflects any server-sourced limit override. */
export function isGuestModeExhausted(mode: "quick" | "curated"): boolean {
  const s = useGuestQuotaStore.getState();
  return mode === "quick"
    ? s.quickUsed   >= s.quickLimit
    : s.curatedUsed >= s.curatedLimit;
}
