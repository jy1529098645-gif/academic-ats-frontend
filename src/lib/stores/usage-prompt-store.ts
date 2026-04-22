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
// Threshold & cadence:
//   Every 4 metered actions we re-open the feedback modal (previously we
//   prompted once at 5 and never again). We need ongoing signal, not a
//   single one-shot ask. To avoid re-prompting the SAME user the same
//   time, we remember the count at which we last prompted; the next
//   multiple of FEEDBACK_PROMPT_THRESHOLD above that count triggers again.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

const STORAGE = {
  count:        "ats-usage-prompt-count",
  prompted:     "ats-usage-prompt-shown-at",     // ISO timestamp or empty string (legacy)
  lastPromptAt: "ats-usage-prompt-last-count",   // integer — usageCount value at last prompt
} as const;

export const FEEDBACK_PROMPT_THRESHOLD = 4;

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

  /** ISO timestamp of when we last showed the feedback modal. Kept for
   *  telemetry / "prompt again after N days" logic; no longer the
   *  primary gate (we use lastPromptedCount for that). */
  promptedAt: string;

  /** usageCount value at the last prompt. Used to decide whether the
   *  current usageCount has crossed a fresh multiple of the threshold
   *  so we can re-prompt on every 4th action rather than just once. */
  lastPromptedCount: number;

  /** Bump the counter by 1. Call this on every successful metered
   *  action (search result arrives, synthesis completes, deep-read
   *  finishes, etc.). Idempotent for a given action — callers should
   *  guard against double-firing (e.g. with a ref). */
  increment: () => void;

  /** Mark the feedback modal as shown. Call on dismiss OR on submit;
   *  records the current usageCount so the next prompt waits another
   *  FEEDBACK_PROMPT_THRESHOLD actions. */
  markPrompted: () => void;

  /** Reset counter + prompt flag. Used by Settings → "Reset local
   *  preferences" if we ever surface that control, and by tests. */
  reset: () => void;
};

export const useUsagePromptStore = create<UsagePromptState>()((set, get) => ({
  usageCount: 0,
  promptedAt: "",
  lastPromptedCount: 0,

  increment: () => {
    const next = get().usageCount + 1;
    _write(STORAGE.count, String(next));
    set({ usageCount: next });
  },

  markPrompted: () => {
    const iso = new Date().toISOString();
    const c   = get().usageCount;
    _write(STORAGE.prompted, iso);
    _write(STORAGE.lastPromptAt, String(c));
    set({ promptedAt: iso, lastPromptedCount: c });
  },

  reset: () => {
    _write(STORAGE.count, "0");
    _write(STORAGE.prompted, "");
    _write(STORAGE.lastPromptAt, "0");
    set({ usageCount: 0, promptedAt: "", lastPromptedCount: 0 });
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
    usageCount:        _readInt(STORAGE.count, 0),
    promptedAt:        _readStr(STORAGE.prompted),
    lastPromptedCount: _readInt(STORAGE.lastPromptAt, 0),
  });
}

/** Convenience selector — returns true when we've crossed the next
 *  multiple of FEEDBACK_PROMPT_THRESHOLD since the last prompt. This
 *  fires the modal repeatedly (every 4 actions by default), not just
 *  once in the browser's lifetime. */
export function shouldPromptFeedback(
  state: Pick<UsagePromptState, "usageCount" | "lastPromptedCount">,
): boolean {
  const { usageCount, lastPromptedCount } = state;
  if (usageCount <= 0) return false;
  if (usageCount <= lastPromptedCount) return false;
  // Fire whenever usageCount is the next multiple of the threshold above
  // lastPromptedCount — i.e. we crossed the boundary in this bump.
  return usageCount % FEEDBACK_PROMPT_THRESHOLD === 0;
}
