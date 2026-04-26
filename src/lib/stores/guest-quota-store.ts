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
// Migration: bump STORAGE_KEY's suffix (`-v1` → `-v2`) if the cap changes
// or the schema needs to drop legacy values.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

/** Max number of Quick searches an anonymous device may run. */
export const GUEST_QUICK_MAX   = 2;
/** Max number of Curated runs an anonymous device may run. */
export const GUEST_CURATED_MAX = 1;

const STORAGE_KEY = "ats-guest-quota-v1";

type GuestQuotaState = {
  quickUsed:   number;
  curatedUsed: number;
  /** True after `hydrate()` has loaded any prior counters from
   *  localStorage. SSR-safe — stays false on the server. */
  hydrated: boolean;

  hydrate:          () => void;
  incrementQuick:   () => void;
  incrementCurated: () => void;
  /** Wipe both counters — call on conversion (anonymous → full account)
   *  or for explicit dev reset, NOT during normal flow. */
  reset: () => void;
};

function _persist(quickUsed: number, curatedUsed: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ quickUsed, curatedUsed }),
    );
  } catch { /* quota / privacy mode — ignore */ }
}

export const useGuestQuotaStore = create<GuestQuotaState>((set, get) => ({
  quickUsed:   0,
  curatedUsed: 0,
  hydrated:    false,

  hydrate: () => {
    if (typeof window === "undefined") {
      set({ hydrated: true });
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
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

  reset: () => {
    _persist(0, 0);
    set({ quickUsed: 0, curatedUsed: 0 });
  },
}));

// ── Convenience selectors / predicates ──────────────────────────────────────

export const selectGuestQuickUsed   = (s: GuestQuotaState): number => s.quickUsed;
export const selectGuestCuratedUsed = (s: GuestQuotaState): number => s.curatedUsed;
export const selectGuestQuickRemaining   = (s: GuestQuotaState): number => Math.max(0, GUEST_QUICK_MAX   - s.quickUsed);
export const selectGuestCuratedRemaining = (s: GuestQuotaState): number => Math.max(0, GUEST_CURATED_MAX - s.curatedUsed);

/** True if the device has exhausted Quick + Curated allowance — used to
 *  decide whether the next click should fire a search or open the
 *  sign-in popup. */
export function isGuestModeExhausted(mode: "quick" | "curated"): boolean {
  const s = useGuestQuotaStore.getState();
  return mode === "quick"
    ? s.quickUsed   >= GUEST_QUICK_MAX
    : s.curatedUsed >= GUEST_CURATED_MAX;
}
