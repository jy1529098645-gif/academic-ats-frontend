// ─────────────────────────────────────────────────────────────────────────────
// useUsage — live subscription + quota snapshot for the signed-in user.
//
// Thin wrapper around GET /api/usage/me. The hook deliberately:
//   - Returns `null` when the caller is anonymous (no flashing auth errors).
//   - Refreshes on mount, on window focus, and whenever `refresh()` is called
//     — the parent screen triggers `refresh()` after every metered action
//     (search / synthesis / deep-read) so the displayed counters match the
//     server-side source of truth without us having to mirror quota state
//     across components.
//   - Swallows network errors into an `error` string; the UI can choose to
//     show a quiet "Usage unavailable" line rather than blocking the modal.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { buildApiUrl, fetchWithAuth } from "@/lib/api";

/** Shape returned by /api/usage/me — mirrors backend `quota.snapshot()`.
 *
 * Quotas were previously monthly; as of this build they are PER DAY and
 * reset at 00:00 UTC. `next_reset_utc` / `now_utc` are ISO-8601 timestamps
 * the frontend uses to render a live countdown without needing its own
 * notion of server time. `year_month` is kept as an optional legacy alias
 * so old clients don't crash while they bounce and refetch.
 */
export type UsageSnapshot = {
  tier: "free" | "basic" | "scholar" | "dev" | "anonymous" | string;
  day_utc?:         string;   // "YYYY-MM-DD"
  next_reset_utc?:  string;   // ISO-8601
  now_utc?:         string;   // ISO-8601
  year_month?:      string;   // legacy
  /** null = unlimited for that feature. */
  limits: {
    quick_search: number | null;
    deep_search:  number | null;
    synthesis:    number | null;
    deep_read:    number | null;
  };
  used: {
    quick_search_count: number;
    deep_search_count:  number;
    synthesis_count:    number;
    deep_read_count:    number;
    llm_cost_usd:       number;
  };
  enforced: boolean;
};

export type UsageState = {
  data:    UsageSnapshot | null;
  loading: boolean;
  error:   string;
  refresh: () => Promise<void>;
};

export function useUsage(isAuthed: boolean): UsageState {
  const [data, setData]       = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string>("");

  const refresh = useCallback(async () => {
    if (!isAuthed) {
      setData(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetchWithAuth(buildApiUrl("/api/usage/me"));
      if (!res.ok) throw new Error(`usage: HTTP ${res.status}`);
      const json = (await res.json()) as UsageSnapshot;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [isAuthed]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh when the tab regains focus — quota changes made elsewhere
  // (e.g. the user running a search in another tab) show up without
  // needing a hard reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { data, loading, error, refresh };
}

/** Human-friendly labels for quota features. */
export const USAGE_FEATURE_LABELS: Record<keyof UsageSnapshot["limits"], string> = {
  quick_search: "Quick Search",
  deep_search:  "Deep Analysis",
  synthesis:    "Synthesis Lab",
  deep_read:    "Deep Read",
};

/** Render a "12 / 150" or "12 / ∞" string. */
export function formatUsage(used: number, limit: number | null): string {
  if (limit === null || limit === undefined) return `${used} · unlimited`;
  return `${used} / ${limit}`;
}

/** 0..1 progress; unlimited returns 0 so progress bars don't fill. */
export function usageRatio(used: number, limit: number | null): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(1, Math.max(0, used / limit));
}
