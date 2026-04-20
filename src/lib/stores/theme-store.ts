// ─────────────────────────────────────────────────────────────────────────────
// Theme store — the first slice of Zustand state lifted out of page.tsx.
//
// Why this one first: theme is read from every themed surface in the app but
// written in only a few places (the day/night toggle + the Settings picker).
// Moving it out of page.tsx's local `useState` lets any future screen
// (Settings, Login, Error boundary) read and mutate the same value without
// prop drilling, and cuts one dependency out of the page.tsx render tree.
//
// Persistence rules (unchanged from the previous implementation):
//   - First-time visitors always see Daylight Blue (day) / Midnight Blue
//     (night). Their choice is only remembered once they have explicitly
//     touched a theme control (the "customized" flag).
//   - On first write, we snapshot the current mode + both theme ids so the
//     saved state matches what the user just saw — no flash-back to stale
//     values left over from a pre-flag session.
//
// This module is SSR-safe: all localStorage reads are deferred to a manually-
// invoked `hydrateThemeStore()` that should run inside a useEffect in the
// client-only layout wrapper. Before hydration the store returns the
// registry defaults, so server-rendered HTML matches the first client paint.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from "zustand";
import {
  defaultThemeFor,
  THEME_REGISTRY,
  THEME_STORAGE,
  type ThemeMode,
} from "@/lib/themes";

type ThemeState = {
  mode:         ThemeMode;
  dayThemeId:   string;
  nightThemeId: string;

  setMode:         (next: ThemeMode | ((prev: ThemeMode) => ThemeMode)) => void;
  setDayThemeId:   (id: string) => void;
  setNightThemeId: (id: string) => void;
  /** Shortcut that mirrors the legacy `setTheme(id)` helper in page.tsx. */
  setTheme: (next: string) => void;
};

const _initialMode: ThemeMode = "day";
const _initialDay  = defaultThemeFor("day").id;
const _initialNight = defaultThemeFor("night").id;

function _markCustomized() {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(THEME_STORAGE.customized, "1"); } catch { /* ignore */ }
}

function _persist(mode: ThemeMode, dayId: string, nightId: string) {
  if (typeof window === "undefined") return;
  try {
    const customized = window.localStorage.getItem(THEME_STORAGE.customized) === "1";
    if (!customized) {
      // First interaction — snapshot current values so reload shows the same
      // thing the user just saw, not whatever stale keys were lingering.
      window.localStorage.setItem(THEME_STORAGE.mode,       mode);
      window.localStorage.setItem(THEME_STORAGE.dayTheme,   dayId);
      window.localStorage.setItem(THEME_STORAGE.nightTheme, nightId);
      window.localStorage.setItem(THEME_STORAGE.customized, "1");
      return;
    }
    // Subsequent writes just update the single changed field; the other
    // values in localStorage already reflect the user's choices.
  } catch { /* ignore */ }
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  mode:         _initialMode,
  dayThemeId:   _initialDay,
  nightThemeId: _initialNight,

  setMode: (next) => {
    const prev = get().mode;
    const resolved = typeof next === "function" ? next(prev) : next;
    _persist(resolved, get().dayThemeId, get().nightThemeId);
    try { if (typeof window !== "undefined") window.localStorage.setItem(THEME_STORAGE.mode, resolved); } catch { /* ignore */ }
    _markCustomized();
    set({ mode: resolved });
  },

  setDayThemeId: (id) => {
    _persist(get().mode, id, get().nightThemeId);
    try { if (typeof window !== "undefined") window.localStorage.setItem(THEME_STORAGE.dayTheme, id); } catch { /* ignore */ }
    _markCustomized();
    set({ dayThemeId: id });
  },

  setNightThemeId: (id) => {
    _persist(get().mode, get().dayThemeId, id);
    try { if (typeof window !== "undefined") window.localStorage.setItem(THEME_STORAGE.nightTheme, id); } catch { /* ignore */ }
    _markCustomized();
    set({ nightThemeId: id });
  },

  setTheme: (next) => {
    // Back-compat shim — matches the legacy page.tsx helper.
    if (next === "light") {
      get().setMode("day");
      get().setDayThemeId("light");
      return;
    }
    if (next === "dark") {
      get().setMode("night");
      get().setNightThemeId("dark");
      return;
    }
    const desc = THEME_REGISTRY.find((t) => t.id === next);
    if (!desc) return;
    get().setMode(desc.mode);
    if (desc.mode === "day") get().setDayThemeId(desc.id);
    else                     get().setNightThemeId(desc.id);
  },
}));

/**
 * Load the persisted theme from localStorage on the client. No-op unless the
 * user has previously touched a theme control (the customized flag). Call
 * exactly once, inside a client-side useEffect, so SSR + first client render
 * agree on the initial palette.
 */
export function hydrateThemeStore(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(THEME_STORAGE.customized) !== "1") return;
    const m = window.localStorage.getItem(THEME_STORAGE.mode);
    const d = window.localStorage.getItem(THEME_STORAGE.dayTheme);
    const n = window.localStorage.getItem(THEME_STORAGE.nightTheme);
    useThemeStore.setState((prev) => ({
      mode:         (m === "day" || m === "night") ? m : prev.mode,
      dayThemeId:   (d && THEME_REGISTRY.some((t) => t.id === d && t.mode === "day"))   ? d : prev.dayThemeId,
      nightThemeId: (n && THEME_REGISTRY.some((t) => t.id === n && t.mode === "night")) ? n : prev.nightThemeId,
    }));
  } catch { /* ignore */ }
}

/** Convenience selector for the active theme id (day or night). */
export function selectActiveThemeId(s: ThemeState): string {
  return s.mode === "day" ? s.dayThemeId : s.nightThemeId;
}
