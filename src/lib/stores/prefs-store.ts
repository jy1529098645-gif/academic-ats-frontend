// ─────────────────────────────────────────────────────────────────────────────
// Preferences store — a Zustand slice for user-tunable knobs that don't
// belong to the theme picker (theme-store.ts) or search behaviour.
//
// Everything in here is UX timing — "how long until the announcement
// rotator cycles", "how slow is the day/night cross-fade", etc. The
// defaults mirror the previously-hardcoded constants exactly so the
// out-of-box experience doesn't change for users who never touch
// Settings. Values are persisted to localStorage under per-key slots
// so a reload restores the user's choices.
//
// New preferences should be added here (not to theme-store) so theme
// persistence logic doesn't accumulate unrelated state, and so every
// "Behaviour" slider in Settings maps to a single getter/setter pair.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

const STORAGE = {
  rotator:  "ats-prefs-rotator-interval-ms",
  themeFx:  "ats-prefs-theme-transition-ms",
} as const;

// Defaults — these used to be hardcoded constants in the banner + globals.css.
// Expose them so tests / resets can pin to a known baseline.
export const DEFAULT_ROTATOR_INTERVAL_MS = 6_000;
export const DEFAULT_THEME_TRANSITION_MS = 400;

// Hard limits. Below the min the UI feels jittery; above the max it feels
// broken ("did anything happen?"). Clamp values so a user typing 999999 in
// the numeric input doesn't lock the rotator up for a quarter of an hour.
export const ROTATOR_INTERVAL_MIN = 2_000;   // 2s   — perceptibly changing
export const ROTATOR_INTERVAL_MAX = 30_000;  // 30s  — slow but still "live"
export const THEME_TRANSITION_MIN = 50;      // 50ms — near-instant
export const THEME_TRANSITION_MAX = 1_500;   // 1.5s — buttery, any slower feels laggy

function _clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function _readInt(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return _clamp(Number(raw), min, max, fallback);
  } catch {
    return fallback;
  }
}

function _write(key: string, value: number) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, String(value)); } catch { /* quota — ignore */ }
}

type PrefsState = {
  rotatorIntervalMs:   number;
  themeTransitionMs:   number;

  setRotatorIntervalMs: (ms: number) => void;
  setThemeTransitionMs: (ms: number) => void;

  /** Reset every preference back to its DEFAULT_* baseline. Removes the
   *  persisted values too so a reload confirms the reset. */
  resetAll: () => void;
};

export const usePrefsStore = create<PrefsState>()((set) => ({
  rotatorIntervalMs: DEFAULT_ROTATOR_INTERVAL_MS,
  themeTransitionMs: DEFAULT_THEME_TRANSITION_MS,

  setRotatorIntervalMs: (ms) => {
    const clamped = _clamp(ms, ROTATOR_INTERVAL_MIN, ROTATOR_INTERVAL_MAX, DEFAULT_ROTATOR_INTERVAL_MS);
    _write(STORAGE.rotator, clamped);
    set({ rotatorIntervalMs: clamped });
  },
  setThemeTransitionMs: (ms) => {
    const clamped = _clamp(ms, THEME_TRANSITION_MIN, THEME_TRANSITION_MAX, DEFAULT_THEME_TRANSITION_MS);
    _write(STORAGE.themeFx, clamped);
    set({ themeTransitionMs: clamped });
  },

  resetAll: () => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORAGE.rotator);
        window.localStorage.removeItem(STORAGE.themeFx);
      } catch { /* ignore */ }
    }
    set({
      rotatorIntervalMs: DEFAULT_ROTATOR_INTERVAL_MS,
      themeTransitionMs: DEFAULT_THEME_TRANSITION_MS,
    });
  },
}));

/**
 * Hydrate the preferences from localStorage. Call once inside a client-side
 * useEffect — same pattern as `hydrateThemeStore` in theme-store.ts, so the
 * server-rendered HTML uses the DEFAULT_* baseline and the client swaps in
 * the persisted values after mount without hydration mismatches.
 */
export function hydratePrefsStore(): void {
  usePrefsStore.setState({
    rotatorIntervalMs: _readInt(STORAGE.rotator, DEFAULT_ROTATOR_INTERVAL_MS, ROTATOR_INTERVAL_MIN, ROTATOR_INTERVAL_MAX),
    themeTransitionMs: _readInt(STORAGE.themeFx, DEFAULT_THEME_TRANSITION_MS, THEME_TRANSITION_MIN, THEME_TRANSITION_MAX),
  });
}
