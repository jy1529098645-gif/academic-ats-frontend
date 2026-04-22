// ─────────────────────────────────────────────────────────────────────────────
// Usage-prompt store — tracks how many "metered actions" (search, synthesis,
// deep-read, PDF translate, etc.) a user has performed across sessions, and
// whether we've already asked them for feedback.
//
// Why client-side (not a Supabase column)?
//   The prompt is a one-time nudge, not a business rule. Tracking it in
//   localStorage means:
//     - zero backend coupling; ship independently
//     - zero write QPS on every search (we'd otherwise bump a column on
//       every /api/search completion)
//     - same-browser de-duplication, which covers 95%+ of the intent
//   Trade-off: a user who clears browser storage or signs in from a new
//   device may see the prompt twice. For a feedback-ask, that's a feature
//   (more signal), not a bug. If cross-device de-duplication becomes
//   important later, add lifetime_usage_count + feedback_prompted_at
//   columns to the profiles table and mirror this state server-side.
//
// Threshold:
//   5 actions — enough that the user has had a real taste of the product
//   and has opinions, but not so many that early-friction feedback is lost.
//   Tunable via FEEDBACK_PROMPT_THRESHOLD.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

const STORAGE = {
  count:     "ats-usage-prompt-count",
  prompted:  "ats-usage-prompt-shown-at",   // ISO timestamp or empty string
} as const;

export const FEEDBACK_PROMPT_THRESHOLD = 5;

function _readInt(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function _readStr(key: string): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(key) || ""; } catch { return ""; }
}

function _write(key: string, value: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, value); } catch { /* quota — ignore */ }
}

type UsagePromptState = {
  /** Monotonic counter of metered actions performed in this browser.
   *  Persisted to localStorage. */
  usageCount: number;

  /** ISO timestamp of when we last showed the feedback modal to the
   *  user. Non-empty = "don't prompt again". Empty string = not yet
   *  prompted. We store the timestamp (not just a bool) so future
   *  "prompt again after 90 days" logic can check it cheaply. */
  promptedAt: string;

  /** Bump the counter by 1. Call this on every successful metered
   *  action (search result arrives, synthesis completes, deep-read
   *  finishes, etc.). Idempotent for a given action — callers should
   *  guard against double-firing (e.g. with a ref). */
  increment: () => void;

  /** Mark the feedback modal as shown. Call on dismiss OR on submit;
   *  the goal is "don't pester". */
  markPrompted: () => void;

  /** Reset counter + prompt flag. Used by Settings → "Reset local
   *  preferences" if we ever surface that control, and by tests. */
  reset: () => void;
};

export const useUsagePromptStore = create<UsagePromptState>()((set, get) => ({
  usageCount: 0,
  promptedAt: "",

  increment: () => {
    const next = get().usageCount + 1;
    _write(STORAGE.count, String(next));
    set({ usageCount: next });
  },

  markPrompted: () => {
    const iso = new Date().toISOString();
    _write(STORAGE.prompted, iso);
    set({ promptedAt: iso });
  },

  reset: () => {
    _write(STORAGE.count, "0");
    _write(STORAGE.prompted, "");
    set({ usageCount: 0, promptedAt: "" });
  },
}));

/**
 * Hydrate the usage-prompt state from localStorage on client mount.
 * Same pattern as hydratePrefsStore / hydrateThemeStore — SSR renders
 * with usageCount=0, promptedAt="", then the client effect swaps in
 * persisted values without a hydration mismatch (values only affect
 * the modal which mounts after all the core UI anyway).
 */
export function hydrateUsagePromptStore(): void {
  useUsagePromptStore.setState({
    usageCount: _readInt(STORAGE.count, 0),
    promptedAt: _readStr(STORAGE.prompted),
  });
}

/** Convenience selector — returns true when we've hit the threshold AND
 *  haven't prompted yet. The main page.tsx effect uses this to decide
 *  whether to auto-open the feedback modal after the next metered action. */
export function shouldPromptFeedback(state: Pick<UsagePromptState, "usageCount" | "promptedAt">): boolean {
  return state.usageCount >= FEEDBACK_PROMPT_THRESHOLD && !state.promptedAt;
}
