// ─────────────────────────────────────────────────────────────────────────────
// /admin — dev-only commercial monitoring dashboard.
//
// Auth architecture (updated):
//   /admin uses a SEPARATE Supabase auth client (`getAdminClient()`) with its
//   own localStorage storage key. This is completely isolated from the main
//   app's auth state — signing in / out of the main app has zero effect on
//   the admin session, and vice-versa. The operator signs in once here with
//   a dev account; the session persists across main-app account switches,
//   reloads, and even tab closes (until it expires or is explicitly signed
//   out from the admin console).
//
//   This replaces the previous "cached refresh token" fallback which had a
//   hard edge case around Supabase token rotation — if the user signed in
//   as a new account in the main app, Supabase could rotate the dev's old
//   refresh token as part of the sign-in flow, killing /admin access. The
//   separate-client approach sidesteps that entirely.
//
//   Server-side: every /api/admin/* endpoint still re-runs `_require_dev`
//   which enforces tier == "dev" OR membership in the email allowlist.
//
// Data flow:
//   - /api/admin/overview            — polled every 30s
//   - /api/admin/system-health       — polled every 30s
//   - /api/admin/usage-timeseries    — refreshed every 5min
//   - /api/admin/users               — refreshed every 5min
//   - /api/admin/announcements-all   — refreshed every 5min
//   - /api/admin/db-stats            — refreshed every 5min
//   - /api/admin/cost-alerts         — refreshed every 5min
//   - /api/admin/errors              — refreshed every 30s
//   - /api/admin/feedback            — refreshed every 30s
// "Live" / "Paused" toggle in the header lets the operator stop ALL
// polling for a stable snapshot. Manual Refresh always works.
//
// Charts are hand-rolled SVG (see `LineChart` / `DonutChart` below) so we
// don't pull in a chart library for a single-page internal tool.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getAdminClient } from "@/lib/supabase/admin-client";
import { buildApiUrl } from "@/lib/api";
import {
  BarChart as BarChartIcon, Users, Activity, MessageSquare, Zap,
  DollarSign, RefreshCw, ArrowLeft, Sparkles,
  FileText, Clock, Database, LogOut,
  Plus, Trash2, Check, X, Megaphone, Inbox, EyeOff,
} from "lucide-react";

// ── Must stay in sync with the same list in src/app/page.tsx ────────────────
const DEV_ACCTS = [
  "dev01@academicats.com",
  "dev02@academicats.com",
  "dev03@academicats.com",
];

// Isolated admin Supabase client — see admin-client.ts for the rationale.
// One instance module-wide so all hooks share the same session state.
const adminSupabase = getAdminClient();

// All admin API calls go through this — the admin client's access token
// is refreshed automatically by Supabase, so we just read the current
// session each request. If the session is missing, callers surface the
// login screen (below) rather than erroring the user out silently.
async function fetchWithAdminAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const { data } = await adminSupabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error("No admin session. Sign in below.");
  }
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> | undefined ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

// Polling intervals — tuned for one-operator alpha. The previous 10s/60s
// pair generated ~20 req/min just from an idle dashboard tab; at scale
// (or under a free-tier quota) that's all wasted budget. The "Pause
// updates" toggle in the toolbar lets the operator drop to zero polling
// when they need a stable snapshot.
const OVERVIEW_POLL_MS = 30_000; // hot KPIs (was 10s)
const DETAIL_POLL_MS   = 300_000; // time-series / users / announcements (was 60s)

// ── API response types ──────────────────────────────────────────────────────

// Per-window aggregate shape — identical for today / week / month so the
// KPI-card renderer can swap between them without per-window branches.
// Only `today` has `day_utc`; `week` and `month` carry a date RANGE
// (start_day_utc..end_day_utc) plus the window length in days.
type UsageWindow = {
  day_utc?:           string;   // today only
  start_day_utc?:     string;   // week / month only
  end_day_utc?:       string;   // week / month only
  window_days?:       number;   // 7 | 30
  active_users:       number;
  quick_search_count: number;
  deep_search_count:  number;
  synthesis_count:    number;
  deep_read_count:    number;
  llm_cost_usd:       number;
};

type Overview = {
  server_time: string;
  users: { total: number; by_tier: Record<string, number>; anonymous?: number };
  conversations: number;
  history_entries: number;
  today: UsageWindow;
  week?:  UsageWindow;           // optional — backends that predate the rolling-window commit omit these
  month?: UsageWindow;
  announcements_total: number;
  feedback_total?: number;       // optional — backends predating the feedback-KPI commit omit these
  feedback_open?:  number;       // unresolved subset
};

type TimeSeriesPoint = {
  day: string;
  active_users:       number;
  quick_search_count: number;
  deep_search_count:  number;
  synthesis_count:    number;
  deep_read_count:    number;
  llm_cost_usd:       number;
};

type AdminUser = {
  id: string;
  email: string | null;
  // Server-side flag: true when email is NULL on the profile row (Supabase
  // anonymous-auth user). The UI uses this to render a Session ID instead
  // of the empty email cell, and to honour the global Hide-anonymous toggle.
  is_anonymous?: boolean;
  tier: "free" | "basic" | "scholar" | "dev" | string;
  tier_updated_at: string | null;
  profile_updated: string | null;
  first_seen_at:   string | null;
  // Synthesised server-side: max(user_usage_daily.updated_at) for this user.
  // Null if the user has never performed a metered action. The list is
  // sorted by this field desc so active users surface above stale signups.
  last_active_at?: string | null;
  // Moderation (server-populated from profiles row)
  is_banned?:   boolean;
  ban_reason?:  string;
  banned_at?:   string | null;
  banned_by?:   string;
  // Bonus quota (gift balance, additive to tier caps)
  bonus?: {
    quick_search: number;
    deep_search:  number;
    synthesis:    number;
    deep_read:    number;
  };
  today: {
    quick_search_count: number;
    deep_search_count:  number;
    synthesis_count:    number;
    deep_read_count:    number;
    llm_cost_usd:       number;
  };
  // `window` carries the per-user counters summed over the operator's
  // selected window (today / 7 / 30 / all). The legacy `today` block
  // is kept on each row for backwards compatibility but the table
  // reads from `window` whenever the operator picks anything other
  // than "today".
  window?: {
    window_days:        number;
    quick_search_count: number;
    deep_search_count:  number;
    synthesis_count:    number;
    deep_read_count:    number;
    llm_cost_usd:       number;
  };
};

type UserSort =
  | "active"      // most-recent activity desc (server default)
  | "email_az"    // alphabetical by email — first letter A → Z
  | "email_za"    // reverse alphabetical
  | "tier"        // dev → scholar → basic → free
  | "quick" | "deep" | "synth" | "chain" | "cost" // today's column desc
  | "first_new"   // signup date — newest first
  | "first_old";  // signup date — oldest first

const USER_SORT_LABEL: Record<UserSort, string> = {
  active:    "most-recent activity",
  email_az:  "email A → Z",
  email_za:  "email Z → A",
  tier:      "tier (dev first)",
  quick:     "quick searches today",
  deep:      "deep searches today",
  synth:     "synthesis runs today",
  chain:     "chain reports today",
  cost:      "cost today",
  first_new: "first seen (newest)",
  first_old: "first seen (oldest)",
};

type ActivityEntry = {
  id:         number;
  created_at: string;
  user_id:    string;
  email:      string;
  action:     string;
  query:      string;
  summary:    string;
};

type AdminAnnouncement = {
  id: string;
  author_id: string | null;
  author_email: string;
  text: string;
  is_public: boolean;
  created_at: string;
};

// Top-N users as returned by /api/admin/top-users — ranked by total cost
// in the rolling window. `email` is denormalised from profiles for easy
// display; tier is normalised to "dev" for allowlisted operators (matches
// the auth gate).
type TopUserRow = {
  user_id:             string;
  email?:              string;
  tier?:               string;
  is_banned?:          boolean;
  total_cost:          number;
  total_actions:       number;
  quick_search_count:  number;
  deep_search_count:   number;
  synthesis_count:     number;
  deep_read_count:     number;
};

// Top-N queries as returned by /api/admin/top-queries.
type TopQueryRow = {
  query:         string;
  count:         number;      // total occurrences in the window
  unique_users:  number;      // distinct user_ids (engagement breadth)
  last_seen_at:  string;
  entry_types:   Record<string, number>;  // per-entry-type breakdown ({"search": 8, "deep_read": 2})
};

// Maintenance-mode singleton as returned by GET /api/maintenance.
// `eta_at` is nullable: when null the countdown is hidden and only the
// static message is rendered to the user-facing overlay.
type MaintenanceStateDto = {
  enabled: boolean;
  message: string;
  eta_at: string | null;
  set_by?: string;
  set_at?: string | null;
};

type DbStats = {
  tables: Array<{ name: string; rows: number }>;
  estimated_bytes:       number;
  free_tier_limit_bytes: number;
};

type AdminError = {
  id:          number;
  created_at:  string;
  source:      "frontend" | "backend";
  user_email:  string | null;
  path:        string | null;
  method:      string | null;
  status_code: number | null;
  error_name:  string | null;
  message:     string | null;
};

type CostAlert = {
  user_id:   string;
  email:     string | null;
  tier:      string;
  cost_usd:  number;
  threshold: number;
  overshoot: number;
  ratio:     number | null;
  counts:    { quick: number; deep: number; synth: number; reads: number };
};

type KeyPoolEntry = {
  key_id?:  string;
  status?:  string;    // "available" | "disabled" | string
  errors?:  number;
  // Other telemetry fields the backend might tack on later; we don't
  // reference them, so `unknown` is fine.
  [k: string]: unknown;
};

type SystemHealth = {
  redis:    { configured: boolean; backend: string; url_set?: boolean; reason?: string };
  key_pool: Record<string, KeyPoolEntry[] | { error?: string }>;
  workers:  number;
  // Live capacity — process-local counters from capacity.py. Optional so
  // this file stays compatible with backends that predate the capacity
  // module (older Railway deploys during rollout).
  capacity?: {
    sse?:          { active: number; peak_since_boot: number };
    llm_last_60s?: {
      window_seconds:  number;
      rpm:             number;
      tpm_in:          number;
      tpm_out:         number;
      cost_window_usd: number;
      errors:          number;
      by_provider:     Record<string, { rpm: number; tpm_in: number; tpm_out: number; cost_window_usd: number; errors: number }>;
    };
    error?: string;
  };
  openai_headroom?: {
    tier: string;
    caps: { rpm: number; tpm: number };
    used: { rpm: number; tpm: number };
    pct:  { rpm: number; tpm: number };
  } | null;
  openai_tiers_available?: string[];
};

// Per-source retrieval stats — one row per academic source (Semantic
// Scholar, OpenAlex, Crossref, arXiv, PubMed, etc.) over the rolling
// window. Drives the "is PubMed broken today?" panel.
type SourceStatRow = {
  source:                string;
  fetches:               number;
  total_papers:          number;
  avg_papers_per_fetch:  number;
  avg_latency_ms:        number;
  p95_latency_ms:        number;
  errors:                number;
  success_rate:          number;      // 0.0 – 1.0
};

// Conversion funnel — 4 stages over the signup cohort in the window.
// Counts are absolute; pct is relative to stage 1 (signed_up).
type FunnelStage = {
  key:   string;
  label: string;
  count: number;
  pct:   number;
};
type FunnelResponse = {
  window_days: number;
  start_utc?:  string;
  end_utc?:    string;
  stages:      FunnelStage[];
  error?:      string;
  // Surfaced by the backend when a schema column was missing and the
  // funnel silently fell back to a different signal (e.g., updated_at
  // instead of first_seen_at). The UI renders this above the chart so
  // operators know to run the migration for accurate data.
  warning?:    string;
};

// ── Audit log row (admin_audit_log table) ──────────────────────────────────
type AuditLogRow = {
  id:           number;
  created_at:   string;
  actor_email:  string;
  action:       string;
  target_type:  string | null;
  target_id:    string | null;
  meta:         Record<string, unknown>;
};

type TierLimitsResponse = {
  defaults:  Record<string, Record<string, number | null>>;
  effective: Record<string, Record<string, number | null>>;
  overrides: Array<{ tier: string; feature: string; limit_value: number | null; updated_at: string | null; updated_by: string | null }>;
};

type FeedbackRow = {
  id:           number;
  created_at:   string;
  user_email:   string | null;
  category:     "bug" | "feature" | "general" | string;
  message:      string;
  page_url:     string | null;
  resolved:     boolean;
  resolved_at:  string | null;
};

// ── Tiny polling hook ───────────────────────────────────────────────────────
// Keeps the polling logic in one place and cleans up correctly on unmount
// or when the user pauses — React StrictMode's double-invoke friendly.

function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled: boolean,
): { data: T | null; error: string; lastUpdated: number; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(0);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const out = await fetcher();
      if (!alive.current) return;
      setData(out);
      setError("");
      setLastUpdated(Date.now());
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fetcher]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    // Kick the first fetch on a microtask so the state update lands in
    // the NEXT render pass rather than cascading mid-effect — satisfies
    // the react-hooks/set-state-in-effect lint. The await inside
    // `refresh()` means the setState calls are already async anyway;
    // this just makes the intent explicit.
    queueMicrotask(() => { void refresh(); });
    const id = window.setInterval(() => { void refresh(); }, intervalMs);
    return () => { alive.current = false; window.clearInterval(id); };
  }, [refresh, intervalMs, enabled]);

  return { data, error, lastUpdated, refresh };
}

// ── Relative-time component ───────────────────────────────────────────────
// Renders "5s ago" / "2m ago" / "1h ago" / "3d ago" given a millisecond
// timestamp + the operator-current `now` ms. Stateless and cheap; the
// parent passes `now` from a 5s-ticking state so the label updates
// without each instance owning its own interval.
function RelativeTime({ ms, now }: { ms: number; now: number }) {
  if (!ms) return <>—</>;
  const elapsedSec = Math.max(0, Math.floor((now - ms) / 1000));
  let label: string;
  if (elapsedSec < 5)            label = "just now";
  else if (elapsedSec < 60)      label = `${elapsedSec}s ago`;
  else if (elapsedSec < 3600)    label = `${Math.floor(elapsedSec / 60)}m ago`;
  else if (elapsedSec < 86400)   label = `${Math.floor(elapsedSec / 3600)}h ago`;
  else                           label = `${Math.floor(elapsedSec / 86400)}d ago`;
  return <span title={new Date(ms).toLocaleString()}>{label}</span>;
}

// ── CSV export helper for All Users ───────────────────────────────────────
// Builds a CSV from the currently-visible roster (filter + window already
// applied by the caller) and triggers a download. Blob URL revoked on the
// next macrotask so the browser doesn't leak handles. The window_days
// gets baked into the filename so an operator looking at three exports
// can tell which is which.
function exportUsersAsCsv(users: AdminUser[], windowDays: number): void {
  const headers = [
    "id", "email", "is_anonymous", "tier", "is_banned",
    "first_seen_at", "last_active_at",
    "quick_search", "deep_search", "synthesis", "deep_read", "llm_cost_usd",
  ];
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [headers.join(",")];
  for (const u of users) {
    const w = u.window ?? u.today;
    lines.push([
      u.id, u.email ?? "", String(!!u.is_anonymous), u.tier, String(!!u.is_banned),
      u.first_seen_at ?? "", u.last_active_at ?? "",
      w.quick_search_count, w.deep_search_count, w.synthesis_count, w.deep_read_count,
      w.llm_cost_usd.toFixed(6),
    ].map(escape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const tag  = windowDays === 0 ? "all-time"
             : windowDays === 1 ? "today"
             : `${windowDays}d`;
  a.href     = url;
  a.download = `ats-admin-users-${tag}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ── Tier colour map ─────────────────────────────────────────────────────────
const TIER_COLORS: Record<string, string> = {
  free:    "#64748b",  // slate-500
  basic:   "#3b82f6",  // blue-500
  scholar: "#10b981",  // emerald-500
  dev:     "#f59e0b",  // amber-500
};

// ── Page component ──────────────────────────────────────────────────────────

export default function AdminPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authEmail,   setAuthEmail]   = useState<string | null>(null);

  // Gate — driven entirely by the ISOLATED admin auth client. Subscribe
  // to its auth state so sign-in / sign-out / refresh events flip the
  // UI without needing a manual reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await adminSupabase.auth.getSession();
        if (cancelled) return;
        setAuthEmail(data.session?.user?.email?.toLowerCase() ?? null);
        setAuthChecked(true);
      } catch {
        setAuthChecked(true);
      }
    })();
    const { data: { subscription } } = adminSupabase.auth.onAuthStateChange((_event, session) => {
      setAuthEmail(session?.user?.email?.toLowerCase() ?? null);
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  const isDev   = authEmail ? DEV_ACCTS.includes(authEmail) : false;
  // "Pause updates" toggle — lets the operator stop ALL polling without
  // signing out. Useful when reviewing a moment-in-time snapshot (e.g.
  // taking a screenshot, debugging a state mid-incident) and the next
  // poll cycle would replace the data they're staring at. Persisted
  // to localStorage so a refresh during an investigation doesn't
  // resume polling unexpectedly. Manual Refresh buttons still work
  // when paused.
  const [pollPaused, setPollPaused] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem("ats-admin-poll-paused") === "1"; } catch { return false; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-poll-paused", pollPaused ? "1" : "0"); } catch { /* ignore */ }
  }, [pollPaused]);
  const enabled = authChecked && isDev && !pollPaused;

  // Coarse "now" ticker for relative-time labels ("fetched 5s ago",
  // "12m ago" etc.). 5s cadence is enough for our resolution and
  // keeps re-render cost negligible. Ticking stops when the operator
  // signs out (component unmounts).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  // ── Time-range state (must precede fetchers that close over it) ────────
  // Chart time-range selector — persisted so a refresh keeps the operator's
  // preferred view. Four windows: last week (daily granularity), month
  // (default), quarter, year.
  const [tsDays, setTsDays] = useState<7 | 30 | 90 | 365>(() => {
    if (typeof window === "undefined") return 30;
    try {
      const raw = window.localStorage.getItem("ats-admin-ts-days");
      const n = parseInt(raw ?? "", 10);
      if ([7, 30, 90, 365].includes(n)) return n as 7 | 30 | 90 | 365;
    } catch { /* ignore */ }
    return 30;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-ts-days", String(tsDays)); } catch { /* ignore */ }
  }, [tsDays]);

  // ── Fetchers ────────────────────────────────────────────────────────────
  // Every admin API call uses fetchWithAdminAuth, which pulls the access
  // token from the ISOLATED admin Supabase client. No dependency on the
  // main app's auth state — if the operator is signed into /admin, these
  // work regardless of which account the main app is using.
  const fetchOverview = useCallback(async (): Promise<Overview> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/overview"));
    if (!res.ok) throw new Error(`overview HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchTimeseries = useCallback(async (): Promise<{ data: TimeSeriesPoint[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/usage-timeseries?days=${tsDays}`));
    if (!res.ok) throw new Error(`timeseries HTTP ${res.status}`);
    return res.json();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tsDays]);

  // `userWindowDays` controls the per-user counter window the All Users
  // table renders (today / 7 / 30 / all-time). Persisted so a refresh
  // during an investigation keeps the operator's chosen view. 0 means
  // all-time (the backend skips the day filter on the user_usage_daily
  // join when window_days=0).
  const [userWindowDays, setUserWindowDays] = useState<0 | 1 | 7 | 30>(() => {
    if (typeof window === "undefined") return 1;
    try {
      const raw = window.localStorage.getItem("ats-admin-user-window");
      const n = raw ? Number(raw) : 1;
      return [0, 1, 7, 30].includes(n) ? (n as 0 | 1 | 7 | 30) : 1;
    } catch { return 1; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-user-window", String(userWindowDays)); } catch { /* ignore */ }
  }, [userWindowDays]);

  const fetchUsers = useCallback(async (): Promise<{ users: AdminUser[] }> => {
    // Default limit 2000 (matches the backend's new upper bound). The
    // backend sorts by last-activity, so ACTIVE users bubble to the
    // top regardless of signup date. window_days={0|1|7|30} chooses
    // whether the per-user counters are today / week / month / all-time.
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/users?limit=2000&window_days=${userWindowDays}`));
    if (!res.ok) throw new Error(`users HTTP ${res.status}`);
    return res.json();
  }, [userWindowDays]);

  const fetchAnnouncements = useCallback(async (): Promise<{ announcements: AdminAnnouncement[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/announcements-all"));
    if (!res.ok) throw new Error(`announcements HTTP ${res.status}`);
    return res.json();
  }, []);

  // ── New integrated-monitoring fetchers ────────────────────────────────
  // DB stats → polled 60s (row counts only; cheap).
  // Errors → polled 30s (forensic tail; should feel near-live).
  // Cost alerts → polled 60s.
  // System health → polled 10s (Redis/key-pool status).
  // Feedback → polled 30s (inbox).
  const fetchDbStats = useCallback(async (): Promise<DbStats> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/db-stats"));
    if (!res.ok) throw new Error(`db-stats HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchErrors = useCallback(async (): Promise<{ errors: AdminError[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/errors?limit=100"));
    if (!res.ok) throw new Error(`errors HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchCostAlerts = useCallback(async (): Promise<{ alerts: CostAlert[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/cost-alerts"));
    if (!res.ok) throw new Error(`cost-alerts HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchSystemHealth = useCallback(async (): Promise<SystemHealth> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/system-health"));
    if (!res.ok) throw new Error(`system-health HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchFeedback = useCallback(async (): Promise<{ feedback: FeedbackRow[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/feedback?limit=100"));
    if (!res.ok) throw new Error(`feedback HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchTierLimits = useCallback(async (): Promise<TierLimitsResponse> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/tier-limits"));
    if (!res.ok) throw new Error(`tier-limits HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchActivity = useCallback(async (): Promise<{ activity: ActivityEntry[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/activity?limit=100"));
    if (!res.ok) throw new Error(`activity HTTP ${res.status}`);
    return res.json();
  }, []);

  // Maintenance singleton — read via the PUBLIC endpoint (no auth needed)
  // so the admin page gets the same state the user-facing MaintenanceGate
  // sees. Writes go through /api/admin/maintenance with the dev Bearer.
  const fetchMaintenance = useCallback(async (): Promise<MaintenanceStateDto> => {
    const res = await fetch(buildApiUrl("/api/maintenance"), { cache: "no-store" });
    if (!res.ok) throw new Error(`maintenance HTTP ${res.status}`);
    return res.json();
  }, []);

  const overview     = usePolling(fetchOverview,     OVERVIEW_POLL_MS, enabled);
  const timeseries   = usePolling(fetchTimeseries,   DETAIL_POLL_MS,   enabled);
  const users        = usePolling(fetchUsers,        DETAIL_POLL_MS,   enabled);
  const announcements= usePolling(fetchAnnouncements,DETAIL_POLL_MS,   enabled);
  const dbStats      = usePolling(fetchDbStats,      DETAIL_POLL_MS,   enabled);
  const errors       = usePolling(fetchErrors,       30_000,           enabled);
  const costAlerts   = usePolling(fetchCostAlerts,   DETAIL_POLL_MS,   enabled);
  const sysHealth    = usePolling(fetchSystemHealth, OVERVIEW_POLL_MS, enabled);
  const feedback     = usePolling(fetchFeedback,     30_000,           enabled);
  const tierLimits   = usePolling(fetchTierLimits,   60_000,           enabled);
  const activity     = usePolling(fetchActivity,     30_000,           enabled);
  const maintenance  = usePolling(fetchMaintenance,  15_000,           enabled);

  // 1 Hz ticking "now" timestamp — drives the live NY + Beijing clock in
  // the header. Cheapest possible setInterval; setting integer-millisecond
  // state values is React-idle compatible. Stops when the page is hidden
  // so the tab doesn't keep ticking in a background window.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ── Maintenance-mode mutations ────────────────────────────────────────
  // Three operations: toggle-on-with-ETA, update-message-only, toggle-off.
  // Each PATCHes the singleton via /api/admin/maintenance (or the
  // "/end" shortcut), then refreshes the panel so the UI reflects
  // what the user-facing gate is now seeing.
  const setMaintenance = async (patch: { enabled?: boolean; message?: string; eta_at?: string }) => {
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/maintenance"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`maintenance PATCH HTTP ${res.status}`);
      await maintenance.refresh();
    } catch (e) {
      alert(`Maintenance update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const endMaintenanceNow = async () => {
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/maintenance/end"), { method: "POST" });
      if (!res.ok) throw new Error(`end-maintenance HTTP ${res.status}`);
      await maintenance.refresh();
    } catch (e) {
      alert(`Go-live failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── User moderation: state + mutations ─────────────────────────────────
  // A single "user detail drawer" hosts all per-user actions (ban, gift
  // quota, tier change, activity feed). Opens on Actions-button click in
  // the UserTable row. Keeping it one drawer instead of four separate
  // modals keeps the admin's mental model simple ("here's this user →
  // do stuff to them") and avoids 5 levels of modal stacking.
  const [userDrawer, setUserDrawer] = useState<AdminUser | null>(null);
  // All-users sort. Default 'active' = most-recent activity desc (matches
  // the server's default order); 'email_az' / 'email_za' add the explicit
  // alphabetical sort the panel was missing; the rest mirror the table's
  // numeric / date columns so an admin can re-rank without leaving the
  // page. Persists to localStorage so the choice sticks across reloads.
  const [userSort, setUserSort] = useState<UserSort>(() => {
    if (typeof window === "undefined") return "active";
    const saved = localStorage.getItem("ats-admin-user-sort") as UserSort | null;
    return saved ?? "active";
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("ats-admin-user-sort", userSort);
  }, [userSort]);

  // ── Collapsed panel tracking ──────────────────────────────────────
  // Single Set of panel-ids that the operator has collapsed. Every
  // heavy-content panel has a caret in its header + reads this state
  // to decide whether to render its body. Persisted to localStorage so
  // a refresh keeps the admin's preferred compact view. Panels default
  // to EXPANDED (not in the set) — the user opts to hide things,
  // nothing vanishes on first load.
  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem("ats-admin-collapsed-panels");
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  const isPanelOpen = (id: string) => !collapsedPanels.has(id);
  const togglePanel = (id: string) => {
    setCollapsedPanels(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else              next.add(id);
      if (typeof window !== "undefined") {
        try { window.localStorage.setItem("ats-admin-collapsed-panels", JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  };

  // ── KPI hero time-window ────────────────────────────────────────────────
  // Which window's totals the KPI cards render: today's (default),
  // rolling 7d, or rolling 30d. The backend returns all three in one
  // /api/admin/overview response, so switching is instant (no extra
  // fetch). Persisted to localStorage so a refresh keeps the admin's
  // preferred view — operators who monitor the weekly trend don't get
  // bumped back to "today" every page load.
  const [kpiWindow, setKpiWindow] = useState<"today" | "week" | "month">(() => {
    if (typeof window === "undefined") return "today";
    try {
      const raw = window.localStorage.getItem("ats-admin-kpi-window");
      if (raw === "week" || raw === "month" || raw === "today") return raw;
    } catch { /* ignore */ }
    return "today";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-kpi-window", kpiWindow); } catch { /* ignore */ }
  }, [kpiWindow]);

  // Top-N users by cost + top-N queries — the "who is burning money"
  // and "what are they asking about" panels. They have their OWN
  // independent window toggles (decoupled from the KPI hero window)
  // because operators often want "today's cost leaders" while looking
  // at "this month's retention numbers" above — the two panels answer
  // different questions. Each panel's window is persisted separately
  // so the admin's preferred view per panel survives a refresh.
  const [topUsersWindow,   setTopUsersWindow]   = useState<"today" | "week" | "month" | "year">(() => {
    if (typeof window === "undefined") return "week";
    try {
      const raw = window.localStorage.getItem("ats-admin-top-users-window");
      if (raw === "today" || raw === "week" || raw === "month" || raw === "year") return raw;
    } catch { /* ignore */ }
    return "week";
  });
  const [topQueriesWindow, setTopQueriesWindow] = useState<"today" | "week" | "month" | "year">(() => {
    if (typeof window === "undefined") return "week";
    try {
      const raw = window.localStorage.getItem("ats-admin-top-queries-window");
      if (raw === "today" || raw === "week" || raw === "month" || raw === "year") return raw;
    } catch { /* ignore */ }
    return "week";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-top-users-window", topUsersWindow); } catch { /* ignore */ }
  }, [topUsersWindow]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-top-queries-window", topQueriesWindow); } catch { /* ignore */ }
  }, [topQueriesWindow]);

  // ── Per-user analytics filter ─────────────────────────────────────────
  // Frontend-only filter that hides specific accounts (and optionally ALL
  // tier="dev" accounts) from the per-user panels: All-users table, Top
  // users by cost, Activity feed, Cost alerts, Feedback inbox. The
  // aggregate cards (KPIs / time-series / conversion funnel) intentionally
  // stay UNFILTERED — those numbers are pre-aggregated server-side and
  // would need a backend query parameter to slice by user. We surface a
  // small caption on the toolbar so operators know the limitation.
  //
  // Why not just exclude dev accounts globally? Sometimes the admin DOES
  // want to see dev traffic (e.g., verifying a smoke test went through).
  // A toggle keeps the choice runtime-controllable without redeploys, and
  // the explicit chip-list lets ops hide individual non-dev accounts
  // (test recruiters, abuse cases, etc.) without polluting analytics.
  const [hideDevs, setHideDevs] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem("ats-admin-hide-devs") === "1"; } catch { return false; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-hide-devs", hideDevs ? "1" : "0"); } catch { /* ignore */ }
  }, [hideDevs]);

  // Hide-anonymous toggle. Mirrors hideDevs: persisted to localStorage and
  // wired through isUserIdHidden so EVERY user-keyed panel (user table,
  // top users, activity feed, cost alerts, feedback inbox) drops anon rows
  // when on. The Signed-in users KPI also subtracts ov.users.anonymous when
  // this is enabled, so the headline number stays consistent.
  const [hideAnon, setHideAnon] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem("ats-admin-hide-anon") === "1"; } catch { return false; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-hide-anon", hideAnon ? "1" : "0"); } catch { /* ignore */ }
  }, [hideAnon]);

  // extraHidden: Set of user_ids the admin has manually opted to hide.
  // Persisted as a JSON array. Adding by email looks up the user_id via
  // userEmailToId below (we always store user_id internally so the chip
  // survives email changes).
  const [extraHidden, setExtraHidden] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem("ats-admin-extra-hidden");
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("ats-admin-extra-hidden", JSON.stringify([...extraHidden])); } catch { /* ignore */ }
  }, [extraHidden]);

  // ── Anonymous cleanup modal state ─────────────────────────────────────
  // Two-step: clicking "Clean unused anon" first OPENS the modal and fetches
  // the candidate list; the operator reviews; then a separate "Delete N
  // rows" button inside the modal sends the POST. Server re-verifies each
  // id is still safe to delete (TOCTOU protection) and returns a
  // {deleted, skipped} summary which we surface inline.
  type AnonCandidate = { id: string; first_seen_at: string | null };
  const [anonCleanupOpen, setAnonCleanupOpen]           = useState(false);
  const [anonCleanupLoading, setAnonCleanupLoading]     = useState(false);
  const [anonCleanupCandidates, setAnonCleanupCandidates] = useState<AnonCandidate[]>([]);
  const [anonCleanupDays, setAnonCleanupDays]           = useState(7);
  const [anonCleanupError, setAnonCleanupError]         = useState<string>("");
  const [anonCleanupResult, setAnonCleanupResult]       = useState<{ deleted: number; skipped: number } | null>(null);

  const openAnonCleanup = useCallback(async () => {
    setAnonCleanupOpen(true);
    setAnonCleanupResult(null);
    setAnonCleanupError("");
    setAnonCleanupLoading(true);
    setAnonCleanupCandidates([]);
    try {
      const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/anonymous-cleanup?older_than_days=${anonCleanupDays}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { candidates: AnonCandidate[] };
      setAnonCleanupCandidates(data.candidates ?? []);
    } catch (e) {
      setAnonCleanupError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnonCleanupLoading(false);
    }
  }, [anonCleanupDays]);

  const confirmAnonCleanup = useCallback(async () => {
    if (anonCleanupCandidates.length === 0) return;
    setAnonCleanupLoading(true);
    setAnonCleanupError("");
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/anonymous-cleanup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_ids: anonCleanupCandidates.map(c => c.id) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { deleted: string[]; skipped: string[] };
      setAnonCleanupResult({ deleted: data.deleted?.length ?? 0, skipped: data.skipped?.length ?? 0 });
      setAnonCleanupCandidates([]);
      // Pull a fresh user list so the table reflects the deletions immediately.
      try { users.refresh(); overview.refresh(); } catch { /* refresh is best-effort */ }
    } catch (e) {
      setAnonCleanupError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnonCleanupLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anonCleanupCandidates]);

  const fetchTopUsers = useCallback(async (): Promise<{ users: TopUserRow[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/top-users?window=${topUsersWindow}&limit=10`));
    if (!res.ok) throw new Error(`top-users HTTP ${res.status}`);
    return res.json();
  }, [topUsersWindow]);

  const fetchTopQueries = useCallback(async (): Promise<{ queries: TopQueryRow[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/top-queries?window=${topQueriesWindow}&limit=15`));
    if (!res.ok) throw new Error(`top-queries HTTP ${res.status}`);
    return res.json();
  }, [topQueriesWindow]);

  // Pollers for the top-N panels. Declared AFTER kpiWindow + the
  // fetchers because both depend on `kpiWindow` being initialised.
  const topUsers   = usePolling(fetchTopUsers,   DETAIL_POLL_MS, enabled);
  const topQueries = usePolling(fetchTopQueries, DETAIL_POLL_MS, enabled);

  // Admin audit log — polled at the same cadence as the error log
  // because both are "forensic" signals that the admin might be
  // consulting reactively during an incident.
  const fetchAuditLog = useCallback(async (): Promise<{ rows: AuditLogRow[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/audit-log?limit=200"));
    if (!res.ok) throw new Error(`audit-log HTTP ${res.status}`);
    return res.json();
  }, []);
  const auditLog = usePolling(fetchAuditLog, 30_000, enabled);

  // Per-source retrieval stats — rolling 15-min window. Polled
  // frequently because "PubMed just went down" is a signal the admin
  // wants fast.
  const fetchSourceStats = useCallback(async (): Promise<{ sources: SourceStatRow[]; window_seconds: number }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/source-stats?window_seconds=900"));
    if (!res.ok) throw new Error(`source-stats HTTP ${res.status}`);
    return res.json();
  }, []);
  const sourceStats = usePolling(fetchSourceStats, 30_000, enabled);

  // Usage-tracking health probe — diffs today's history_entries vs.
  // user_usage_daily so a broken increment_user_usage_daily RPC is
  // visible at a glance instead of silently skewing every per-user
  // KPI. Polled at the slower DETAIL_POLL_MS rate because a write-path
  // regression doesn't change minute-to-minute and the operator just
  // needs an hourly-ish heads-up.
  const fetchUsageHealth = useCallback(async (): Promise<{ day_utc: string; history_users: number; usage_daily_users: number; missing_from_usage_daily: string[]; ok: boolean }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/usage-tracking-health"));
    if (!res.ok) throw new Error(`usage-tracking-health HTTP ${res.status}`);
    return res.json();
  }, []);
  const usageHealth = usePolling(fetchUsageHealth, DETAIL_POLL_MS, enabled);

  // Conversion funnel — scopes to `tsDays` (same window as the Usage
  // chart) so admins can see alpha retention across different
  // observation windows without adding a second toggle.
  const fetchFunnel = useCallback(async (): Promise<FunnelResponse> => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/conversion-funnel?days=${tsDays}`));
    if (!res.ok) throw new Error(`funnel HTTP ${res.status}`);
    return res.json();
  }, [tsDays]);
  const funnel = usePolling(fetchFunnel, DETAIL_POLL_MS, enabled);

  // Per-user mutations. These intentionally do NOT catch — errors
  // propagate to the caller (UserDetailDrawer) so it can decide whether
  // to keep the drawer open and show a row-local error. Previously the
  // catch-and-alert pattern here meant the drawer's `await onBan(...)`
  // saw a successful resolution even on HTTP failure, then ran
  // `onClose()` regardless — the alert popped up but the drawer
  // disappeared with it, making it look like the action had been
  // "accepted but warned about" rather than rejected. The drawer is
  // the only caller, so making these re-throw is safe.
  const setUserBan = async (userId: string, banned: boolean, reason?: string) => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/users/${userId}/ban`), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ banned, reason: reason ?? null }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${banned ? "ban" : "unban"} HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    await users.refresh();
  };

  const grantUserQuota = async (userId: string, grants: {quick_search?:number; deep_search?:number; synthesis?:number; deep_read?:number}) => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/users/${userId}/grant-quota`), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(grants),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`grant-quota HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    await users.refresh();
  };

  const setUserTier = async (userId: string, tier: string) => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/users/${userId}/tier`), {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ tier }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`tier PATCH HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    await users.refresh();
  };

  // Send a dev-composed popup notification to one user. Body is short
  // prose (< 1200 chars); the recipient sees it as a modal on their
  // next page load. Server-side this also writes to admin_audit_log.
  const notifyUser = async (
    userId: string,
    payload: { title: string; body: string; emoji?: string; kind?: string },
  ) => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/users/${userId}/notify`), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`notify HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  };

  const fetchUserActivity = async (userId: string): Promise<{ activity: Array<{ id: string; entry_type: string; query: string; summary: string; created_at: string }> }> => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/users/${userId}/activity?limit=50`));
    if (!res.ok) throw new Error(`user-activity HTTP ${res.status}`);
    return res.json();
  };

  // ── Announcement deletion: three scopes (by-id / user-posted / all) ────
  // Backend exposes three dev-gated DELETE endpoints. The UI surfaces
  // them all — per-row pill for surgical cleanup, two header buttons
  // for bulk operations. Every destructive call goes through confirm()
  // with a concrete message so it's clear what's about to vanish.
  const deleteOneAnnouncement = async (id: string) => {
    if (!confirm("Delete this announcement? This cannot be undone.")) return;
    try {
      const res = await fetchWithAdminAuth(buildApiUrl(`/api/announcements/${id}`), { method: "DELETE" });
      if (!res.ok) throw new Error(`delete HTTP ${res.status}`);
      await announcements.refresh();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Edit an announcement's text in-place. Backend PATCH endpoint is
  // dev-gated and tolerates editing any row (including user-posted ones,
  // useful for trimming spam without deleting). The inline editor
  // handles confirmation; this fn just fires the PATCH + refresh.
  const editOneAnnouncement = async (id: string, newText: string) => {
    const trimmed = (newText || "").trim();
    if (trimmed.length < 3) { alert("Announcement text must be at least 3 characters."); return; }
    try {
      const res = await fetchWithAdminAuth(buildApiUrl(`/api/announcements/${id}`), {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) throw new Error(`patch HTTP ${res.status}`);
      await announcements.refresh();
    } catch (e) {
      alert(`Edit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const deleteAllUserAnnouncements = async () => {
    const userPostedCount = (announcements.data?.announcements ?? []).filter(a => a.author_email !== "dev@academicats.com").length;
    if (!confirm(`Clear all ${userPostedCount} user-posted announcements? Seed messages (dev@academicats.com) will be kept. Cannot be undone.`)) return;
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/announcements/user"), { method: "DELETE" });
      if (!res.ok) throw new Error(`delete HTTP ${res.status}`);
      await announcements.refresh();
    } catch (e) {
      alert(`Bulk delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const nukeAllAnnouncements = async () => {
    const total = (announcements.data?.announcements ?? []).length;
    if (!confirm(`Delete ALL ${total} announcements — including seed messages? Hard reset. Cannot be undone.`)) return;
    if (!confirm("Are you absolutely sure? This wipes the entire announcement feed.")) return;
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/announcements/all"), { method: "DELETE" });
      if (!res.ok) throw new Error(`delete HTTP ${res.status}`);
      await announcements.refresh();
    } catch (e) {
      alert(`Nuke-all failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Recommended-term pool ───────────────────────────────────────────────
  // CRUD on the admin-managed pool that backs the workspace landing chips.
  // Independent state — not part of the auto-poll set since the pool is
  // edited rarely and a manual Refresh button covers it.
  type RecTermRow = {
    id:         number;
    text:       string;
    active:     boolean;
    created_at: string;
    updated_at: string;
  };
  const [recTerms, setRecTerms]           = useState<RecTermRow[]>([]);
  const [recTermsLoading, setRecTermsLoading] = useState(false);
  const [recTermsError, setRecTermsError] = useState<string>("");
  const [newRecTerm, setNewRecTerm]       = useState<string>("");
  const refreshRecTerms = useCallback(async () => {
    setRecTermsLoading(true);
    setRecTermsError("");
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/recommended-terms"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { terms?: RecTermRow[] };
      setRecTerms(data.terms ?? []);
    } catch (e) {
      setRecTermsError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecTermsLoading(false);
    }
  }, []);
  // Only auto-fetch the rec-terms pool once the operator is authenticated
  // AND has dev clearance. Firing this fetch on the login screen leaves a
  // dangling rejected promise (no admin session) every page load — harmless
  // in dev, but on Vercel it would surface in /admin/__sentry/... reports
  // and confuse on-call. `enabled` is the auth gate the rest of the dashboard
  // uses, so we mirror it here.
  useEffect(() => {
    if (!enabled) return;
    void refreshRecTerms();
  }, [enabled, refreshRecTerms]);

  const createRecTerm = async () => {
    const trimmed = newRecTerm.trim();
    if (!trimmed) return;
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/recommended-terms"), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNewRecTerm("");
      await refreshRecTerms();
    } catch (e) {
      alert(`Add failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const toggleRecTerm = async (row: RecTermRow) => {
    try {
      const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/recommended-terms/${row.id}`), {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ active: !row.active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshRecTerms();
    } catch (e) {
      alert(`Toggle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const editRecTerm = async (row: RecTermRow, nextText: string) => {
    const trimmed = nextText.trim();
    if (!trimmed || trimmed === row.text) return;
    try {
      const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/recommended-terms/${row.id}`), {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshRecTerms();
    } catch (e) {
      alert(`Edit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const deleteRecTerm = async (row: RecTermRow) => {
    if (!confirm(`Delete "${row.text}"? Cannot be undone.`)) return;
    try {
      const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/recommended-terms/${row.id}`), {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshRecTerms();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Force the LLM-distilled daily pool to regenerate on the next public
  // fetch. Different from `refreshRecTerms` above which only reloads the
  // admin-curated `recommended_terms` table — this hits the dedicated
  // `/api/admin/recommended-terms/refresh` route which invalidates the
  // in-process LLM cache (see backend recommended_terms_generator.clear_daily_cache).
  // Useful when the admin notices the daily-trending chips look stale or
  // wants to test a code change without waiting for UTC midnight.
  const regenerateLlmPool = async () => {
    if (!confirm("Regenerate the LLM-distilled trending pool? This invalidates the daily cache; the next public fetch will spend a few seconds re-querying OpenAlex/arXiv.")) return;
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/recommended-terms/refresh"), {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      alert("LLM pool cleared — next public fetch will regenerate it.");
    } catch (e) {
      alert(`Regenerate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const refreshAll = () => {
    overview.refresh();
    timeseries.refresh();
    users.refresh();
    announcements.refresh();
    dbStats.refresh();
    errors.refresh();
    costAlerts.refresh();
    sysHealth.refresh();
    feedback.refresh();
    tierLimits.refresh();
    activity.refresh();
    void refreshRecTerms();
  };

  // Batch-save every pending tier-limit edit. The editor accumulates
  // drafts locally; clicking Save builds one PATCH per dirty cell,
  // awaits them all, then refreshes the polled data so the live
  // "effective" values redraw. Any individual PATCH failing throws
  // back to the editor's error state so the user sees which save
  // didn't take.
  //
  // `limit` semantics (mirror backend): null → reset override to code
  // default; -1 → "unlimited" (stored as NULL); >= 0 → numeric cap.
  const saveTierLimitsBatch = async (
    updates: Array<{ tier: string; feature: string; limit: number | null }>,
  ): Promise<void> => {
    for (const u of updates) {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/tier-limits"), {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tier: u.tier, feature: u.feature, limit_value: u.limit }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    }
    tierLimits.refresh();
  };

  // Resolve / unresolve a feedback row (dev action — flips the flag).
  // Re-throws on failure so FeedbackInbox can show a row-local busy state
  // and unwind it; previously the catch swallowed errors into console
  // only, so a failed PATCH looked indistinguishable from success — the
  // row's Resolve / Reopen pill never updated and the admin assumed it
  // worked. The visible alert is the floor; refreshing on success keeps
  // the optimistic UI in sync with the persisted flag.
  const toggleFeedbackResolved = async (id: number, next: boolean) => {
    const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/feedback/${id}`), {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ resolved: next }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`resolve HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    await feedback.refresh();
  };

  // ── Derived values (must compute BEFORE the gate-screen early returns
  //    so every hook below — useMemo for userList in particular — is
  //    called on every render). React #310 ("Rendered more hooks than
  //    during the previous render") fires the moment the auth state
  //    flips between login screen and authenticated, because hooks
  //    AFTER the early returns suddenly start running. Lifting them
  //    above the returns keeps the hook count stable. ──────────────────
  const ov = overview.data;
  // Timeseries comes back keyed by UTC day. Drop any bucket whose UTC
  // date is AHEAD of NY's current date — happens during the 4-5 hour
  // evening window in NY when UTC has rolled to the next calendar day
  // but the dev's clock hasn't. Without this, the rightmost tick on
  // the chart shows "tomorrow" from the dev's perspective (the user-
  // reported bug: "目前还没到27号才26号"). The filtered bucket is
  // typically near-empty anyway (just an hour or two of UTC-tomorrow
  // activity) so dropping it doesn't lose meaningful signal.
  const _nyTodayKey = _NY_DATE_FMT.format(new Date());  // "YYYY-MM-DD" in NY
  const ts = (timeseries.data?.data ?? []).filter(p => p.day <= _nyTodayKey);
  // Memoised so the userIdToTier / userEmailToId / userList useMemos
  // below don't see a fresh `[]` reference on every render and re-run
  // unnecessarily.
  const rawUserList = useMemo(() => users.data?.users ?? [], [users.data]);
  const annList  = announcements.data?.announcements ?? [];

  // ── Filter lookup maps ───────────────────────────────────────────────
  // user_id → tier so we can decide "is this person a dev" for panels
  // whose row type doesn't carry tier (Activity feed). email → user_id so
  // the toolbar can accept a typed-in email and resolve it to a stable
  // user_id (which is what we actually persist), and so the Feedback
  // inbox (which only carries email) can be filtered.
  const userIdToTier = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of rawUserList) m.set(u.id, u.tier);
    return m;
  }, [rawUserList]);
  const userEmailToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of rawUserList) if (u.email) m.set(u.email.toLowerCase(), u.id);
    return m;
  }, [rawUserList]);
  // Anonymous user_id set — derived from server-tagged is_anonymous so panels
  // whose row shape only carries user_id (top users, activity feed, cost
  // alerts) can also drop anon rows when the global toggle is on.
  const userIdAnonymous = useMemo(() => {
    const s = new Set<string>();
    for (const u of rawUserList) if (u.is_anonymous) s.add(u.id);
    return s;
  }, [rawUserList]);

  // Two predicates (one keyed by user_id, one by email) — every panel
  // calls the one that matches its row shape. Both honour the global
  // `hideDevs` / `hideAnon` toggles + the explicit `extraHidden` set.
  const isUserIdHidden = useCallback((userId: string | null | undefined, tier?: string | null): boolean => {
    if (!userId) return false;
    if (extraHidden.has(userId)) return true;
    const t = tier ?? userIdToTier.get(userId);
    if (hideDevs && t === "dev") return true;
    if (hideAnon && userIdAnonymous.has(userId)) return true;
    return false;
  }, [extraHidden, hideDevs, hideAnon, userIdToTier, userIdAnonymous]);
  const isEmailHidden = useCallback((email: string | null | undefined): boolean => {
    if (!email) return false;
    const uid = userEmailToId.get(email.toLowerCase());
    if (!uid) return false;
    return isUserIdHidden(uid);
  }, [userEmailToId, isUserIdHidden]);

  // Add by typed input (UUID or email). Email path resolves to user_id so
  // we always persist a stable id. Returns null on success, error string
  // on failure (caller surfaces it inline, not via alert()).
  const addExtraHidden = useCallback((rawInput: string): string | null => {
    const v = (rawInput || "").trim().toLowerCase();
    if (!v) return "Enter a UUID or email";
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    let userId = v;
    if (v.includes("@")) {
      const found = userEmailToId.get(v);
      if (!found) return `No signed-in user with email "${v}" — they may not have logged in yet`;
      userId = found;
    } else if (!isUuid) {
      return "Not a valid UUID or email";
    }
    setExtraHidden(prev => {
      if (prev.has(userId)) return prev;
      const next = new Set(prev);
      next.add(userId);
      return next;
    });
    return null;
  }, [userEmailToId]);
  const removeExtraHidden = useCallback((uid: string) => {
    setExtraHidden(prev => {
      if (!prev.has(uid)) return prev;
      const next = new Set(prev);
      next.delete(uid);
      return next;
    });
  }, []);

  // Free-text search input on the All Users panel. Matches against email
  // substring (case-insensitive) and the leading 8 hex of the user_id
  // (so an operator with a session id can paste it). Empty = no filter.
  const [userSearch, setUserSearch] = useState("");

  // Sorted + filtered view of the user list. Sort reads from `window`
  // (current operator-selected counter window) with `today` as the
  // legacy fallback for any row a stale backend might still serve.
  // Filter happens AFTER sort so the visible roster matches the
  // toolbar (rather than silently shrinking the count below).
  const userList = useMemo(() => {
    const arr = rawUserList.slice();
    const win = (u: AdminUser) => u.window ?? u.today;
    const cmpStr  = (a: string | null | undefined, b: string | null | undefined) =>
      (a ?? "").toLocaleLowerCase().localeCompare((b ?? "").toLocaleLowerCase());
    const cmpDate = (a: string | null | undefined, b: string | null | undefined) =>
      (b ? new Date(b).getTime() : 0) - (a ? new Date(a).getTime() : 0);
    const TIER_RANK: Record<string, number> = { dev: 0, scholar: 1, basic: 2, free: 3 };
    switch (userSort) {
      case "email_az": arr.sort((a, b) => cmpStr(a.email, b.email)); break;
      case "email_za": arr.sort((a, b) => cmpStr(b.email, a.email)); break;
      case "tier":     arr.sort((a, b) => (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99)); break;
      case "quick":    arr.sort((a, b) => win(b).quick_search_count - win(a).quick_search_count); break;
      case "deep":     arr.sort((a, b) => win(b).deep_search_count  - win(a).deep_search_count);  break;
      case "synth":    arr.sort((a, b) => win(b).synthesis_count    - win(a).synthesis_count);    break;
      case "chain":    arr.sort((a, b) => win(b).deep_read_count    - win(a).deep_read_count);    break;
      case "cost":     arr.sort((a, b) => win(b).llm_cost_usd       - win(a).llm_cost_usd);       break;
      case "first_new":arr.sort((a, b) => cmpDate(a.first_seen_at, b.first_seen_at)); break;
      case "first_old":arr.sort((a, b) => -cmpDate(a.first_seen_at, b.first_seen_at)); break;
      case "active":
      default:         arr.sort((a, b) => cmpDate(a.last_active_at, b.last_active_at)); break;
    }
    const filtered = arr.filter(u => !isUserIdHidden(u.id, u.tier));
    const q = userSearch.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter(u => {
      const e = (u.email || "").toLowerCase();
      const idPrefix = (u.id || "").toLowerCase().slice(0, 8);
      return e.includes(q) || idPrefix.includes(q);
    });
  }, [rawUserList, userSort, userSearch, isUserIdHidden]);

  // ── Gate screens ────────────────────────────────────────────────────────
  // All three gate screens inherit the day-mint theme wrapper below so
  // even an unauthorised visitor sees the correct palette (no brief dark
  // flash before the login redirect).
  if (!authChecked) {
    return (
      <div data-theme="day-mint" data-tone="day" className="admin-main h-screen bg-[var(--ats-bg-base)] flex items-center justify-center">
        <p className="text-sm" style={{ color: "var(--ats-fg-muted)" }}>Checking access…</p>
      </div>
    );
  }

  // No admin session OR non-dev email signed in → show the dedicated
  // admin login. This is the ONLY surface where the operator authenticates
  // the admin context; the main app's session is irrelevant here. A
  // successful sign-in writes tokens to `ats-admin-auth-token` in
  // localStorage, from which the client auto-refreshes going forward.
  if (!authEmail || !isDev) {
    return <AdminLoginScreen currentEmail={authEmail} />;
  }

  // Pinned to Morning Mint (day-mint, emerald accents). The admin console
  // is a daytime tool — dev eyes spend hours reading numbers, so we
  // deliberately force a light theme rather than following the main app's
  // day/night toggle. Tokens flow from the [data-theme="day-mint"] block
  // in globals.css, so every var(--ats-*) below picks up the correct
  // green palette automatically.
  //
  // `h-screen overflow-y-auto thin-scrollbar` makes THIS div the scroll
  // container for the whole admin page. Without it the layout's
  // body{overflow:hidden} would clip overflowing sections. The
  // thin-scrollbar class styles the native scrollbar to match the theme
  // (6px width, accent-coloured thumb, transparent track) — same
  // treatment used by the panels on the main page.
  return (
    <div
      data-theme="day-mint"
      data-tone="day"
      className="admin-main h-screen overflow-y-auto thin-scrollbar bg-[var(--ats-bg-base)] text-[var(--ats-fg-primary)]"
    >
      {/* ── Header ────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-30 backdrop-blur-md border-b"
        style={{
          backgroundColor: "color-mix(in srgb, var(--ats-bg-base) 80%, transparent)",
          borderColor:     "var(--ats-border-subtle)",
        }}
      >
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center gap-4">
          <Link
            href="/"
            className="shrink-0 inline-flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: "var(--ats-fg-secondary)" }}
          >
            <ArrowLeft size={14} />
            Back
          </Link>
          <div className="flex items-center gap-2">
            <BarChartIcon size={18} style={{ color: "var(--ats-fg-accent)" }} />
            <h1 className="text-base font-bold" style={{ color: "var(--ats-fg-primary)" }}>
              AcademiCats · Admin
            </h1>
            <span
              className="text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 font-bold border"
              style={{
                backgroundColor: "var(--ats-bg-accent-soft)",
                color:           "var(--ats-fg-accent)",
                borderColor:     "var(--ats-border-accent)",
              }}
            >
              DEV
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3 text-[11px]" style={{ color: "var(--ats-fg-secondary)" }}>
            {/* Live NY + Beijing clock — server reference time on the
                left, Beijing reference on the right. The clock ticks
                every second via the nowTick interval declared above.
                Same Intl formatters as fmtDateTime so the displayed
                time matches the format in tables / activity feed
                exactly. Hidden on narrow viewports to keep the
                Refresh / Sign out controls visible. */}
            <span
              className="hidden md:inline-flex items-center gap-1.5 tabular-nums"
              title="Server reference time. All admin tables show timestamps in NY time."
            >
              <Clock size={11} />
              <span style={{ color: "var(--ats-fg-primary)" }}>
                NY {(() => {
                  const d = new Date(nowTick);
                  return _NY_DATETIME_FMT.format(d).replace(", ", " ").slice(11, 16);
                })()}
              </span>
              <span style={{ color: "var(--ats-fg-muted)" }}>·</span>
              <span style={{ color: "var(--ats-fg-secondary)" }}>
                Beijing {_BJ_TIME_FMT.format(new Date(nowTick))}
              </span>
            </span>
            {overview.lastUpdated > 0 && (
              <span className="inline-flex items-center gap-1">
                Updated {relativeTime(overview.lastUpdated)}
              </span>
            )}
            <span className="inline-flex items-center gap-1" title="Signed into admin console as">
              <code style={{ color: "var(--ats-fg-primary)" }}>{authEmail}</code>
            </span>
            <button
              onClick={() => setPollPaused(p => !p)}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
              style={{
                borderColor:     pollPaused ? "rgba(245,158,11,0.55)" : "var(--ats-border-subtle)",
                backgroundColor: pollPaused ? "rgba(245,158,11,0.10)" : "var(--ats-bg-panel)",
                color:           pollPaused ? "#f59e0b" : "var(--ats-fg-secondary)",
              }}
              title={pollPaused
                ? "Polling paused — manual Refresh still works. Click to resume."
                : "Pause all background polling (overview, users, time-series, …). Manual Refresh still works."}
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: pollPaused ? "#f59e0b" : "#10b981" }} />
              {pollPaused ? "Paused" : "Live"}
            </button>
            <button
              onClick={refreshAll}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-panel)",
                color:           "var(--ats-fg-secondary)",
              }}
              title="Refresh all panels"
            >
              <RefreshCw size={11} />
              Refresh
            </button>
            <button
              onClick={async () => {
                await adminSupabase.auth.signOut();
                // onAuthStateChange listener will flip UI back to login.
              }}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:brightness-110"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-panel)",
                color:           "var(--ats-fg-secondary)",
              }}
              title="Sign out of admin console (main app unaffected)"
            >
              <LogOut size={11} />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-6 space-y-6">
        {/* ── Global errors ─────────────────────────────────────────── */}
        {(overview.error || timeseries.error || users.error || announcements.error) && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-700 dark:text-red-300 space-y-1">
            {overview.error     && <p>Overview: {overview.error}</p>}
            {timeseries.error   && <p>Time-series: {timeseries.error}</p>}
            {users.error        && <p>Users: {users.error}</p>}
            {announcements.error&& <p>Announcements: {announcements.error}</p>}
          </div>
        )}

        {/* ── Usage-tracking write-path warning ─────────────────────────
             Surfaced when /api/admin/usage-tracking-health reports any
             user_id with a history_entries row today but no matching
             user_usage_daily row. That gap means the
             increment_user_usage_daily RPC failed silently — the
             search ran (compute spent, brief generated) but the
             counter / cost ledger wasn't updated, so KPIs and cost
             alerts will under-report until the RPC pipeline is fixed.
             Banner stays absent on the happy path so steady-state
             dashboards don't get a permanent yellow stripe. */}
        {usageHealth.data && usageHealth.data.ok === false && usageHealth.data.missing_from_usage_daily.length > 0 && (
          <div className="rounded-xl border px-4 py-3 text-xs space-y-1"
               style={{ borderColor: "rgba(245,158,11,0.55)", backgroundColor: "rgba(245,158,11,0.10)", color: "#f59e0b" }}>
            <p className="font-semibold">
              ⚠ Usage tracking write gap: {usageHealth.data.missing_from_usage_daily.length} user{usageHealth.data.missing_from_usage_daily.length === 1 ? "" : "s"} have search activity today but no user_usage_daily row.
            </p>
            <p className="text-[11px] opacity-80">
              History entries today: {usageHealth.data.history_users} · usage_daily entries today: {usageHealth.data.usage_daily_users}.
              The increment_user_usage_daily RPC is silently failing for at least one search path — KPIs and cost alerts will under-report until it&apos;s fixed.
              First missing id: <code className="font-mono">{usageHealth.data.missing_from_usage_daily[0]?.slice(0, 8)}…</code>
            </p>
          </div>
        )}

        {/* ── Maintenance mode (sits ABOVE KPIs because flipping it is the
             single most impactful admin action; every user sees the effect
             within 20s). Highlighted with an amber tint when enabled so the
             panel is impossible to miss during an active window. ────── */}
        <MaintenancePanel
          state={maintenance.data}
          onApply={setMaintenance}
          onEndNow={endMaintenanceNow}
        />

        {/* ── Per-user analytics filter ─────────────────────────────────
             Hides specific accounts from the per-user panels (All users
             table, Top users by cost, Activity feed, Cost alerts,
             Feedback inbox). Aggregate cards (KPIs / time-series /
             funnel) intentionally stay UNFILTERED — those are
             pre-aggregated server-side and would need a backend
             query parameter to slice. The caption on the right makes
             that limitation explicit so operators don't expect
             filtered KPIs. */}
        <AnalyticsFilterToolbar
          hideDevs={hideDevs}
          onToggleHideDevs={setHideDevs}
          hideAnon={hideAnon}
          onToggleHideAnon={setHideAnon}
          anonCount={ov?.users.anonymous ?? 0}
          extraHidden={extraHidden}
          rawUserList={rawUserList}
          onAdd={addExtraHidden}
          onRemove={removeExtraHidden}
        />

        {/* ── KPI hero ──────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <h2 className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--ats-fg-secondary)" }}>
              Live KPIs
            </h2>
            {/* Window toggle — 3 segments, active one tinted with the
                accent token so it follows the theme. The labels below
                swap from "Searches today" → "Searches this week" →
                "Searches this month" as the user clicks. Total users +
                Conversations are ALL-TIME and deliberately don't change
                — they're not windowed metrics. */}
            <WindowToggle value={kpiWindow} onChange={setKpiWindow} />
          </div>
          {(() => {
            // Pick which window to render. Falls back to `today` if the
            // backend hasn't been upgraded yet (old deploys didn't send
            // week/month — we degrade gracefully instead of showing "—").
            const win: UsageWindow | undefined =
              kpiWindow === "week"  ? (ov?.week  ?? ov?.today) :
              kpiWindow === "month" ? (ov?.month ?? ov?.today) :
                                      ov?.today;
            const windowLabel =
              kpiWindow === "today" ? "today" :
              kpiWindow === "week"  ? "this week" :
                                      "this month";
            // 8 cards arranged as 2 rows of 4 on lg+. The xl:grid-cols-8
            // single-row variant was tested but each card came out too
            // narrow — labels like "SEARCHES TODAY" / "LAB RUNS TODAY" /
            // "FEEDBACK RECEIVED" wrapped to 2 lines and the longer
            // sublabels ("Synthesis + Paper Review") clipped mid-word.
            // Capping at 4 columns gives every card ~280-320 px which
            // fits the longest label in our set on a single line and
            // leaves the sublabel readable. Two clean rows of 4 reads
            // better than a single row of 8 narrow cards on every
            // viewport we ship for.
            return (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 gap-3">
                {/* "Signed-in users" (was "Total users") — counts rows in
                    the `profiles` table only. Anonymous visitors never get
                    a profile (see ensure_profile() early-return for anon:*
                    user_ids in supabase_client.py), so this number is the
                    authenticated-user roster, not the visitor roster.
                    Renamed 2026-04-28 because the prior "Total users"
                    label silently undercounted public-beta traffic. */}
                {/* When Hide-anonymous is on we subtract the anon cohort from
                    BOTH the headline number and the sublabel breakdown so the
                    KPI matches what's visible in the user table below.
                    `users.anonymous` is server-counted (profiles with email
                    NULL) and is also excluded from `by_tier` adjustments
                    because anon rows are bucketed under their stored tier
                    (usually "free") server-side. */}
                {(() => {
                  const total = ov?.users.total ?? null;
                  const anon  = ov?.users.anonymous ?? 0;
                  const shown = total === null ? null : (hideAnon ? Math.max(0, total - anon) : total);
                  const sub = hideAnon
                    ? `${ov?.users.by_tier.dev ?? 0} dev · ${ov?.users.by_tier.scholar ?? 0} scholar · −${anon} anon hidden`
                    : `${ov?.users.by_tier.dev ?? 0} dev · ${ov?.users.by_tier.scholar ?? 0} scholar · ${anon} anon`;
                  return (
                    <KpiCard
                      icon={<Users size={14} />}
                      label="Signed-in users"
                      value={shown ?? "—"}
                      sublabel={sub}
                      color="#3b82f6"
                    />
                  );
                })()}
                {/* Active users in window — counts DISTINCT user_id from
                    user_usage_daily, which DOES include anon:{ip}
                    buckets. So the numerator (active_users) and the
                    "Signed-in users" denominator don't share a domain;
                    the previous "X% of all users" sublabel could
                    exceed 100% when most activity came from
                    anonymous visitors. Replaced with a plain
                    composition note instead of the broken ratio. */}
                <KpiCard
                  icon={<Activity size={14} />}
                  label={`Active ${windowLabel}`}
                  value={win?.active_users ?? "—"}
                  sublabel={win ? "incl. anonymous visitors" : ""}
                  color="#10b981"
                />
                <KpiCard
                  icon={<Zap size={14} />}
                  label={`Searches ${windowLabel}`}
                  value={win ? (win.quick_search_count + win.deep_search_count) : "—"}
                  sublabel={win ? `${win.quick_search_count} quick · ${win.deep_search_count} deep` : ""}
                  color="#8b5cf6"
                />
                {/* Synthesis card now explicitly notes that the count
                    INCLUDES Paper Review submissions — both flows go
                    through gateway.record_success("synthesis") so they
                    share the same daily counter. Splitting them out
                    properly needs a new user_usage_daily column +
                    increment-RPC change (see migrations TODO); until
                    that lands, the sublabel keeps the dev honest about
                    what they're looking at. */}
                <KpiCard
                  icon={<Sparkles size={14} />}
                  label={`Lab runs ${windowLabel}`}
                  value={win?.synthesis_count ?? "—"}
                  sublabel={`Synthesis + Paper Review · ${win?.deep_read_count ?? 0} evidence chains`}
                  color="#ec4899"
                />
                <KpiCard
                  icon={<MessageSquare size={14} />}
                  label="Conversations"
                  value={ov?.conversations ?? "—"}
                  sublabel={`${ov?.history_entries ?? 0} history rows`}
                  color="#f59e0b"
                />
                <KpiCard
                  icon={<DollarSign size={14} />}
                  label={`Cost ${windowLabel}`}
                  value={win ? `$${win.llm_cost_usd.toFixed(2)}` : "—"}
                  sublabel="LLM usage (USD)"
                  color="#ef4444"
                />
                {/* Announcements — all-time count of public-ticker rows.
                    Not windowed (the ticker is a slow-moving stream;
                    splitting by week/month would be noise). */}
                <KpiCard
                  icon={<Megaphone size={14} />}
                  label="Announcements"
                  value={ov?.announcements_total ?? "—"}
                  sublabel="Public ticker rows"
                  color="#06b6d4"
                />
                {/* Feedback inbox — all-time received with the
                    unresolved subset called out as the actionable
                    number. The "open" digit is what the dev actually
                    needs to work through; total is for context. Stays
                    "—" if the backend hasn't been upgraded to send
                    feedback_total / feedback_open yet (graceful
                    degradation, same pattern as week/month windows). */}
                <KpiCard
                  icon={<Inbox size={14} />}
                  label="Feedback received"
                  value={ov?.feedback_total ?? "—"}
                  sublabel={
                    typeof ov?.feedback_open === "number"
                      ? `${ov.feedback_open} unresolved`
                      : "all-time"
                  }
                  color="#84cc16"
                />
              </div>
            );
          })()}
        </section>

        {/* ── Charts row ────────────────────────────────────────────── */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Time-series (2/3) */}
          <div className="lg:col-span-2 rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Usage — last {tsDays === 7 ? "7 days" : tsDays === 30 ? "30 days" : tsDays === 90 ? "90 days" : "year"}
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Daily volumes per feature, zero-filled for quiet days. Axis ticks auto-adapt to the selected range.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Range toggle — small segmented rocker. Clicking a
                    segment kicks the fetcher (closure on `tsDays`) and
                    re-renders the chart. No extra refresh click needed. */}
                <TimeRangeToggle value={tsDays} onChange={setTsDays} />
                <TimeseriesLegend />
              </div>
            </div>
            {ts.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-xs" style={{ color: "var(--ats-fg-muted)" }}>
                No data yet
              </div>
            ) : (
              <LineChart data={ts} windowDays={tsDays} />
            )}
          </div>

          {/* Tier donut (1/3) */}
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <h3 className="text-sm font-bold mb-1" style={{ color: "var(--ats-fg-primary)" }}>
              Users by tier
            </h3>
            <p className="text-[10px] mb-3" style={{ color: "var(--ats-fg-muted)" }}>
              Distribution across pricing plans.
            </p>
            {ov ? (
              <DonutChart
                slices={Object.entries(ov.users.by_tier).map(([k, v]) => ({
                  label: k, value: v, color: TIER_COLORS[k] ?? "#64748b",
                }))}
                total={ov.users.total}
              />
            ) : (
              <div className="h-64 flex items-center justify-center text-xs" style={{ color: "var(--ats-fg-muted)" }}>
                Loading…
              </div>
            )}
          </div>
        </section>

        {/* ── Section order is deliberate: ordered by developer importance
             and consultation frequency (what you actually look at during
             an incident, a daily standup, or a capacity check).
             High-frequency / high-signal panels first; low-frequency
             reference panels (tier edits, feedback, announcement log) last.
             ────────────────────────────────────────────────────────────
             1. KPIs                           — above, top of page
             2. Charts                         — above
             3. System health + DB storage     — infra state, check often
             4. Cost alerts + Error log        — immediate red flags
             5. Recent activity                — "what did users just do"
             6. Recent users                   — who's on the platform
             7. Tier limits editor             — config, rarely touched
             8. Feedback inbox                 — async triage
             9. Announcements log + snapshot   — mostly a content log
        */}

        {/* ── System health + DB storage ─────────────────────────────── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* System health — Redis + LLM key pool + worker count */}
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>System health</h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Live state of the backend&apos;s infra: Redis, LLM key pool, worker count.
                </p>
              </div>
              <button onClick={() => sysHealth.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
            </div>
            <SystemHealthPanel data={sysHealth.data} />
          </div>

          {/* Database storage — predicts when the Supabase free tier runs out */}
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>Database storage</h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Estimated usage vs. Supabase free tier (500 MB). History entries dominate — watch that row.
                </p>
              </div>
              <button onClick={() => dbStats.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
            </div>
            <DbStatsPanel data={dbStats.data} />
          </div>
        </section>

        {/* ── Cost alerts + Error log side-by-side ───────────────────── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Cost alerts today
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Users over their tier threshold. Empty = everyone&apos;s within budget.
                </p>
              </div>
              <button onClick={() => costAlerts.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
            </div>
            <CostAlertsPanel alerts={(costAlerts.data?.alerts ?? []).filter(a => !isUserIdHidden(a.user_id, a.tier))} />
          </div>

          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Error log
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Backend 5xx + frontend window.onerror. Replaces Sentry for alpha forensics.
                </p>
              </div>
              <button onClick={() => errors.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
            </div>
            <ErrorLogPanel rows={errors.data?.errors ?? []} />
          </div>
        </section>

        {/* ── Per-source retrieval + Conversion funnel ──────────────────
             Side-by-side: operational signal (which source is slow /
             broken) + retention signal (how many signups stuck around).
             Both scope to `tsDays` for the funnel and a rolling 15-min
             window for source stats (different cadence, different data
             nature — source health is a live signal, funnel is a cohort
             analysis). */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Per-source retrieval (last 15 min)
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Each row: fetches · papers returned · latency · error rate. Rows with ≥20% errors turn amber;
                  sources that returned 0 papers on every call turn red so &quot;PubMed went down&quot; jumps out.
                </p>
              </div>
              <button onClick={() => sourceStats.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
            </div>
            <SourceStatsPanel rows={sourceStats.data?.sources ?? []} />
          </div>

          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Feature adoption (last {tsDays} days)
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Of authenticated users active in this window, what fraction reaches each feature?
                  Anonymous users excluded. Retargets with the chart&apos;s time-range toggle.
                </p>
              </div>
              <button onClick={() => funnel.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
            </div>
            <ConversionFunnelPanel data={funnel.data} />
          </div>
        </section>

        {/* ── Admin audit log — full-width because meta JSON gets wide ──
             Forensic "who did what when". Colour-codes rows by action
             category (ban=red, maintenance=amber, edit=blue, grant=green,
             tier=purple) so a quick skim reveals clusters. */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                Admin audit log
              </h3>
              <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                Every admin mutation (ban, tier, maintenance, announcement edit/delete, quota grant) as a timestamped row.
                Showing up to 200, newest first.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => auditLog.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
              <CollapseCaret open={isPanelOpen("audit-log")} onClick={() => togglePanel("audit-log")} />
            </div>
          </div>
          {isPanelOpen("audit-log") && (
            <AuditLogPanel rows={auditLog.data?.rows ?? []} />
          )}
        </section>

        {/* ── Top users by cost + Top queries ────────────────────────
             These two panels answer "who's spending the most" and
             "what is everyone actually searching for" — the two
             questions you'd otherwise only be able to answer by
             dumping data to a spreadsheet and pivoting. Both scope
             to the KPI window toggle (today/week/month) so the
             numbers line up with the hero-card totals above. */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Top users by cost ({topUsersWindow})
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Highest LLM spend in the selected window. Click any row to open their detail drawer.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <WindowToggle value={topUsersWindow} onChange={setTopUsersWindow} includeYear />
                <button onClick={() => topUsers.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                  <RefreshCw size={10} /> Refresh
                </button>
                <CollapseCaret open={isPanelOpen("top-users")} onClick={() => togglePanel("top-users")} />
              </div>
            </div>
            {isPanelOpen("top-users") && (
            <TopUsersPanel
              rows={(topUsers.data?.users ?? []).filter(u => !isUserIdHidden(u.user_id, u.tier))}
              onOpenDrawer={(row) => {
                // Find the matching AdminUser (they share user_id). Fall
                // back to a minimal synthesized row if the user list
                // hasn't loaded yet — the drawer will still fetch live
                // activity on mount.
                const match = userList.find(u => u.id === row.user_id);
                setUserDrawer(match || {
                  id: row.user_id,
                  email: row.email || null,
                  tier: (row.tier as AdminUser["tier"]) || "free",
                  tier_updated_at: null,
                  profile_updated: null,
                  first_seen_at:   null,
                  is_banned:       !!row.is_banned,
                  today: {
                    quick_search_count: row.quick_search_count,
                    deep_search_count:  row.deep_search_count,
                    synthesis_count:    row.synthesis_count,
                    deep_read_count:    row.deep_read_count,
                    llm_cost_usd:       row.total_cost,
                  },
                });
              }}
            />
            )}
          </div>
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Top queries ({topQueriesWindow})
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Most-searched text in the selected window, case-insensitive. Good signal for &quot;what are people trying to research&quot;.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <WindowToggle value={topQueriesWindow} onChange={setTopQueriesWindow} includeYear />
                <button onClick={() => topQueries.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                  <RefreshCw size={10} /> Refresh
                </button>
                <CollapseCaret open={isPanelOpen("top-queries")} onClick={() => togglePanel("top-queries")} />
              </div>
            </div>
            {isPanelOpen("top-queries") && (
              <TopQueriesPanel rows={topQueries.data?.queries ?? []} />
            )}
          </div>
        </section>

        {/* ── Recent activity — what each user actually did, newest first ── */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                Recent activity
              </h3>
              <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                Every logged-in search / synthesis / evidence-chain emits one row.
                Refreshes every 30 s.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => activity.refresh()}
                className="text-[10px] inline-flex items-center gap-1"
                style={{ color: "var(--ats-fg-muted)" }}
              >
                <RefreshCw size={10} /> Refresh
              </button>
              <CollapseCaret open={isPanelOpen("activity")} onClick={() => togglePanel("activity")} />
            </div>
          </div>
          {isPanelOpen("activity") && (
            // No max-h / overflow here. The whole admin page is already
            // a scroll container (`admin-main h-screen overflow-y-auto`,
            // see top of this component), so capping the panel at 420 px
            // forced a SECOND vertical scrollbar to appear next to the
            // page-level one — what the user reported as "双 scrollbar".
            // Letting the activity feed grow to its natural height means
            // there's exactly ONE scrollbar (page-level) regardless of
            // how many rows the feed has. The CollapseCaret in the
            // header above lets the user collapse the panel when it
            // gets long, which is the right control for "I don't want
            // to scroll past 50 rows of activity right now".
            <ActivityFeed rows={(activity.data?.activity ?? []).filter(a => !isUserIdHidden(a.user_id))} />
          )}
        </section>

        {/* ── Recent users table ─────────────────────────────────────── */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <div className="flex items-start justify-between mb-2 gap-3 flex-wrap">
            <div className="min-w-0">
              <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                All users
              </h3>
              <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                Counters show <span className="font-semibold">
                  {userWindowDays === 0 ? "all-time totals"
                    : userWindowDays === 1 ? "today only"
                    : `last ${userWindowDays} days`}</span>
                {" · sorted by "}<span className="font-semibold">{USER_SORT_LABEL[userSort]}</span>
                {" · showing "}{userList.length}{rawUserList.length !== userList.length && ` of ${rawUserList.length}`}
                {userSearch.trim() && " (filtered)"}
                {rawUserList.length >= 2000 && " · capped at 2000"}.
                {users.lastUpdated > 0 && (
                  <span className="ml-1.5 italic" style={{ color: "var(--ats-fg-muted)" }}>
                    fetched <RelativeTime ms={users.lastUpdated} now={nowMs} />
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* Window picker — drives the per-user counter columns. */}
              <div className="inline-flex items-center rounded-md border overflow-hidden" style={{ borderColor: "var(--ats-border-subtle)" }}>
                {([
                  { id: 1  as const, label: "Today" },
                  { id: 7  as const, label: "7d"    },
                  { id: 30 as const, label: "30d"   },
                  { id: 0  as const, label: "All"   },
                ]).map(({ id, label }) => {
                  const active = userWindowDays === id;
                  return (
                    <button
                      key={id}
                      onClick={() => setUserWindowDays(id)}
                      className="px-2 py-0.5 text-[10px] font-semibold transition-colors"
                      style={{
                        backgroundColor: active ? "var(--ats-bg-accent-soft)" : "transparent",
                        color:           active ? "var(--ats-fg-accent)"      : "var(--ats-fg-secondary)",
                      }}
                    >{label}</button>
                  );
                })}
              </div>
              {/* Free-text search — email substring or 8-char id prefix. */}
              <input
                type="search"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="search email or id"
                className="text-[10px] rounded border px-1.5 py-0.5 w-36 transition-colors"
                style={{
                  borderColor:     "var(--ats-border-subtle)",
                  backgroundColor: "var(--ats-bg-panel)",
                  color:           "var(--ats-fg-secondary)",
                }}
              />
              <select
                value={userSort}
                onChange={(e) => setUserSort(e.target.value as UserSort)}
                title="Sort the all-users list"
                className="text-[10px] rounded border px-1.5 py-0.5 transition-colors"
                style={{
                  borderColor:     "var(--ats-border-subtle)",
                  backgroundColor: "var(--ats-bg-panel)",
                  color:           "var(--ats-fg-secondary)",
                }}
              >
                <option value="active">Most-recent activity</option>
                <option value="email_az">Email (A → Z)</option>
                <option value="email_za">Email (Z → A)</option>
                <option value="tier">Tier (dev first)</option>
                <option value="quick">Quick (high → low)</option>
                <option value="deep">Deep (high → low)</option>
                <option value="synth">Synth (high → low)</option>
                <option value="chain">Chain (high → low)</option>
                <option value="cost">Cost (high → low)</option>
                <option value="first_new">First seen (newest)</option>
                <option value="first_old">First seen (oldest)</option>
              </select>
              <button
                onClick={() => exportUsersAsCsv(userList, userWindowDays)}
                title="Download the currently-visible roster as a CSV (respects the search box and window picker)"
                className="text-[10px] inline-flex items-center gap-1 transition-colors hover:text-emerald-400"
                style={{ color: "var(--ats-fg-muted)" }}
              >
                <Database size={10} /> Export CSV
              </button>
              <button
                onClick={openAnonCleanup}
                title="List anonymous profiles older than N days with zero activity, then optionally delete them"
                className="text-[10px] inline-flex items-center gap-1 transition-colors hover:text-rose-400"
                style={{ color: "var(--ats-fg-muted)" }}
              >
                <Trash2 size={10} /> Clean unused anon
              </button>
              <button
                onClick={() => users.refresh()}
                className="text-[10px] inline-flex items-center gap-1 transition-colors"
                style={{ color: "var(--ats-fg-muted)" }}
              >
                <RefreshCw size={10} /> Refresh
              </button>
              <CollapseCaret open={isPanelOpen("users")} onClick={() => togglePanel("users")} />
            </div>
          </div>
          {isPanelOpen("users") && (
            <div className="max-h-[520px] overflow-y-auto thin-scrollbar">
              <UserTable users={userList} onOpenDrawer={setUserDrawer} />
            </div>
          )}
        </section>

        {/* ── Tier limits editor — full width because it's a table ───── */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                Subscription tier daily limits
              </h3>
              <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                Edit per-tier daily quotas. Changes apply within ~30 s to all workers.
                Leave blank to reset to the code default. Users already over their new
                cap see the new number but KEEP their consumed count (no reset).
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => tierLimits.refresh()}
                className="text-[10px] inline-flex items-center gap-1"
                style={{ color: "var(--ats-fg-muted)" }}
              >
                <RefreshCw size={10} /> Refresh
              </button>
              <CollapseCaret open={isPanelOpen("tier-limits")} onClick={() => togglePanel("tier-limits")} />
            </div>
          </div>
          {isPanelOpen("tier-limits") && (
            <TierLimitsEditor data={tierLimits.data} onSaveAll={saveTierLimitsBatch} />
          )}
        </section>

        {/* ── Runtime client config — knobs the frontend fetches on load.
             Today: workspace question-length cap. Dev sets it here, every
             connected client picks up the new value on its next GET
             /api/config/client (fires on page mount). */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <ClientConfigEditor />
        </section>

        {/* ── Broadcast to all users — fan out ONE popup to every profile.
             Active users see it within ~20s (next poll); offline users see
             it on their next sign-in. Prefer this over the ticker-banner
             for release notes / breaking-change announcements that every
             user needs to acknowledge. */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <BroadcastComposer />
        </section>

        {/* ── Feedback inbox — full width so long messages are readable ── */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                Feedback inbox
              </h3>
              <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                User-submitted bug reports / feature requests. Unresolved rows surface first.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => feedback.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
              <CollapseCaret open={isPanelOpen("feedback")} onClick={() => togglePanel("feedback")} />
            </div>
          </div>
          {isPanelOpen("feedback") && (
            <div className="max-h-[520px] overflow-y-auto thin-scrollbar pr-1">
              <FeedbackInbox rows={(feedback.data?.feedback ?? []).filter(f => !isEmailHidden(f.user_email))} onToggle={toggleFeedbackResolved} />
            </div>
          )}
        </section>

        {/* ── Recommended-term pool (workspace landing chips) ────────────────
             Edits here surface to every user's landing chips on the next
             page mount (the daily shuffle reads the active subset). The
             pool can be larger than the deck size — the backend samples
             ~12 chips per day from whatever is `active`. */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <div className="flex items-start justify-between mb-3 gap-2">
            <div>
              <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                Recommended terms
              </h3>
              <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                {recTerms.length} total · {recTerms.filter(t => t.active).length} active.
                Daily shuffle picks ~12 from the active set; users see the same deck per UTC day.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void refreshRecTerms()}
                className="text-[10px] inline-flex items-center gap-1 transition-colors"
                style={{ color: "var(--ats-fg-muted)" }}
                title="Reload the admin-curated recommended_terms table"
              >
                <RefreshCw size={10} /> Refresh
              </button>
              {/* Regenerate the LLM-distilled daily pool. Distinct
                  from "Refresh" — Refresh reloads the curated table
                  (this UI), Regenerate invalidates the LLM cache that
                  drives /api/recommended-terms/today (the public-facing
                  daily-shuffled chips users see on the workspace). */}
              <button
                onClick={() => void regenerateLlmPool()}
                className="text-[10px] inline-flex items-center gap-1 transition-colors"
                style={{ color: "var(--ats-fg-muted)" }}
                title="Force the LLM-distilled trending pool to regenerate (clears daily cache)"
              >
                <Sparkles size={10} /> Regenerate LLM pool
              </button>
              <CollapseCaret open={isPanelOpen("rec-terms")} onClick={() => togglePanel("rec-terms")} />
            </div>
          </div>
          {isPanelOpen("rec-terms") && (
            <div className="space-y-2">
              {/* Add row */}
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={newRecTerm}
                  onChange={e => setNewRecTerm(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") void createRecTerm(); }}
                  placeholder="New recommended term…"
                  maxLength={200}
                  className="flex-1 rounded-md border px-2 py-1 text-xs outline-none"
                  style={{
                    borderColor:     "var(--ats-border-subtle)",
                    backgroundColor: "var(--ats-bg-base)",
                    color:           "var(--ats-fg-primary)",
                  }}
                />
                <button
                  onClick={() => void createRecTerm()}
                  disabled={!newRecTerm.trim()}
                  className="text-[10px] inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ color: "var(--ats-fg-accent)", borderColor: "var(--ats-border-accent)" }}
                >
                  <Plus size={10} /> Add
                </button>
              </div>
              {recTermsLoading && (
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>Loading…</p>
              )}
              {recTermsError && (
                <p className="text-[10px]" style={{ color: "#ef4444" }}>Error: {recTermsError}</p>
              )}
              {!recTermsLoading && recTerms.length === 0 && !recTermsError && (
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Pool is empty — users currently see the hard-coded fallback. Add some terms above.
                </p>
              )}
              {recTerms.length > 0 && (
                <div className="max-h-[420px] overflow-y-auto thin-scrollbar pr-1 space-y-1">
                  {recTerms.map(row => (
                    <RecTermRowEditor
                      key={row.id}
                      row={row}
                      onToggle={() => void toggleRecTerm(row)}
                      onSave={(text) => void editRecTerm(row, text)}
                      onDelete={() => void deleteRecTerm(row)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Announcements full log + System snapshot (low-frequency) ──
             Moved to the end because these are reference panels, not
             incident-response signals. The log is mostly historical; the
             snapshot duplicates top-of-page KPI info in a different shape. */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-start justify-between mb-3 gap-2">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Announcements — full log
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  {annList.length} total ·
                  {" "}{annList.filter(a => a.author_email === "dev@academicats.com").length} seed ·
                  {" "}{annList.filter(a => a.author_email !== "dev@academicats.com").length} user-posted
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                {/* Bulk delete — user posts only. Keeps seeds so the
                    ticker still has opening copy after the sweep. */}
                <button
                  onClick={deleteAllUserAnnouncements}
                  disabled={annList.filter(a => a.author_email !== "dev@academicats.com").length === 0}
                  title="Delete every user-posted announcement. Seeded dev@academicats.com messages are preserved."
                  className="text-[10px] inline-flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ color: "#f59e0b", borderColor: "rgba(245,158,11,0.4)" }}
                >
                  Clear user posts
                </button>
                {/* Nuke-all — full wipe including seeds. Double-confirmed. */}
                <button
                  onClick={nukeAllAnnouncements}
                  disabled={annList.length === 0}
                  title="Delete every announcement, including seeds. Full reset — double-confirmed."
                  className="text-[10px] inline-flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.4)" }}
                >
                  Nuke all
                </button>
                <button
                  onClick={() => announcements.refresh()}
                  className="text-[10px] inline-flex items-center gap-1 transition-colors"
                  style={{ color: "var(--ats-fg-muted)" }}
                >
                  <RefreshCw size={10} /> Refresh
                </button>
                <CollapseCaret open={isPanelOpen("announcements")} onClick={() => togglePanel("announcements")} />
              </div>
            </div>
            {isPanelOpen("announcements") && (
              <AnnouncementLog rows={annList} onDelete={deleteOneAnnouncement} onEdit={editOneAnnouncement} />
            )}
          </div>

          <div className="rounded-2xl border p-4" style={panelStyle}>
            <h3 className="text-sm font-bold mb-3" style={{ color: "var(--ats-fg-primary)" }}>
              System snapshot
            </h3>
            <SystemSnapshot overview={ov} />
          </div>
        </section>

        <footer className="pt-2 pb-8 text-center">
          <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            Admin console · polling overview every {Math.round(OVERVIEW_POLL_MS / 1000)}s,
            details every {Math.round(DETAIL_POLL_MS / 1000)}s ·
            <Link href="/" className="ml-1 underline hover:opacity-80">Back to app</Link>
          </p>
        </footer>

        {/* Per-user detail drawer. Mounted at the admin root so stacking
            is simple: the drawer's own backdrop covers the whole page. */}
        {userDrawer && (
          <UserDetailDrawer
            user={userDrawer}
            onClose={() => setUserDrawer(null)}
            onBan={setUserBan}
            onGrantQuota={grantUserQuota}
            onSetTier={setUserTier}
            onNotify={notifyUser}
            onFetchActivity={fetchUserActivity}
          />
        )}

        {/* ── Anonymous cleanup modal ──────────────────────────────────────
             Two-step destructive action: list candidates first, operator
             reviews, then explicit "Delete N rows" button. Server re-
             verifies each id (anon + zero activity) on the POST so an
             anon user who logged a search between list and confirm is
             skipped, not deleted. */}
        {anonCleanupOpen && (
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm"
            onClick={() => !anonCleanupLoading && setAnonCleanupOpen(false)}
          >
            <div
              className="w-full max-w-2xl rounded-2xl border shadow-2xl flex flex-col max-h-[80vh]"
              style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3 px-6 pt-5 pb-3 border-b" style={{ borderColor: "var(--ats-border-subtle)" }}>
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                    Clean unused anonymous profiles
                  </h2>
                  <p className="mt-1 text-xs" style={{ color: "var(--ats-fg-secondary)" }}>
                    Lists anonymous accounts (email = ∅) older than the threshold with{" "}
                    <span className="font-semibold">zero history + zero usage</span>. Review the list,
                    then delete in one click. The server re-verifies every id at delete time so a row
                    that just gained activity is skipped automatically.
                  </p>
                </div>
                <button
                  onClick={() => !anonCleanupLoading && setAnonCleanupOpen(false)}
                  className="p-1 rounded hover:bg-black/5 shrink-0"
                  aria-label="Close"
                  style={{ color: "var(--ats-fg-muted)" }}
                  disabled={anonCleanupLoading}
                >
                  <X size={18} />
                </button>
              </div>

              <div className="px-6 py-3 flex items-center gap-3 text-xs border-b" style={{ borderColor: "var(--ats-border-subtle)" }}>
                <label className="inline-flex items-center gap-2" style={{ color: "var(--ats-fg-secondary)" }}>
                  Older than
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={anonCleanupDays}
                    onChange={(e) => setAnonCleanupDays(Math.max(1, Math.min(365, Number(e.target.value) || 7)))}
                    className="w-16 rounded border px-2 py-0.5 text-xs"
                    style={{
                      borderColor:     "var(--ats-border-subtle)",
                      backgroundColor: "var(--ats-bg-base)",
                      color:           "var(--ats-fg-primary)",
                    }}
                  />
                  days
                </label>
                <button
                  onClick={openAnonCleanup}
                  disabled={anonCleanupLoading}
                  className="text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded border transition-colors disabled:opacity-50"
                  style={{
                    borderColor:     "var(--ats-border-subtle)",
                    color:           "var(--ats-fg-secondary)",
                  }}
                >
                  <RefreshCw size={10} /> Re-list
                </button>
                <span className="ml-auto text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  {anonCleanupLoading
                    ? "Working…"
                    : anonCleanupResult
                      ? `Deleted ${anonCleanupResult.deleted}, skipped ${anonCleanupResult.skipped}.`
                      : `${anonCleanupCandidates.length} candidate${anonCleanupCandidates.length === 1 ? "" : "s"}`}
                </span>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-3 thin-scrollbar">
                {anonCleanupError && (
                  <p className="text-xs rounded-lg border px-3 py-2 mb-2"
                    style={{ borderColor: "#ef444455", backgroundColor: "#ef44441a", color: "#ef4444" }}>
                    {anonCleanupError}
                  </p>
                )}
                {anonCleanupResult && (
                  <p className="text-xs rounded-lg border px-3 py-2 mb-2"
                    style={{ borderColor: "#10b98155", backgroundColor: "#10b9811a", color: "#10b981" }}>
                    Deleted {anonCleanupResult.deleted} anonymous profile{anonCleanupResult.deleted === 1 ? "" : "s"}.
                    {anonCleanupResult.skipped > 0 && ` Skipped ${anonCleanupResult.skipped} (gained activity since list).`}
                  </p>
                )}
                {!anonCleanupLoading && anonCleanupCandidates.length === 0 && !anonCleanupResult && !anonCleanupError && (
                  <p className="text-xs italic text-center py-6" style={{ color: "var(--ats-fg-muted)" }}>
                    No candidates — nothing to clean up.
                  </p>
                )}
                {anonCleanupCandidates.length > 0 && (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left font-semibold uppercase tracking-wider text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                        <th className="py-1.5 pr-3">Session ID</th>
                        <th className="py-1.5 pr-3">First seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {anonCleanupCandidates.map(c => (
                        <tr key={c.id} className="border-t" style={{ borderColor: "var(--ats-border-subtle)" }}>
                          <td className="py-1.5 pr-3 font-mono" style={{ color: "var(--ats-fg-secondary)" }}>
                            {c.id.slice(0, 8)}…{c.id.slice(-4)}
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums" style={{ color: "var(--ats-fg-secondary)" }}>
                            {c.first_seen_at?.slice(0, 10) ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 px-6 py-3 border-t" style={{ borderColor: "var(--ats-border-subtle)" }}>
                <button
                  onClick={() => setAnonCleanupOpen(false)}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: "var(--ats-fg-secondary)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={confirmAnonCleanup}
                  disabled={anonCleanupLoading || anonCleanupCandidates.length === 0}
                  className="text-xs px-4 py-1.5 rounded-lg font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  style={{
                    backgroundColor: "#ef4444",
                    color:           "#ffffff",
                  }}
                >
                  <Trash2 size={12} /> Delete {anonCleanupCandidates.length} row{anonCleanupCandidates.length === 1 ? "" : "s"}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Maintenance mode control panel ───────────────────────────────────────
// One-click product pause with a live countdown for users. When `enabled`
// is true, the entire frontend (except /admin and /login) renders a full-
// screen overlay via MaintenanceGate — so toggling this is NOT a dry-run,
// it immediately takes the site offline for all visitors within ~20s
// (their poll interval). The "Go live now" button is deliberately
// separate from the toggle so an accidental click on the main toggle
// doesn't permanently clear the message + ETA the admin just typed.
//
// Three sub-forms composed together:
//   - Status pill (ON/OFF + "set by $email at $ts")
//   - Message textarea (user-facing copy shown above the countdown)
//   - ETA picker (datetime-local; admin's browser timezone, stored as ISO UTC)
// Plus two buttons:
//   - "Enter maintenance"   — posts enabled=true + current message + current eta
//   - "Go live now"         — /api/admin/maintenance/end shortcut

function MaintenancePanel({
  state, onApply, onEndNow,
}: {
  state: MaintenanceStateDto | null;
  onApply: (patch: { enabled?: boolean; message?: string; eta_at?: string }) => void | Promise<void>;
  onEndNow: () => void | Promise<void>;
}) {
  // Local draft state — we don't commit writes on every keystroke; admin
  // clicks "Apply" explicitly. The initial values come from the server
  // state once it arrives, and are re-seeded only when the server's
  // `set_at` timestamp changes (meaning someone else — or this same
  // admin — just saved). This way the admin's in-flight edits aren't
  // stomped by a poll every 15s.
  const [msg, setMsg]     = useState<string>("");
  const [eta, setEta]     = useState<string>("");  // datetime-local string (no tz)
  // In-flight tracker. Without this the action buttons accept multiple
  // clicks while the POST to /api/admin/maintenance is still hanging,
  // sending duplicate writes (and on slow networks the user thinks
  // nothing happened, clicks again, and the server ends up flipping the
  // toggle twice). Single-button-at-a-time is fine because the three
  // actions are mutually exclusive: you're either entering, updating,
  // or ending — never two at once.
  const [busy, setBusy]   = useState<"apply" | "endNow" | null>(null);
  const lastSyncRef = useRef<string | null>(null);

  const runApply = async () => {
    setBusy("apply");
    try {
      await onApply({ enabled: true, message: msg, eta_at: etaToIso() });
    } finally {
      setBusy(null);
    }
  };
  const runEndNow = async () => {
    if (!confirm("Bring the site back online now? All users will see their normal app immediately (within ~20s).")) return;
    setBusy("endNow");
    try {
      await onEndNow();
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!state) return;
    const sig = `${state.set_at || ""}|${state.message || ""}|${state.eta_at || ""}`;
    if (lastSyncRef.current === sig) return;
    lastSyncRef.current = sig;
    setMsg(state.message || "");
    // Convert ISO UTC → datetime-local (YYYY-MM-DDTHH:MM) in browser TZ.
    if (state.eta_at) {
      try {
        const d = new Date(state.eta_at);
        const pad = (n: number) => n.toString().padStart(2, "0");
        setEta(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
      } catch { setEta(""); }
    } else {
      setEta("");
    }
  }, [state]);

  const isEnabled = !!state?.enabled;

  // Convert the datetime-local value back to an ISO string for the API.
  // Date() parses datetime-local as browser-local time, then .toISOString()
  // emits UTC Z — exactly what the backend stores.
  const etaToIso = (): string => {
    if (!eta) return "";
    try { return new Date(eta).toISOString(); } catch { return ""; }
  };

  const quickPickPresets = [
    { label: "+15 min", mins: 15 },
    { label: "+30 min", mins: 30 },
    { label: "+1 hr",   mins: 60 },
    { label: "+2 hr",   mins: 120 },
  ];
  const setEtaFromNow = (mins: number) => {
    const d = new Date(Date.now() + mins * 60_000);
    const pad = (n: number) => n.toString().padStart(2, "0");
    setEta(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
  };

  const panelStyle: React.CSSProperties = {
    backgroundColor: isEnabled ? "rgba(245, 158, 11, 0.08)" : "var(--ats-bg-panel)",
    borderColor:     isEnabled ? "rgba(245, 158, 11, 0.45)" : "var(--ats-border-subtle)",
  };

  return (
    <section
      className="rounded-2xl border p-4 transition-colors"
      style={panelStyle}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
              Maintenance mode
            </h3>
            <StatusPill enabled={isEnabled} />
          </div>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--ats-fg-muted)" }}>
            {isEnabled
              ? "The product is OFFLINE for all users (except /admin + /login). Users see a full-screen overlay with the message + countdown below."
              : "One-click pause. While enabled, every user gets a full-screen overlay with the message and a live countdown to the ETA."}
          </p>
          {state?.set_by && (
            <p className="text-[10px] mt-1" style={{ color: "var(--ats-fg-muted)" }}>
              Last changed by <span className="font-semibold">{state.set_by}</span>
              {state.set_at && <> at <span className="tabular-nums">{fmtDateTime(state.set_at)}</span></>}
            </p>
          )}
        </div>
      </div>

      {/* Message textarea */}
      <label className="block mb-3">
        <span className="block text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ats-fg-muted)" }}>
          Message to users
        </span>
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={2}
          placeholder="AcademiCats is undergoing scheduled maintenance. We'll be back shortly."
          className="w-full rounded-lg border px-3 py-2 text-xs resize-none outline-none focus:border-blue-500/50"
          style={{
            backgroundColor: "var(--ats-bg-panel)",
            borderColor:     "var(--ats-border-subtle)",
            color:           "var(--ats-fg-primary)",
          }}
        />
      </label>

      {/* ETA row */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="flex-1 min-w-[220px]">
          <span className="block text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ats-fg-muted)" }}>
            Estimated back-online time (your local TZ)
          </span>
          <input
            type="datetime-local"
            value={eta}
            onChange={(e) => setEta(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-xs outline-none focus:border-blue-500/50"
            style={{
              backgroundColor: "var(--ats-bg-panel)",
              borderColor:     "var(--ats-border-subtle)",
              color:           "var(--ats-fg-primary)",
            }}
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold" style={{ color: "var(--ats-fg-muted)" }}>Quick:</span>
          {quickPickPresets.map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => setEtaFromNow(p.mins)}
              className="text-[10px] font-semibold rounded border px-2 py-1 transition-colors"
              style={{
                borderColor: "var(--ats-border-subtle)",
                color:       "var(--ats-fg-secondary)",
              }}
            >
              {p.label}
            </button>
          ))}
          {eta && (
            <button
              type="button"
              onClick={() => setEta("")}
              title="Clear ETA — the overlay will show only the message, no countdown"
              className="text-[10px] font-semibold rounded border px-2 py-1 transition-colors"
              style={{
                borderColor: "var(--ats-border-subtle)",
                color:       "var(--ats-fg-muted)",
              }}
            >
              Clear ETA
            </button>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {!isEnabled ? (
          <button
            type="button"
            onClick={() => void runApply()}
            disabled={busy !== null}
            className="rounded-lg px-4 py-2 text-xs font-bold text-white transition-all disabled:opacity-60 disabled:cursor-wait"
            style={{ backgroundColor: "#f59e0b" }}
          >
            {busy === "apply" ? "Saving…" : "⏸ Enter maintenance mode"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void runApply()}
              disabled={busy !== null}
              className="rounded-lg px-4 py-2 text-xs font-bold border transition-all disabled:opacity-60 disabled:cursor-wait"
              style={{
                borderColor: "rgba(245, 158, 11, 0.6)",
                color:       "#f59e0b",
                backgroundColor: "rgba(245, 158, 11, 0.08)",
              }}
              title="Save the message + ETA without flipping the toggle off"
            >
              {busy === "apply" ? "Saving…" : "💾 Update message / ETA"}
            </button>
            <button
              type="button"
              onClick={() => void runEndNow()}
              disabled={busy !== null}
              className="rounded-lg px-4 py-2 text-xs font-bold text-white transition-all disabled:opacity-60 disabled:cursor-wait"
              style={{ backgroundColor: "#10b981" }}
            >
              {busy === "endNow" ? "Going live…" : "▶ Go live now"}
            </button>
          </>
        )}

        {/* Dev reminder — the gate polls every 20s, so the rollout isn't instant. */}
        <span className="text-[10px] italic ml-auto" style={{ color: "var(--ats-fg-muted)" }}>
          Users see changes within ~20s (next poll tick).
        </span>
      </div>
    </section>
  );
}

// ── User detail drawer ─────────────────────────────────────────────────────
// Right-side slide-in panel that hosts every per-user action: ban/unban,
// gift quota, change tier, view activity. Opens when the admin clicks
// "Manage" on a row in the UserTable. Close via ESC, the X button, or
// click on the backdrop. Stateful forms (ban reason, quota inputs) are
// local to the drawer — they reset on close so re-opening for a different
// user doesn't carry over stale values.

// Curated emoji palette for the admin notify composer. Covers the four
// moods that match the typical send reasons: celebration (tier bump,
// quota grant), gratitude (thanks / milestone), encouragement, and
// informational. Free-form typing is still allowed — this is just a
// quick-pick row, not a constraint.
const NOTIFY_EMOJI_PRESETS: string[] = [
  "🎉", "🎊", "✨", "🥳", "🎁", "🌟", "💎",
  "🙏", "❤️", "💖", "💕", "💝", "🫶", "🤗",
  "👍", "🙌", "👏", "💪", "🤝", "🔥", "⚡",
  "🚀", "📚", "🧪", "🎯", "📣", "💬", "📌", "✉️",
];

function UserDetailDrawer({
  user, onClose, onBan, onGrantQuota, onSetTier, onNotify, onFetchActivity,
}: {
  user: AdminUser;
  onClose: () => void;
  onBan: (userId: string, banned: boolean, reason?: string) => Promise<void>;
  onGrantQuota: (userId: string, grants: {quick_search?:number; deep_search?:number; synthesis?:number; deep_read?:number}) => Promise<void>;
  onSetTier: (userId: string, tier: string) => Promise<void>;
  onNotify: (userId: string, payload: { title: string; body: string; emoji?: string; kind?: string }) => Promise<void>;
  onFetchActivity: (userId: string) => Promise<{ activity: Array<{ id: string; entry_type: string; query: string; summary: string; created_at: string }> }>;
}) {
  const [banReason, setBanReason] = useState<string>(user.ban_reason || "");
  const [quickGrant, setQuickGrant] = useState<number>(0);
  const [deepGrant,  setDeepGrant]  = useState<number>(0);
  const [synthGrant, setSynthGrant] = useState<number>(0);
  const [readsGrant, setReadsGrant] = useState<number>(0);
  const [tierDraft,  setTierDraft]  = useState<string>(user.tier);
  const [busy, setBusy] = useState<"ban" | "unban" | "grant" | "tier" | "notify" | null>(null);

  // ── Notify composer state ────────────────────────────────────────────────
  const [notifyTitle, setNotifyTitle] = useState<string>("");
  const [notifyBody,  setNotifyBody]  = useState<string>("");
  const [notifyEmoji, setNotifyEmoji] = useState<string>("");
  const [notifyKind,  setNotifyKind]  = useState<"general" | "tier_upgrade" | "quota_grant" | "system">("general");
  const [notifyMsg,   setNotifyMsg]   = useState<{ text: string; error?: boolean } | null>(null);

  // Activity feed — lazy-loaded once when drawer opens. Refreshable by the
  // user explicitly clicking the Refresh button in that section.
  const [activity, setActivity] = useState<Array<{ id: string; entry_type: string; query: string; summary: string; created_at: string }> | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const data = await onFetchActivity(user.id);
      setActivity(data.activity || []);
    } catch {
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, [user.id, onFetchActivity]);

  useEffect(() => { void loadActivity(); }, [loadActivity]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Each handler wraps the prop call in try/catch so a failure surfaces
  // a visible alert AND keeps the drawer open — the operator can adjust
  // and retry without losing their place. Previously these awaited the
  // prop unconditionally and then called `onClose()`; combined with the
  // parent silently catching errors that meant a failed ban/tier change
  // made the drawer disappear as if it had succeeded.
  const handleBan = async () => {
    if (!confirm(`Ban ${user.email || user.id}? They will be locked out immediately.`)) return;
    setBusy("ban");
    try {
      await onBan(user.id, true, banReason.trim() || undefined);
      onClose();
    } catch (e) {
      alert(`Ban failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const handleUnban = async () => {
    setBusy("unban");
    try {
      await onBan(user.id, false);
      onClose();
    } catch (e) {
      alert(`Unban failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const handleGrant = async () => {
    if (quickGrant + deepGrant + synthGrant + readsGrant <= 0) { alert("Enter at least one quota value."); return; }
    setBusy("grant");
    try {
      await onGrantQuota(user.id, {
        quick_search: quickGrant, deep_search: deepGrant,
        synthesis:    synthGrant, deep_read:   readsGrant,
      });
      // Only reset inputs on success — if the gift failed, keep the
      // typed values so the operator can retry without re-entering.
      setQuickGrant(0); setDeepGrant(0); setSynthGrant(0); setReadsGrant(0);
    } catch (e) {
      alert(`Gift-quota failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const handleTier = async () => {
    if (tierDraft === user.tier) return;
    if (!confirm(`Change ${user.email || user.id} from ${user.tier} → ${tierDraft}?`)) return;
    setBusy("tier");
    try {
      await onSetTier(user.id, tierDraft);
      onClose();
    } catch (e) {
      alert(`Tier change failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleNotify = async () => {
    const t = notifyTitle.trim();
    const b = notifyBody.trim();
    if (!t && !b) {
      setNotifyMsg({ text: "Add a title or body before sending.", error: true });
      return;
    }
    setBusy("notify");
    setNotifyMsg(null);
    try {
      await onNotify(user.id, { title: t, body: b, emoji: notifyEmoji.trim(), kind: notifyKind });
      setNotifyMsg({ text: "Sent. The user will see it on next page load." });
      setNotifyTitle("");
      setNotifyBody("");
      setNotifyEmoji("");
      setNotifyKind("general");
      // Auto-clear the success banner after a couple of seconds.
      window.setTimeout(() => setNotifyMsg(null), 2500);
    } catch (e) {
      setNotifyMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-stretch justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md h-full overflow-y-auto border-l shadow-2xl"
        style={{ backgroundColor: "var(--ats-bg-panel)", borderColor: "var(--ats-border-subtle)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b" style={{ backgroundColor: "var(--ats-bg-panel)", borderColor: "var(--ats-border-subtle)" }}>
          <div className="min-w-0">
            <h3 className="text-sm font-bold truncate" style={{ color: "var(--ats-fg-primary)" }}>
              {user.email || "(no email)"}
            </h3>
            <p className="text-[10px] font-mono truncate" style={{ color: "var(--ats-fg-muted)" }}>
              {user.id}
            </p>
          </div>
          <button onClick={onClose} className="text-[18px] px-2" style={{ color: "var(--ats-fg-muted)" }}>×</button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* ── Ban / unban ───────────────────────────────────────────── */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: user.is_banned ? "#ef4444" : "var(--ats-fg-secondary)" }}>
              {user.is_banned ? "🚫 Account suspended" : "Moderation"}
            </h4>
            {user.is_banned ? (
              <div className="space-y-2">
                <p className="text-xs" style={{ color: "var(--ats-fg-secondary)" }}>
                  Reason: <span className="font-semibold">{user.ban_reason || "(none given)"}</span>
                </p>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Banned {fmtDate(user.banned_at ?? null)} by {user.banned_by || "unknown"}
                </p>
                <button
                  onClick={handleUnban}
                  disabled={busy === "unban"}
                  className="rounded-lg px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                  style={{ backgroundColor: "#10b981" }}
                >
                  {busy === "unban" ? "Unbanning…" : "✅ Restore access"}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder="Reason (shown to user on next request)"
                  className="w-full rounded-lg border px-3 py-2 text-xs outline-none focus:border-red-500/60"
                  style={{ backgroundColor: "var(--ats-bg-panel)", borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-primary)" }}
                />
                <button
                  onClick={handleBan}
                  disabled={busy === "ban"}
                  className="rounded-lg px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                  style={{ backgroundColor: "#ef4444" }}
                >
                  {busy === "ban" ? "Banning…" : "🚫 Ban this account"}
                </button>
              </div>
            )}
          </section>

          {/* ── Tier change ───────────────────────────────────────────── */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--ats-fg-secondary)" }}>
              Subscription tier
            </h4>
            <div className="flex items-center gap-2">
              <select
                value={tierDraft}
                onChange={(e) => setTierDraft(e.target.value)}
                className="rounded-lg border px-2 py-1.5 text-xs outline-none"
                style={{ backgroundColor: "var(--ats-bg-panel)", borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-primary)" }}
              >
                {["free", "basic", "scholar", "dev"].map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <button
                onClick={handleTier}
                disabled={tierDraft === user.tier || busy === "tier"}
                className="rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
                style={{ backgroundColor: "#3b82f6" }}
              >
                {busy === "tier" ? "Updating…" : "Apply"}
              </button>
            </div>
            <p className="text-[10px] mt-1" style={{ color: "var(--ats-fg-muted)" }}>
              Current: {user.tier} · last changed {fmtDate(user.tier_updated_at)}
            </p>
          </section>

          {/* ── Gift quota ────────────────────────────────────────────── */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--ats-fg-secondary)" }}>
              🎁 Gift bonus quota
            </h4>
            <p className="text-[10px] mb-2" style={{ color: "var(--ats-fg-muted)" }}>
              Current balance — +{user.bonus?.quick_search ?? 0} quick · +{user.bonus?.deep_search ?? 0} deep · +{user.bonus?.synthesis ?? 0} synth · +{user.bonus?.deep_read ?? 0} chains.
              Grants stack on top of tier limits and don&apos;t reset at UTC midnight.
            </p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <QuotaGiftInput label="Quick searches"  value={quickGrant} onChange={setQuickGrant} />
              <QuotaGiftInput label="Deep searches"   value={deepGrant}  onChange={setDeepGrant} />
              <QuotaGiftInput label="Syntheses"       value={synthGrant} onChange={setSynthGrant} />
              {/* `Evidence chains` grants hit the same deep_read DB column
                  (kept for schema-backward-compat) — only the user-facing
                  label is renamed. */}
              <QuotaGiftInput label="Evidence chains" value={readsGrant} onChange={setReadsGrant} />
            </div>
            <button
              onClick={handleGrant}
              disabled={busy === "grant" || (quickGrant + deepGrant + synthGrant + readsGrant <= 0)}
              className="rounded-lg px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
              style={{ backgroundColor: "#10b981" }}
            >
              {busy === "grant" ? "Gifting…" : "Add to balance"}
            </button>
          </section>

          {/* ── Notify this user (dev popup) ──────────────────────────── */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--ats-fg-secondary)" }}>
              📬 Send popup notification
            </h4>
            <p className="text-[10px] mb-2" style={{ color: "var(--ats-fg-muted)" }}>
              Shows as a modal on this user&apos;s next page load. Use after manual tier bumps, gifted quota, or one-off thank-you notes.
            </p>
            <div className="mb-2">
              <label className="block text-[10px] font-semibold mb-1" style={{ color: "var(--ats-fg-secondary)" }}>
                Kind
              </label>
              <div className="flex gap-1">
                {(["general", "tier_upgrade", "quota_grant", "system"] as const).map(k => {
                  const active = notifyKind === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setNotifyKind(k)}
                      className="flex-1 rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors"
                      style={{
                        borderColor:     active ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                        backgroundColor: active ? "var(--ats-bg-accent-soft)" : "transparent",
                        color:           active ? "var(--ats-fg-accent)"      : "var(--ats-fg-secondary)",
                      }}
                    >
                      {k === "tier_upgrade" ? "Tier ↑" : k === "quota_grant" ? "Quota +" : k === "system" ? "System" : "General"}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mb-2">
              <label className="block text-[10px] font-semibold mb-1" style={{ color: "var(--ats-fg-secondary)" }}>
                Emoji (optional)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={notifyEmoji}
                  onChange={(e) => setNotifyEmoji(e.target.value.slice(0, 8))}
                  placeholder="—"
                  className="w-14 text-center rounded-lg border px-2 py-1 text-sm outline-none"
                  style={{ backgroundColor: "var(--ats-bg-panel)", borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-primary)" }}
                />
                <div className="flex-1 flex flex-wrap gap-1">
                  {NOTIFY_EMOJI_PRESETS.map(e => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => setNotifyEmoji(e)}
                      className="h-6 w-6 rounded text-sm leading-none flex items-center justify-center hover:bg-black/5 transition-colors"
                      style={{
                        backgroundColor: notifyEmoji === e ? "var(--ats-bg-accent-soft)" : "transparent",
                      }}
                      aria-label={`Pick ${e}`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mb-2">
              <label className="block text-[10px] font-semibold mb-1" style={{ color: "var(--ats-fg-secondary)" }}>
                Title
              </label>
              <input
                type="text"
                value={notifyTitle}
                onChange={(e) => setNotifyTitle(e.target.value)}
                maxLength={120}
                placeholder="e.g. You're now on Scholar"
                className="w-full rounded-lg border px-3 py-1.5 text-xs outline-none"
                style={{ backgroundColor: "var(--ats-bg-panel)", borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-primary)" }}
              />
            </div>
            <div className="mb-2">
              <label className="block text-[10px] font-semibold mb-1" style={{ color: "var(--ats-fg-secondary)" }}>
                Message
              </label>
              <textarea
                value={notifyBody}
                onChange={(e) => setNotifyBody(e.target.value)}
                maxLength={1200}
                rows={3}
                placeholder="Thanks for being an early user — we've bumped you up a tier. Enjoy!"
                className="w-full rounded-lg border p-2 text-xs outline-none resize-y"
                style={{ backgroundColor: "var(--ats-bg-panel)", borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-primary)" }}
              />
              <div className="flex justify-end text-[10px] tabular-nums" style={{ color: "var(--ats-fg-muted)" }}>
                {notifyBody.length} / 1200
              </div>
            </div>
            {notifyMsg && (
              <p
                className="text-[10px] rounded px-2 py-1 mb-2 border"
                style={{
                  borderColor:     notifyMsg.error ? "#ef444455" : "#10b98155",
                  backgroundColor: notifyMsg.error ? "#ef44441a" : "#10b9811a",
                  color:           notifyMsg.error ? "#ef4444"   : "#10b981",
                }}
              >
                {notifyMsg.text}
              </p>
            )}
            <button
              onClick={handleNotify}
              disabled={busy === "notify" || (notifyTitle.trim().length === 0 && notifyBody.trim().length === 0)}
              className="rounded-lg px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
              style={{ backgroundColor: "#8b5cf6" }}
            >
              {busy === "notify" ? "Sending…" : "Send notification"}
            </button>
          </section>

          {/* ── Activity feed ─────────────────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--ats-fg-secondary)" }}>
                Recent activity
              </h4>
              <button onClick={() => void loadActivity()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
                <RefreshCw size={10} /> Refresh
              </button>
            </div>
            {activityLoading && <p className="text-[10px] italic" style={{ color: "var(--ats-fg-muted)" }}>Loading…</p>}
            {!activityLoading && activity && activity.length === 0 && (
              <p className="text-[10px] italic" style={{ color: "var(--ats-fg-muted)" }}>No activity yet.</p>
            )}
            {activity && activity.length > 0 && (
              <div className="space-y-1.5 max-h-[40vh] overflow-y-auto pr-1">
                {activity.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-lg border p-2"
                    style={{ borderColor: "var(--ats-border-subtle)" }}
                  >
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      {/* Raw entry_type keys → product-facing labels so
                          the chip reads "EVIDENCE CHAIN" instead of the
                          internal `deep_read` string. Kept in-line here
                          rather than a shared util because this is the
                          only chip surface; the Top Queries breakdown
                          has its own identical mapping above. */}
                      {(() => {
                        const LABELS: Record<string, string> = {
                          search:         "SEARCH",
                          quick_search:   "QUICK SEARCH",
                          deep_search:    "DEEP SEARCH",
                          synthesis:      "SYNTHESIS",
                          deep_read:      "EVIDENCE CHAIN",
                          evidence_chain: "EVIDENCE CHAIN",
                        };
                        const raw = row.entry_type || "search";
                        return (
                          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--ats-fg-accent)" }}>
                            {LABELS[raw] ?? raw.replace(/_/g, " ").toUpperCase()}
                          </span>
                        );
                      })()}
                      <span className="text-[9px] tabular-nums" style={{ color: "var(--ats-fg-muted)" }}>
                        {fmtDate(row.created_at)}
                      </span>
                    </div>
                    {row.query && (
                      <p className="text-[11px] font-semibold truncate" title={row.query} style={{ color: "var(--ats-fg-primary)" }}>
                        {row.query}
                      </p>
                    )}
                    {row.summary && (
                      <p className="text-[10px] mt-0.5 line-clamp-2" style={{ color: "var(--ats-fg-muted)" }}>
                        {row.summary}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Room for future additions — flagged here so it's obvious
              where to extend. Potential entries: "Reset password via
              Supabase Admin API", "Revoke sessions", "Export this user's
              data (GDPR)", "Merge duplicate account". Each slots in as
              another <section> block above this comment. */}
        </div>
      </div>
    </div>
  );
}

function QuotaGiftInput({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block">
      <span className="block text-[9px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: "var(--ats-fg-muted)" }}>
        {label}
      </span>
      <input
        type="number"
        min={0}
        max={9999}
        step={1}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(9999, parseInt(e.target.value || "0", 10) || 0)))}
        className="w-full rounded-md border px-2 py-1.5 text-xs tabular-nums outline-none"
        style={{ backgroundColor: "var(--ats-bg-panel)", borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-primary)" }}
      />
    </label>
  );
}


// ── Collapse-state hook (per-panel, persisted) ────────────────────────────
// `id` must be stable across renders — it's the localStorage key. The
// hook returns `{ open, toggle }` so panels can render a caret button in
// their header + conditionally render the body. State defaults to
// `defaultOpen` on first visit (typically true so nothing is hidden
// unexpectedly on first load), then remembers the operator's last
// choice across refreshes.

function useCollapsed(id: string, defaultOpen = true): { open: boolean; toggle: () => void } {
  const storageKey = `ats-admin-collapsed:${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultOpen;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === "open")   return true;
      if (raw === "closed") return false;
    } catch { /* ignore */ }
    return defaultOpen;
  });
  const toggle = useCallback(() => {
    setOpen(prev => {
      const next = !prev;
      if (typeof window !== "undefined") {
        try { window.localStorage.setItem(storageKey, next ? "open" : "closed"); } catch { /* ignore */ }
      }
      return next;
    });
  }, [storageKey]);
  return { open, toggle };
}


// ── CollapseCaret — tiny chevron button shared across collapsible panels ──
// Renders ▾ when open, ▸ when closed. Click flips state. Sits in the
// panel header next to the Refresh button so operators can tuck away
// any panel they don't currently care about and the admin page stays
// scannable even with 15+ sections.

// ── RecTermRowEditor ──────────────────────────────────────────────────────
// One row of the recommended-term pool table. Inline-editable text + an
// active/disabled toggle + a delete button. Local edit buffer so typing
// doesn't fire PUT on every keystroke; commits on blur or Enter when the
// text actually changed.
function RecTermRowEditor({
  row, onToggle, onSave, onDelete,
}: {
  row: { id: number; text: string; active: boolean };
  onToggle: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(row.text);
  useEffect(() => { setDraft(row.text); }, [row.text]);
  return (
    <div
      className="flex items-center gap-1.5 rounded border px-2 py-1"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: row.active ? "var(--ats-bg-base)" : "var(--ats-bg-panel)",
        opacity:         row.active ? 1 : 0.6,
      }}
    >
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim() && draft !== row.text) onSave(draft); }}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        maxLength={200}
        className="flex-1 bg-transparent text-xs outline-none"
        style={{ color: "var(--ats-fg-primary)" }}
      />
      <button
        onClick={onToggle}
        title={row.active ? "Disable (hide from users)" : "Enable (show to users)"}
        className="text-[10px] inline-flex items-center justify-center rounded border h-5 w-5 transition-colors"
        style={{
          color:       row.active ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
          borderColor: row.active ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
        }}
      >
        {row.active ? <Check size={10} /> : <X size={10} />}
      </button>
      <button
        onClick={onDelete}
        title="Delete this term permanently"
        className="text-[10px] inline-flex items-center justify-center rounded border h-5 w-5 transition-colors"
        style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.4)" }}
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}


function CollapseCaret({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={open ? "Collapse this panel" : "Expand this panel"}
      aria-label={open ? "Collapse panel" : "Expand panel"}
      aria-expanded={open}
      className="text-[11px] inline-flex h-5 w-5 items-center justify-center rounded border transition-colors"
      style={{
        borderColor: "var(--ats-border-subtle)",
        color:       "var(--ats-fg-muted)",
      }}
    >
      {open ? "▾" : "▸"}
    </button>
  );
}


// ── HeadroomBar (used by SystemHealthPanel) ────────────────────────────────
// Horizontal usage bar: current / cap with a coloured fill. Fill colour
// ladders green (<50%) → amber (<80%) → red (≥80%) so ops can tell
// "OK / watch / upgrade now" at a glance. Percentage is pre-computed
// on the backend (avoids client-side division by zero).

function HeadroomBar({ label, used, cap, pct }: { label: string; used: number; cap: number; pct: number }) {
  const color = pct >= 80 ? "#ef4444" : pct >= 50 ? "#f59e0b" : "#10b981";
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] mb-0.5">
        <span className="font-semibold" style={{ color: "var(--ats-fg-secondary)" }}>{label}</span>
        <span className="tabular-nums" style={{ color }}>
          {used.toLocaleString()} / {cap.toLocaleString()} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "var(--ats-border-subtle)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${clamped}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}


// ── Per-source retrieval stats panel ───────────────────────────────────────
// Table row per academic source in the window. Error rate colour-codes
// the whole row: ≥50% = red, ≥20% = amber, <20% = neutral. A source
// that returned 0 papers across all fetches gets its own "dead source"
// indicator (useful for "ERIC is rate-limiting us today" cases).

function SourceStatsPanel({ rows }: { rows: SourceStatRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No retrievals in the last 15 minutes.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr
            className="text-left text-[10px] uppercase tracking-wider border-b"
            style={{ color: "var(--ats-fg-muted)", borderColor: "var(--ats-border-subtle)" }}
          >
            <th className="pb-2 pr-3 font-semibold">Source</th>
            <th className="pb-2 pr-3 font-semibold text-right">Fetches</th>
            <th className="pb-2 pr-3 font-semibold text-right">Avg papers</th>
            <th className="pb-2 pr-3 font-semibold text-right">Avg latency</th>
            <th className="pb-2 pr-3 font-semibold text-right">p95</th>
            <th className="pb-2 pr-3 font-semibold text-right">Success</th>
            <th className="pb-2 font-semibold text-right">Errors</th>
          </tr>
        </thead>
        <tbody style={{ color: "var(--ats-fg-primary)" }}>
          {rows.map(r => {
            const errRate = r.fetches > 0 ? r.errors / r.fetches : 0;
            const deadSource = r.fetches > 0 && r.total_papers === 0;
            const rowBg = deadSource
              ? "rgba(239,68,68,0.08)"
              : errRate >= 0.5
              ? "rgba(239,68,68,0.05)"
              : errRate >= 0.2
              ? "rgba(245,158,11,0.05)"
              : undefined;
            return (
              <tr
                key={r.source}
                className="border-b"
                style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: rowBg }}
              >
                <td className="py-1.5 pr-3 font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
                  {r.source}
                  {deadSource && (
                    <span className="ml-2 text-[9px] font-bold" style={{ color: "#ef4444" }}>
                      0 PAPERS
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.fetches}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.avg_papers_per_fetch}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: "var(--ats-fg-secondary)" }}>
                  {Math.round(r.avg_latency_ms)} ms
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: "var(--ats-fg-secondary)" }}>
                  {Math.round(r.p95_latency_ms)} ms
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: r.success_rate >= 0.95 ? "#10b981" : r.success_rate >= 0.8 ? "#f59e0b" : "#ef4444" }}>
                  {(r.success_rate * 100).toFixed(1)}%
                </td>
                <td className="py-1.5 text-right tabular-nums" style={{ color: r.errors > 0 ? "#ef4444" : "var(--ats-fg-muted)" }}>
                  {r.errors}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


// ── Feature-adoption funnel panel ──────────────────────────────────────────
// Funnel visualisation: horizontal bars, each sized relative to Stage 1
// (active users). Percentage shown is relative to the active base, so
// "60%" reads as "60% of users who took any action this period reached
// this feature". Excludes anonymous users so the cohort matches the
// authenticated KPIs above.

function ConversionFunnelPanel({ data }: { data: FunnelResponse | null }) {
  if (!data) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        Loading…
      </div>
    );
  }
  if (data.error) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "#ef4444" }}>
        Funnel fetch failed: {data.error}
      </div>
    );
  }
  const stages = data.stages || [];
  // Server warnings still render inline (kept generic so future schema
  // drifts can reuse this slot without code changes).
  const warning = data.warning;
  if (stages.length === 0 || stages[0].count === 0) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No authenticated activity in the last {data.window_days} days.
      </div>
    );
  }
  const top = stages[0].count;
  const stageColor = (idx: number) => {
    // 6-step ladder so each stage gets a distinct hue. Order intentionally
    // walks the rainbow so the leftmost (broadest) stage is the warmest
    // green and rare features (deep_read, feedback) sit at the cooler end.
    return ["#10b981", "#22d3ee", "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b"][idx % 6];
  };
  return (
    <div className="space-y-2">
      {warning && (
        <div
          className="rounded-md border px-2 py-1.5 mb-1 flex items-start gap-1.5"
          style={{
            borderColor: "rgba(245,158,11,0.45)",
            backgroundColor: "rgba(245,158,11,0.10)",
          }}
        >
          <span aria-hidden>⚠️</span>
          <p className="text-[10px] leading-snug" style={{ color: "#f59e0b" }}>
            {warning}
          </p>
        </div>
      )}
      {stages.map((s, i) => {
        const widthPct = Math.max(6, Math.round((s.count / top) * 100));
        return (
          <div key={s.key}>
            <div className="flex items-center justify-between text-[11px] mb-0.5">
              <span className="font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
                {s.label}
              </span>
              <span className="tabular-nums" style={{ color: "var(--ats-fg-secondary)" }}>
                {s.count} <span className="text-[9px]" style={{ color: "var(--ats-fg-muted)" }}>({s.pct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="h-4 rounded" style={{ backgroundColor: "var(--ats-border-subtle)" }}>
              <div
                className="h-full rounded transition-all"
                style={{ width: `${widthPct}%`, backgroundColor: stageColor(i) }}
              />
            </div>
          </div>
        );
      })}
      {/* Drop-off callout — shows the biggest stage-to-stage loss so
          ops know exactly which step to work on. */}
      {stages.length >= 2 && (() => {
        let worstDrop = 0;
        let worstFrom = "";
        let worstTo   = "";
        for (let i = 1; i < stages.length; i++) {
          const drop = stages[i - 1].count - stages[i].count;
          if (drop > worstDrop) {
            worstDrop = drop;
            worstFrom = stages[i - 1].label;
            worstTo   = stages[i].label;
          }
        }
        if (worstDrop <= 0) return null;
        return (
          <p className="text-[10px] mt-2 pt-2 border-t" style={{ color: "var(--ats-fg-muted)", borderColor: "var(--ats-border-subtle)" }}>
            📉 Biggest drop-off: <span className="font-semibold" style={{ color: "var(--ats-fg-primary)" }}>{worstFrom} → {worstTo}</span> lost {worstDrop} user{worstDrop !== 1 ? "s" : ""}.
          </p>
        );
      })()}
    </div>
  );
}


// ── Admin audit log panel ──────────────────────────────────────────────────
// Renders admin_audit_log rows newest-first. Each row shows actor, action
// (colour-coded by category), target, and a relative timestamp. No
// server-side pagination yet — capped at 200 rows, which covers weeks of
// alpha-scale admin activity in a single fetch.

function AuditLogPanel({ rows }: { rows: AuditLogRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No admin actions logged yet.
      </div>
    );
  }
  // Colour families by category so the log reads as "ban events cluster
  // red, maintenance toggles amber, edits blue". No semantic meaning
  // beyond visual scanning.
  const actionColor = (action: string): string => {
    if (action.includes("ban")) return "#ef4444";
    if (action.includes("maintenance_on")) return "#f59e0b";
    if (action.includes("maintenance_off")) return "#10b981";
    if (action.includes("maintenance")) return "#f59e0b";
    if (action.includes("nuke")) return "#ef4444";
    if (action.includes("delete")) return "#ef4444";
    if (action.includes("edit")) return "#3b82f6";
    if (action.includes("grant")) return "#10b981";
    if (action.includes("tier")) return "#8b5cf6";
    return "var(--ats-fg-accent)";
  };
  return (
    <div className="max-h-96 overflow-y-auto thin-scrollbar pr-1 space-y-1">
      {rows.map(r => (
        <div
          key={r.id}
          className="rounded-md border p-2 text-xs"
          style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-base)" }}
        >
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="shrink-0 text-[9px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5"
                style={{
                  color: actionColor(r.action),
                  borderColor: actionColor(r.action) + "55",
                  backgroundColor: actionColor(r.action) + "1a",
                  border: "1px solid",
                }}
              >
                {r.action}
              </span>
              <span className="truncate text-[11px] font-semibold" style={{ color: "var(--ats-fg-primary)" }} title={r.actor_email}>
                {r.actor_email}
              </span>
            </div>
            <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--ats-fg-muted)" }}>
              {fmtDateTime(r.created_at)}
            </span>
          </div>
          {(r.target_type || r.target_id) && (
            <p className="text-[10px] font-mono" style={{ color: "var(--ats-fg-secondary)" }}>
              <span style={{ color: "var(--ats-fg-muted)" }}>{r.target_type || "—"}:</span> {r.target_id || "—"}
            </p>
          )}
          {r.meta && Object.keys(r.meta).length > 0 && (
            <p className="text-[10px] mt-0.5 break-all" style={{ color: "var(--ats-fg-muted)" }}>
              {JSON.stringify(r.meta)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}


// ── Top users by cost ──────────────────────────────────────────────────────
// Compact ranked list. Each row renders a rank pill, email, tier badge,
// total cost in USD, total actions, and a small action-breakdown bar.
// Click-through opens the existing UserDetailDrawer so ban/gift/tier
// flows are one click away from the "this user is expensive" signal.

function TopUsersPanel({ rows, onOpenDrawer }: { rows: TopUserRow[]; onOpenDrawer: (u: TopUserRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No usage yet in this window.
      </div>
    );
  }
  // Find the max total_cost so we can render a bar chart that's
  // proportional to the top row. All subsequent rows normalise to it.
  const maxCost = Math.max(0.0001, ...rows.map(r => r.total_cost));
  return (
    <div className="space-y-1 max-h-96 overflow-y-auto thin-scrollbar pr-1">
      {rows.map((u, idx) => {
        const barPct = Math.max(4, Math.round((u.total_cost / maxCost) * 100));
        return (
          <button
            key={u.user_id}
            onClick={() => onOpenDrawer(u)}
            className="w-full text-left rounded-md border p-2 transition-colors hover:bg-[var(--ats-bg-accent-soft)]"
            style={{ borderColor: "var(--ats-border-subtle)" }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-bold"
                style={{
                  backgroundColor: idx < 3 ? "rgba(239, 68, 68, 0.12)" : "var(--ats-bg-panel)",
                  color:           idx < 3 ? "#ef4444" : "var(--ats-fg-muted)",
                  border: "1px solid var(--ats-border-subtle)",
                }}
              >
                {idx + 1}
              </span>
              <span className="flex-1 min-w-0 truncate text-[11px] font-semibold" title={u.email ?? ""} style={{ color: "var(--ats-fg-primary)" }}>
                {u.email || <span className="italic" style={{ color: "var(--ats-fg-muted)" }}>(no email · {u.user_id.slice(0, 8)}…)</span>}
              </span>
              {u.tier && (
                <span
                  className="shrink-0 inline-flex text-[9px] font-bold px-1 py-0.5 rounded uppercase tracking-wide"
                  style={{
                    color: TIER_COLORS[u.tier] ?? "#64748b",
                    backgroundColor: (TIER_COLORS[u.tier] ?? "#64748b") + "22",
                    borderColor:     (TIER_COLORS[u.tier] ?? "#64748b") + "55",
                    borderWidth: 1, borderStyle: "solid",
                  }}
                >
                  {u.tier}
                </span>
              )}
              {u.is_banned && (
                <span className="shrink-0 text-[9px] font-bold" style={{ color: "#ef4444" }}>BANNED</span>
              )}
              <span className="shrink-0 text-[11px] font-bold tabular-nums" style={{ color: "#ef4444" }}>
                ${u.total_cost.toFixed(3)}
              </span>
            </div>
            {/* Bar + breakdown */}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1 rounded-full" style={{ backgroundColor: "var(--ats-border-subtle)" }}>
                <div className="h-full rounded-full" style={{ width: `${barPct}%`, backgroundColor: "#ef4444" }} />
              </div>
              <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--ats-fg-muted)" }}>
                {u.total_actions} actions
              </span>
            </div>
            <p className="text-[10px] mt-0.5" style={{ color: "var(--ats-fg-muted)" }}>
              {u.quick_search_count}q · {u.deep_search_count}d · {u.synthesis_count}s · {u.deep_read_count}c
            </p>
          </button>
        );
      })}
    </div>
  );
}

// ── Top queries ────────────────────────────────────────────────────────────
// Most-searched text strings. Each row shows the query verbatim,
// occurrence count, unique-users count (engagement breadth), and a
// compact by-entry-type breakdown (search/synthesis/deep_read).

function TopQueriesPanel({ rows }: { rows: TopQueryRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No queries in this window.
      </div>
    );
  }
  const maxCount = Math.max(1, ...rows.map(r => r.count));
  return (
    <div className="space-y-1 max-h-96 overflow-y-auto thin-scrollbar pr-1">
      {/* Map raw backend entry_type keys to product-facing display
          names so the breakdown reads "2 evidence_chain" as
          "2 Evidence Chain" etc. Keys absent from this map render
          verbatim so new event types still show up (just un-themed). */}
      {rows.map((q, idx) => {
        const barPct = Math.max(4, Math.round((q.count / maxCount) * 100));
        const ENTRY_TYPE_LABELS: Record<string, string> = {
          search:         "Search",
          quick_search:   "Quick Search",
          deep_search:    "Deep Search",
          synthesis:      "Synthesis",
          deep_read:      "Evidence Chain",
          evidence_chain: "Evidence Chain",
        };
        const breakdown = Object.entries(q.entry_types)
          .sort(([, a], [, b]) => b - a)
          .map(([t, n]) => `${n} ${ENTRY_TYPE_LABELS[t] ?? t}`)
          .join(" · ");
        return (
          <div
            key={`${q.query}-${idx}`}
            className="rounded-md border p-2"
            style={{ borderColor: "var(--ats-border-subtle)" }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-bold"
                style={{
                  backgroundColor: idx < 3 ? "rgba(139, 92, 246, 0.12)" : "var(--ats-bg-panel)",
                  color:           idx < 3 ? "#8b5cf6" : "var(--ats-fg-muted)",
                  border: "1px solid var(--ats-border-subtle)",
                }}
              >
                {idx + 1}
              </span>
              <span className="flex-1 min-w-0 truncate text-[11px] font-semibold" title={q.query} style={{ color: "var(--ats-fg-primary)" }}>
                {q.query}
              </span>
              <span className="shrink-0 text-[11px] font-bold tabular-nums" style={{ color: "#8b5cf6" }}>
                ×{q.count}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1 rounded-full" style={{ backgroundColor: "var(--ats-border-subtle)" }}>
                <div className="h-full rounded-full" style={{ width: `${barPct}%`, backgroundColor: "#8b5cf6" }} />
              </div>
              <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--ats-fg-muted)" }}>
                {q.unique_users} user{q.unique_users !== 1 ? "s" : ""}
              </span>
            </div>
            {breakdown && (
              <p className="text-[10px] mt-0.5" style={{ color: "var(--ats-fg-muted)" }}>
                {breakdown}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}


// ── KPI window toggle ──────────────────────────────────────────────────────
// Three-segment rocker: Today · Week · Month. Compact (same height as the
// section heading) so it sits next to "Live KPIs" without dominating.
// Active segment uses the accent token pair so colour follows the user's
// current theme — emerald on Morning Mint, amber on Warm Paper, etc.

type WindowKey = "today" | "week" | "month" | "year";

// Drop the generic parameter + cast at the onChange boundary. The
// caller always passes a setState<narrower-union> signature; the cast
// is safe because the toggle will never hand back a value outside its
// rendered options.
function WindowToggle({
  value, onChange, includeYear = false,
}: {
  value: WindowKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (v: any) => void;
  /** Add a "Year" segment at the end. Defaults to false because the
   *  KPI hero + chart toggle already cover longer windows via their
   *  own selectors. Top-N panels opt in because "top users over the
   *  past year" is a meaningful question that 30-day can't answer. */
  includeYear?: boolean;
}) {
  const options: Array<{ v: WindowKey; label: string }> = [
    { v: "today", label: "Today" },
    { v: "week",  label: "Week"  },
    { v: "month", label: "Month" },
    ...(includeYear ? [{ v: "year" as WindowKey, label: "Year" }] : []),
  ];
  return (
    <div
      role="radiogroup"
      aria-label="KPI time window"
      className="inline-flex items-center rounded-lg border p-0.5 text-[10px] font-bold tracking-wide select-none"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-panel)",
      }}
    >
      {options.map(opt => {
        const active = value === opt.v;
        return (
          <button
            key={opt.v}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.v)}
            className="rounded-md px-2.5 py-1 transition-colors"
            style={active ? {
              backgroundColor: "var(--ats-bg-accent-soft)",
              color:           "var(--ats-fg-accent)",
            } : {
              color: "var(--ats-fg-muted)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}


function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
      style={{
        color:            enabled ? "#f59e0b" : "#10b981",
        backgroundColor:  enabled ? "rgba(245,158,11,0.12)" : "rgba(16,185,129,0.10)",
        borderColor:      enabled ? "rgba(245,158,11,0.45)" : "rgba(16,185,129,0.40)",
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: enabled ? "#f59e0b" : "#10b981" }}
      />
      {enabled ? "ACTIVE — site offline" : "Idle — site live"}
    </span>
  );
}


// ── Per-user analytics filter toolbar ──────────────────────────────────────
// Compact horizontal control rendered above the KPI hero. Three regions:
//   1. Toggle:    "Hide developer accounts" — filters all tier="dev" rows.
//   2. Chip list: currently-hidden accounts (with × to remove). Each chip
//                 shows the matched email if known, else a short UUID
//                 prefix so the admin can tell at a glance who's hidden.
//   3. Add input: paste a UUID OR an email + Enter. The input field
//                 surfaces inline error text below itself for invalid
//                 input or unknown emails (rather than alert()-ing).
//
// The right-aligned caption is deliberate: the filter ONLY hides per-user
// rows, NOT aggregate KPIs / charts. Operators who don't read the caption
// would otherwise expect the dollar figures in "Cost today" to drop when
// they hide their own dev account, then file a bug. The caption also
// invites the next-step backend query parameter as a known follow-up.
function AnalyticsFilterToolbar({
  hideDevs,
  onToggleHideDevs,
  hideAnon,
  onToggleHideAnon,
  anonCount,
  extraHidden,
  rawUserList,
  onAdd,
  onRemove,
}: {
  hideDevs:           boolean;
  onToggleHideDevs:   (v: boolean) => void;
  hideAnon:           boolean;
  onToggleHideAnon:   (v: boolean) => void;
  anonCount:          number;
  extraHidden:        Set<string>;
  rawUserList:        AdminUser[];
  onAdd:              (input: string) => string | null;  // returns error string or null
  onRemove:           (uid: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [err,   setErr]   = useState<string>("");

  const submit = () => {
    const e = onAdd(draft);
    if (e) {
      setErr(e);
      return;
    }
    setDraft("");
    setErr("");
  };

  // Build a quick "uid → email/short-id" labeller so chips read as
  // human emails when known. Falls back to the first 8 hex of the UUID
  // when the user isn't (yet) in rawUserList — e.g., banned users that
  // the admin hid before the list refreshed, or non-existent UUIDs the
  // operator pasted speculatively.
  const labelFor = (uid: string): string => {
    const u = rawUserList.find(r => r.id === uid);
    return u?.email ?? `${uid.slice(0, 8)}…`;
  };

  const chips = [...extraHidden];

  return (
    <section
      className="rounded-2xl border px-4 py-3 flex flex-col gap-2"
      style={panelStyle}
    >
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wider text-[10px]"
              style={{ color: "var(--ats-fg-secondary)" }}>
          <EyeOff size={12} />
          Per-user filter
        </span>

        {/* Hide-devs toggle */}
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideDevs}
            onChange={e => onToggleHideDevs(e.target.checked)}
            className="h-3 w-3 cursor-pointer"
          />
          <span style={{ color: "var(--ats-fg-primary)" }}>
            Hide developer accounts
          </span>
          <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            (tier = dev)
          </span>
        </label>

        <span style={{ color: "var(--ats-border-subtle)" }}>·</span>

        {/* Hide-anonymous toggle. Same plumbing as hide-devs: filters every
            per-user panel AND drops the anon cohort from the Signed-in users
            KPI. The chip count after the label is the server-reported anon
            cohort size so the operator knows what's being subtracted. */}
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideAnon}
            onChange={e => onToggleHideAnon(e.target.checked)}
            className="h-3 w-3 cursor-pointer"
          />
          <span style={{ color: "var(--ats-fg-primary)" }}>
            Hide anonymous users
          </span>
          <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            (email = ∅, {anonCount} now)
          </span>
        </label>

        <span style={{ color: "var(--ats-border-subtle)" }}>·</span>

        {/* Chip list of manually-hidden accounts */}
        {chips.length === 0 ? (
          <span className="text-[10px] italic" style={{ color: "var(--ats-fg-muted)" }}>
            No additional accounts hidden
          </span>
        ) : (
          <div className="inline-flex items-center gap-1 flex-wrap">
            {chips.map(uid => (
              <span
                key={uid}
                className="inline-flex items-center gap-1 rounded-full border pl-2 pr-1 py-0.5 text-[10px]"
                style={{
                  borderColor:     "var(--ats-border-subtle)",
                  backgroundColor: "var(--ats-bg-panel)",
                  color:           "var(--ats-fg-secondary)",
                }}
                title={uid}
              >
                <span className="font-mono">{labelFor(uid)}</span>
                <button
                  onClick={() => onRemove(uid)}
                  className="rounded-full p-0.5 hover:bg-[var(--ats-bg-accent-soft)] transition-colors"
                  title="Stop hiding this account"
                  aria-label="Remove from hidden list"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Spacer + caption pinned right */}
        <span className="ml-auto text-[10px] max-w-[320px] text-right"
              style={{ color: "var(--ats-fg-muted)" }}
              title="KPIs and charts use server-aggregated data; filtering them would need a backend query parameter (TODO).">
          Filters apply to per-user panels only — KPI cards / charts include all activity.
        </span>
      </div>

      {/* Input row — kept on its own line so the chip list above wraps
          cleanly without colliding with the typing field. Submits on
          Enter or on the + button. */}
      <div className="flex items-center gap-2 text-xs">
        <input
          value={draft}
          onChange={e => { setDraft(e.target.value); if (err) setErr(""); }}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="Hide a specific account — paste UUID or type email + Enter"
          className="flex-1 max-w-[480px] rounded-md border px-2.5 py-1 font-mono text-[11px] outline-none focus:ring-1"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-primary)",
          }}
        />
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] disabled:opacity-50 transition-colors"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-secondary)",
          }}
        >
          <Plus size={11} />
          Hide
        </button>
        {err && (
          <span className="text-[10px] text-red-600 dark:text-red-400" role="alert">
            {err}
          </span>
        )}
      </div>
    </section>
  );
}

// ── Admin login screen ────────────────────────────────────────────────────
// Gates /admin behind its own email+password prompt against the isolated
// admin Supabase client. Only accepts dev-account emails (checked
// client-side for UX; the backend re-enforces on every request). On
// success, onAuthStateChange fires and flips the page to the dashboard.

function AdminLoginScreen({ currentEmail }: { currentEmail: string | null }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState<string>("");

  const submit = async () => {
    const e = email.trim().toLowerCase();
    console.log("[admin-login] submit clicked, email:", e);
    if (!e) {
      setErr("Please enter an email.");
      return;
    }
    if (!password) {
      setErr("Please enter a password.");
      return;
    }
    if (!DEV_ACCTS.includes(e)) {
      setErr("Only developer accounts (dev01 / dev02 / dev03 @academicats.com) can sign into the admin console.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      console.log("[admin-login] calling Supabase signInWithPassword…");
      const { data, error } = await adminSupabase.auth.signInWithPassword({ email: e, password });
      console.log("[admin-login] Supabase response:", { hasSession: !!data?.session, error });
      if (error) {
        setErr(error.message);
      } else if (!data?.session) {
        setErr("Supabase returned no session. Check that the account exists and email/password auth is enabled for this project.");
      }
      // success path: onAuthStateChange listener in AdminPage re-renders to the dashboard.
    } catch (ex) {
      console.error("[admin-login] exception:", ex);
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-theme="day-mint" data-tone="day" className="admin-main h-screen bg-[var(--ats-bg-base)] flex items-center justify-center px-4">
      <div
        className="w-full max-w-sm rounded-2xl border p-6 shadow-lg"
        style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}
      >
        <div className="flex items-center gap-2 mb-2">
          <BarChartIcon size={18} style={{ color: "var(--ats-fg-accent)" }} />
          <h1 className="text-base font-bold" style={{ color: "var(--ats-fg-primary)" }}>
            AcademiCats · Admin
          </h1>
          <span
            className="text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 font-bold border"
            style={{
              backgroundColor: "var(--ats-bg-accent-soft)",
              color:           "var(--ats-fg-accent)",
              borderColor:     "var(--ats-border-accent)",
            }}
          >DEV</span>
        </div>
        <p className="text-xs mb-4 leading-relaxed" style={{ color: "var(--ats-fg-secondary)" }}>
          Separate login — the admin console has its own auth context.
          {currentEmail && (
            <>
              {" "}You&apos;re signed into the main app as <code style={{ color: "var(--ats-fg-primary)" }}>{currentEmail}</code>;
              this won&apos;t change that.
            </>
          )}
        </p>
        <form
          onSubmit={(ev) => { ev.preventDefault(); void submit(); }}
          className="space-y-2.5"
        >
          <div>
            <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--ats-fg-muted)" }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="dev01@academicats.com"
              disabled={busy}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--ats-border-accent)]"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-base)",
                color:           "var(--ats-fg-primary)",
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--ats-fg-muted)" }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--ats-border-accent)]"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-base)",
                color:           "var(--ats-fg-primary)",
              }}
            />
          </div>
          {err && (
            <p
              className="text-[11px] rounded-md px-2 py-1.5 border"
              style={{
                borderColor:     "#ef444455",
                backgroundColor: "#ef44441a",
                color:           "#ef4444",
              }}
            >{err}</p>
          )}
          <button
            type="submit"
            // Also bind onClick directly — belt-and-suspenders if the form's
            // onSubmit doesn't fire (browser quirks, nested form, autofill
            // weirdness). The handler is idempotent because `busy` guards
            // re-entry, and `type="submit"` still triggers form submission
            // for the Enter-key path.
            onClick={(ev) => { ev.preventDefault(); void submit(); }}
            disabled={busy}
            className="w-full rounded-lg px-4 py-2 text-sm font-bold shadow-md hover:brightness-110 hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-wait disabled:shadow-none cursor-pointer"
            style={{
              // Solid accent-colored background so the enabled state is
              // unambiguously "click me" rather than blending into the
              // pale panel surface. Previous soft-tint version looked
              // nearly identical to its disabled state on day-mint.
              backgroundColor: "var(--ats-fg-accent)",
              color:           "#ffffff",
              border:          "1px solid var(--ats-fg-accent)",
            }}
          >
            {busy ? "Signing in…" : "Sign in to admin"}
          </button>
        </form>
        <Link
          href="/"
          className="block mt-4 text-center text-[11px] underline"
          style={{ color: "var(--ats-fg-muted)" }}
        >
          ← Back to the main app
        </Link>
      </div>
    </div>
  );
}

// Shared panel surface style — kept as a constant so every rounded section
// card renders with the same token-backed border + background without
// repeating the style object in JSX.
const panelStyle: React.CSSProperties = {
  borderColor:     "var(--ats-border-subtle)",
  backgroundColor: "var(--ats-bg-panel)",
};

// ── KPI card ────────────────────────────────────────────────────────────────

function KpiCard({
  icon, label, value, sublabel, color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sublabel: string;
  color: string;
}) {
  return (
    <div
      className="rounded-xl border p-3"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-panel)",
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
        {icon}
        {label}
      </div>
      <div
        className="mt-1.5 text-2xl font-bold tabular-nums leading-none"
        style={{ color: "var(--ats-fg-primary)" }}
      >
        {value}
      </div>
      <div
        className="mt-1.5 text-[10px] truncate"
        style={{ color: "var(--ats-fg-muted)" }}
        title={sublabel}
      >
        {sublabel || "\u00A0"}
      </div>
    </div>
  );
}

// ── Line chart ──────────────────────────────────────────────────────────────
// Four-series stacked view: quick search, deep search, synthesis, deep reads.
// Fixed viewBox so grid labels scale predictably; background grid at 0/25/50/75/100%.

// ── Nice-number rounding (for Y axis) ─────────────────────────────────────
// Given an arbitrary data max, return a "nice" upper bound whose axis
// ticks are human-readable (1, 2, 5, 10, 20, 50, 100, 200, 500, …).
// The previous version used Math.ceil(m / 10^floor(log10(m))) * 10^... ,
// which produced e.g. 7 → 7 or 23 → 30 — fine for 1-digit numbers but
// awkward elsewhere. This returns the tight power-of-1/2/5 fit so a
// max of 23 rounds to 25 and 1137 rounds to 1200.
function niceAxisMax(m: number): number {
  if (m <= 1) return 1;
  const exponent = Math.floor(Math.log10(m));
  const fraction = m / Math.pow(10, exponent);
  let niceFraction: number;
  if      (fraction <= 1)   niceFraction = 1;
  else if (fraction <= 2)   niceFraction = 2;
  else if (fraction <= 2.5) niceFraction = 2.5;
  else if (fraction <= 5)   niceFraction = 5;
  else                       niceFraction = 10;
  return niceFraction * Math.pow(10, exponent);
}

// ── X-axis tick picker (adaptive to window length) ────────────────────────
// Different time ranges demand different tick densities + formats:
//   ≤7 days   → tick every day,  "Mon 21" format (weekday + day number)
//   ≤30 days  → tick every ~5d,  "04-21"        (MM-DD)
//   ≤90 days  → tick every ~week,"Apr 21"       (Mon D)
//   ≤365 days → tick ~monthly,   "Apr"          (Mon)
// Returns the set of indices to render AND the format function. Decoupling
// the format lets the final "today" tick always use its full label even
// when intermediate ticks are compressed.
// Tick formatters interpret the bucket's ISO date as a calendar day in
// NY. Earlier revisions used `getUTCDate()` / `getUTCDay()` / etc. on
// `new Date(iso + "T00:00:00Z")` — that gave UTC components, which
// mismatched the rest of the admin UI (now NY-anchored everywhere).
// Pre-built Intl formatters keep the call sites cheap.
const _NY_TICK_DAY_NUM_FMT  = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", day: "numeric" });
const _NY_TICK_WEEKDAY_FMT  = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
const _NY_TICK_MONTH_FMT    = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short" });
const _NY_TICK_MD_FMT       = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", month: "2-digit", day: "2-digit" });

function pickXTicks(data: TimeSeriesPoint[], windowDays: number): {
  indices: number[];
  fmt: (d: string) => string;
} {
  const n = data.length;
  if (n === 0) return { indices: [], fmt: (d) => d };

  let stride: number;
  let fmt: (d: string) => string;

  // ISO `YYYY-MM-DD` strings are anchored to noon UTC for tick formatting,
  // not midnight UTC. Using midnight + NY format would render every
  // bucket as the previous calendar day in NY (UTC midnight = NY 19-20:00
  // of previous day), which matches the user's screenshot complaint but
  // is wrong for every bucket EXCEPT the rightmost one. Anchoring at
  // noon UTC (= NY 07-08:00 of the SAME day) keeps the date correct for
  // every bucket — and the timeseries is already filtered above to drop
  // any bucket with `day` > NY today, so the rightmost tick is correct
  // by construction.
  const _toNY = (iso: string) => new Date(iso + "T12:00:00Z");

  if (windowDays <= 7) {
    // Daily ticks. "Mon 21" style reads naturally for a week view.
    stride = 1;
    fmt = (iso) => {
      const d = _toNY(iso);
      return `${_NY_TICK_WEEKDAY_FMT.format(d)} ${_NY_TICK_DAY_NUM_FMT.format(d)}`;
    };
  } else if (windowDays <= 30) {
    // Every ~5 days. Classic month view, MM-DD format anchored to NY.
    stride = Math.max(1, Math.ceil(n / 6));
    fmt = (iso) => _NY_TICK_MD_FMT.format(_toNY(iso));
  } else if (windowDays <= 90) {
    // Weekly ticks.
    stride = 7;
    fmt = (iso) => {
      const d = _toNY(iso);
      return `${_NY_TICK_MONTH_FMT.format(d)} ${_NY_TICK_DAY_NUM_FMT.format(d)}`;
    };
  } else {
    // Year view — monthly ticks.
    stride = 30;
    fmt = (iso) => _NY_TICK_MONTH_FMT.format(_toNY(iso));
  }

  const indices: number[] = [];
  for (let i = 0; i < n; i += stride) indices.push(i);
  // Always include the final point so "today" shows up with a tick.
  if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);
  return { indices, fmt };
}

function LineChart({ data, windowDays }: { data: TimeSeriesPoint[]; windowDays: number }) {
  const W = 800;
  const H = 260;
  const P = { top: 16, right: 20, bottom: 28, left: 40 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;

  // Y-axis ceiling — auto-scale with nice numbers (see niceAxisMax).
  // Fills the plot area tightly so small counts (1-3 range) don't float
  // in a chart whose top is stuck at 10.
  const max = useMemo(() => {
    const m = Math.max(
      1,
      ...data.flatMap(d => [
        d.quick_search_count, d.deep_search_count, d.synthesis_count, d.deep_read_count,
      ]),
    );
    return niceAxisMax(m);
  }, [data]);

  // Y-axis tick labels — prefer 4 evenly-spaced labels for an integer max,
  // but if max is 1 or 2, only show 2/3 labels so we don't render
  // duplicate "0 / 0 / 1 / 1" ticks from rounding.
  const yTickFractions = useMemo(() => {
    if (max <= 2) return [0, 1];                           // 0, max
    if (max <= 4) return [0, 0.5, 1];                       // 0, half, max
    return [0, 0.25, 0.5, 0.75, 1];                         // standard quartile ticks
  }, [max]);

  const n = data.length;
  const stepX = n > 1 ? innerW / (n - 1) : innerW;

  const pathFor = (accessor: (p: TimeSeriesPoint) => number) =>
    data.map((p, i) => {
      const x = P.left + i * stepX;
      const y = P.top + innerH - (accessor(p) / max) * innerH;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");

  const series = [
    { key: "quick",  color: "#3b82f6", accessor: (p: TimeSeriesPoint) => p.quick_search_count },
    { key: "deep",   color: "#8b5cf6", accessor: (p: TimeSeriesPoint) => p.deep_search_count  },
    { key: "synth",  color: "#ec4899", accessor: (p: TimeSeriesPoint) => p.synthesis_count    },
    { key: "read",   color: "#10b981", accessor: (p: TimeSeriesPoint) => p.deep_read_count    },
  ];

  // X-axis ticks: indices to render + the format per index. See pickXTicks.
  const { indices: xTickIndices, fmt: xFmt } = useMemo(
    () => pickXTicks(data, windowDays),
    [data, windowDays],
  );
  const xTickSet = useMemo(() => new Set(xTickIndices), [xTickIndices]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-64" aria-label="Usage time series">
      {/* Grid — stroke uses --ats-border-subtle so axes dim on dark themes
          but pop on the day-mint default. Y ticks adapt to `max` so
          small-integer charts (max=1) don't render 4 duplicate 0 labels. */}
      {yTickFractions.map((frac, i) => {
        const y = P.top + innerH * (1 - frac);
        return (
          <g key={i}>
            <line x1={P.left} x2={P.left + innerW} y1={y} y2={y}
                  stroke="var(--ats-border-subtle)" strokeWidth={1} strokeDasharray="2 3" opacity={0.7} />
            <text x={P.left - 5} y={y + 3} textAnchor="end"
                  fontSize={9} fill="var(--ats-fg-muted)" fontFamily="inherit">
              {Math.round(max * frac)}
            </text>
          </g>
        );
      })}
      {/* X ticks — density + format are chosen by pickXTicks() based on
          the selected window length. */}
      {data.map((d, i) => {
        if (!xTickSet.has(i)) return null;
        const x = P.left + i * stepX;
        return (
          <text key={d.day} x={x} y={H - 10} textAnchor="middle" fontSize={9} fill="var(--ats-fg-muted)">
            {xFmt(d.day)}
          </text>
        );
      })}
      {/* Series */}
      {series.map(s => (
        <path key={s.key} d={pathFor(s.accessor)}
              stroke={s.color} strokeWidth={1.8} fill="none"
              strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {/* Dots on the last point so "now" is obvious */}
      {series.map(s => {
        const last = data[n - 1];
        if (!last) return null;
        const x = P.left + (n - 1) * stepX;
        const y = P.top + innerH - (s.accessor(last) / max) * innerH;
        return <circle key={`dot-${s.key}`} cx={x} cy={y} r={2.5} fill={s.color} />;
      })}
    </svg>
  );
}

// ── Time-range toggle (used next to Charts header) ─────────────────────────
function TimeRangeToggle({ value, onChange }: { value: 7 | 30 | 90 | 365; onChange: (v: 7 | 30 | 90 | 365) => void }) {
  const options: Array<{ v: 7 | 30 | 90 | 365; label: string }> = [
    { v: 7,   label: "7d"  },
    { v: 30,  label: "30d" },
    { v: 90,  label: "90d" },
    { v: 365, label: "1y"  },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Chart time range"
      className="inline-flex items-center rounded-md border p-0.5 text-[10px] font-bold tracking-wide select-none"
      style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}
    >
      {options.map(opt => {
        const active = value === opt.v;
        return (
          <button
            key={opt.v}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.v)}
            className="rounded-sm px-2 py-0.5 transition-colors"
            style={active ? {
              backgroundColor: "var(--ats-bg-accent-soft)",
              color:           "var(--ats-fg-accent)",
            } : {
              color: "var(--ats-fg-muted)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function TimeseriesLegend() {
  const items = [
    { color: "#3b82f6", label: "Quick search" },
    { color: "#8b5cf6", label: "Deep search" },
    { color: "#ec4899", label: "Synthesis" },
    { color: "#10b981", label: "Evidence chain" },
  ];
  return (
    <div className="flex items-center gap-3 text-[10px]" style={{ color: "var(--ats-fg-secondary)" }}>
      {items.map(i => (
        <span key={i.label} className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ── Donut chart (users by tier) ─────────────────────────────────────────────

function DonutChart({ slices, total }: {
  slices: { label: string; value: number; color: string }[];
  total: number;
}) {
  const cx = 100, cy = 100, r = 70, inner = 48;
  const nonZero = slices.filter(s => s.value > 0);
  let acc = 0;
  const paths = nonZero.map(s => {
    const frac = total > 0 ? s.value / total : 0;
    const start = acc;
    acc += frac;
    return arcPath(cx, cy, r, inner, start, acc, s.color);
  });
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 200 200" className="w-40 h-40 shrink-0" aria-label="Users by tier">
        {total === 0 ? (
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--ats-border-subtle)" strokeWidth={inner / 2} opacity={0.4} />
        ) : paths}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize={22} fontWeight={700} fill="var(--ats-fg-primary)">
          {total}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize={10} fill="var(--ats-fg-muted)">
          total users
        </text>
      </svg>
      <div className="min-w-0 flex-1 space-y-1.5">
        {slices.map(s => {
          const frac = total > 0 ? (s.value / total) * 100 : 0;
          return (
            <div key={s.label} className="flex items-center gap-2 text-[11px]">
              <span className="w-2.5 h-2.5 rounded shrink-0" style={{ backgroundColor: s.color }} />
              <span className="font-semibold uppercase tracking-wide w-16 shrink-0" style={{ color: "var(--ats-fg-secondary)" }}>
                {s.label}
              </span>
              <span className="tabular-nums font-bold" style={{ color: "var(--ats-fg-primary)" }}>{s.value}</span>
              <span className="tabular-nums" style={{ color: "var(--ats-fg-muted)" }}>({frac.toFixed(1)}%)</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function arcPath(cx: number, cy: number, outer: number, inner: number, startFrac: number, endFrac: number, color: string) {
  const TAU = Math.PI * 2;
  const a0 = startFrac * TAU - Math.PI / 2;
  const a1 = endFrac   * TAU - Math.PI / 2;
  const large = endFrac - startFrac > 0.5 ? 1 : 0;
  const x0o = cx + outer * Math.cos(a0);
  const y0o = cy + outer * Math.sin(a0);
  const x1o = cx + outer * Math.cos(a1);
  const y1o = cy + outer * Math.sin(a1);
  const x0i = cx + inner * Math.cos(a1);
  const y0i = cy + inner * Math.sin(a1);
  const x1i = cx + inner * Math.cos(a0);
  const y1i = cy + inner * Math.sin(a0);
  const d = [
    `M ${x0o} ${y0o}`,
    `A ${outer} ${outer} 0 ${large} 1 ${x1o} ${y1o}`,
    `L ${x0i} ${y0i}`,
    `A ${inner} ${inner} 0 ${large} 0 ${x1i} ${y1i}`,
    "Z",
  ].join(" ");
  // Slice outline uses the page's base background so wedges visually
  // separate on both dark and light themes without hardcoding navy.
  return <path key={`${startFrac}-${color}`} d={d} fill={color} opacity={0.92} stroke="var(--ats-bg-base)" strokeWidth={1} />;
}

// ── User table ──────────────────────────────────────────────────────────────

function UserTable({ users, onOpenDrawer }: { users: AdminUser[]; onOpenDrawer: (u: AdminUser) => void }) {
  if (users.length === 0) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No users yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr
            className="text-left text-[10px] uppercase tracking-wider border-b"
            style={{ color: "var(--ats-fg-muted)", borderColor: "var(--ats-border-subtle)" }}
          >
            <th className="pb-2 pr-3 font-semibold">Email</th>
            <th className="pb-2 pr-3 font-semibold">Tier</th>
            <th className="pb-2 pr-3 font-semibold">Status</th>
            {/* Each numeric column displays the SUM across the operator-
                selected window for that user (today / 7d / 30d / all),
                so we suffix every header with "(Total)" — without it,
                "Quick" reads ambiguously as "the most recent quick
                search" or "a daily count". The tfoot below tallies
                these per-column. */}
            <th className="pb-2 pr-3 font-semibold text-right" title="Total Quick searches in the selected window">Quick (Total)</th>
            <th className="pb-2 pr-3 font-semibold text-right" title="Total Deep searches in the selected window">Deep (Total)</th>
            <th className="pb-2 pr-3 font-semibold text-right" title="Total Synthesis Lab runs in the selected window">Synth (Total)</th>
            <th className="pb-2 pr-3 font-semibold text-right" title="Total Evidence Chain reports in the selected window">Chain (Total)</th>
            <th className="pb-2 pr-3 font-semibold text-right" title="Total LLM cost in USD over the selected window">Cost USD (Total)</th>
            <th className="pb-2 pr-3 font-semibold">Last active</th>
            <th className="pb-2 pr-3 font-semibold">First seen</th>
            <th className="pb-2 pr-3 font-semibold">Tier changed</th>
            <th className="pb-2 font-semibold text-right">Actions</th>
          </tr>
        </thead>
        <tbody style={{ color: "var(--ats-fg-primary)" }}>
          {users.map(u => {
            const bonusTotal = (u.bonus?.quick_search ?? 0) + (u.bonus?.deep_search ?? 0) + (u.bonus?.synthesis ?? 0) + (u.bonus?.deep_read ?? 0);
            return (
              <tr
                key={u.id}
                className="border-b transition-colors hover:bg-[var(--ats-bg-accent-soft)]"
                style={{
                  borderColor: "var(--ats-border-subtle)",
                  // Banned rows get a faint red tint so they jump out even
                  // before reading the Status pill.
                  backgroundColor: u.is_banned ? "rgba(239, 68, 68, 0.04)" : undefined,
                }}
              >
                <td className="py-1.5 pr-3 truncate max-w-[220px]" title={u.email ?? (u.is_anonymous ? `Session ${u.id}` : "")}>
                  {u.email
                    ? u.email
                    : u.is_anonymous
                      ? <span className="font-mono text-[11px]" style={{ color: "var(--ats-fg-secondary)" }}>
                          Session: {u.id.slice(0, 8)}…{u.id.slice(-4)}
                        </span>
                      : <span className="italic" style={{ color: "var(--ats-fg-muted)" }}>(no email)</span>}
                </td>
                <td className="py-1.5 pr-3">
                  <span
                    className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide"
                    style={{
                      color: TIER_COLORS[u.tier] ?? "#64748b",
                      backgroundColor: (TIER_COLORS[u.tier] ?? "#64748b") + "22",
                      borderColor:     (TIER_COLORS[u.tier] ?? "#64748b") + "55",
                      borderWidth: 1, borderStyle: "solid",
                    }}
                  >
                    {u.tier}
                  </span>
                </td>
                <td className="py-1.5 pr-3">
                  {u.is_banned ? (
                    <span
                      title={u.ban_reason || "Banned (no reason given)"}
                      className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide"
                      style={{
                        color: "#ef4444",
                        backgroundColor: "rgba(239, 68, 68, 0.12)",
                        borderColor:     "rgba(239, 68, 68, 0.55)",
                        borderWidth: 1, borderStyle: "solid",
                      }}
                    >
                      🚫 Banned
                    </span>
                  ) : bonusTotal > 0 ? (
                    <span
                      title={`Bonus quota gifted: +${u.bonus?.quick_search} quick · +${u.bonus?.deep_search} deep · +${u.bonus?.synthesis} synth · +${u.bonus?.deep_read} reads`}
                      className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide"
                      style={{
                        color: "#10b981",
                        backgroundColor: "rgba(16, 185, 129, 0.12)",
                        borderColor:     "rgba(16, 185, 129, 0.55)",
                        borderWidth: 1, borderStyle: "solid",
                      }}
                    >
                      🎁 +{bonusTotal}
                    </span>
                  ) : (
                    <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>—</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{(u.window ?? u.today).quick_search_count}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{(u.window ?? u.today).deep_search_count}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{(u.window ?? u.today).synthesis_count}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{(u.window ?? u.today).deep_read_count}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: "var(--ats-fg-secondary)" }}>
                  {(u.window ?? u.today).llm_cost_usd.toFixed(4)}
                </td>
                {/* Last active — colour-codes recency so admins can tell
                    "still engaged" vs "signed up and vanished" at a glance.
                    Green <24h, blue <7d, amber <30d, muted older. */}
                {(() => {
                  const la = u.last_active_at;
                  if (!la) {
                    return (
                      <td className="py-1.5 pr-3" style={{ color: "var(--ats-fg-muted)" }}>
                        <span className="italic text-[10px]">never</span>
                      </td>
                    );
                  }
                  const ageMs = Date.now() - new Date(la).getTime();
                  const day   = 24 * 3600 * 1000;
                  const color = ageMs < day ? "#10b981" : ageMs < 7 * day ? "#3b82f6" : ageMs < 30 * day ? "#f59e0b" : "var(--ats-fg-muted)";
                  return (
                    <td className="py-1.5 pr-3 tabular-nums" style={{ color }} title={la}>
                      {fmtDate(la)}
                    </td>
                  );
                })()}
                <td className="py-1.5 pr-3" style={{ color: "var(--ats-fg-secondary)" }} title={u.first_seen_at ?? ""}>
                  {fmtDate(u.first_seen_at)}
                </td>
                <td className="py-1.5 pr-3" style={{ color: "var(--ats-fg-muted)" }}>
                  {fmtDate(u.tier_updated_at)}
                </td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={() => onOpenDrawer(u)}
                    className="text-[10px] font-semibold rounded border px-2 py-1 transition-colors"
                    style={{
                      borderColor: "var(--ats-border-subtle)",
                      color:       "var(--ats-fg-secondary)",
                    }}
                    title="Ban / unban · gift quota · change tier · view activity"
                  >
                    Manage
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        {/* Totals row — sums every visible user's window counters so an
            operator can read aggregate volume / cost at a glance without
            mental arithmetic. The values respect whatever filter +
            window the operator picked above (the table receives the
            already-filtered list), so the totals always describe the
            visible roster, never the hidden one. Bonus quota isn't
            summed here because the bonus values are PER-USER additive
            grants, not throughput, and adding them would invite a
            "why is the bonus column also tallying?" mis-read. */}
        {(() => {
          const totals = users.reduce((acc, u) => {
            const w = u.window ?? u.today;
            acc.quick += w.quick_search_count;
            acc.deep  += w.deep_search_count;
            acc.synth += w.synthesis_count;
            acc.chain += w.deep_read_count;
            acc.cost  += w.llm_cost_usd;
            return acc;
          }, { quick: 0, deep: 0, synth: 0, chain: 0, cost: 0 });
          return (
            <tfoot>
              <tr
                className="text-[10px] uppercase tracking-wider border-t"
                style={{ color: "var(--ats-fg-secondary)", borderColor: "var(--ats-border-subtle)" }}
              >
                <td className="pt-2 pr-3 font-bold" colSpan={3}>
                  Totals · {users.length} user{users.length === 1 ? "" : "s"}
                </td>
                <td className="pt-2 pr-3 text-right font-bold tabular-nums">{totals.quick}</td>
                <td className="pt-2 pr-3 text-right font-bold tabular-nums">{totals.deep}</td>
                <td className="pt-2 pr-3 text-right font-bold tabular-nums">{totals.synth}</td>
                <td className="pt-2 pr-3 text-right font-bold tabular-nums">{totals.chain}</td>
                <td className="pt-2 pr-3 text-right font-bold tabular-nums">{totals.cost.toFixed(4)}</td>
                <td className="pt-2 pr-3" colSpan={4} />
              </tr>
            </tfoot>
          );
        })()}
      </table>
    </div>
  );
}

// ── Activity feed ─────────────────────────────────────────────────────────
// Reverse-chronological list of user actions, each row one entry from
// history_entries. Colour-codes the action type for fast scanning
// (search=blue, synthesis=purple, deep_read=emerald, other=grey).

function ActivityFeed({ rows }: { rows: ActivityEntry[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-4 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No activity yet. Rows appear here as soon as a signed-in user runs a search / synthesis / evidence-chain action.
      </div>
    );
  }
  const ACTION_COLOR: Record<string, string> = {
    search:          "#3b82f6",
    synthesis:       "#8b5cf6",
    deep_read:       "#10b981",
    evidence_chain:  "#10b981",
  };
  // Display-label map — keeps backend action keys stable (the DB column
  // and quota gateway still reference `deep_read`) while presenting the
  // renamed feature name in the UI.
  const ACTION_LABEL: Record<string, string> = {
    search:          "SEARCH",
    quick_search:    "QUICK SEARCH",
    deep_search:     "DEEP SEARCH",
    synthesis:       "SYNTHESIS",
    deep_read:       "EVIDENCE CHAIN",
    evidence_chain:  "EVIDENCE CHAIN",
  };
  // No own scroll container — the parent at the call site already wraps
  // this in `max-h-[420px] overflow-y-auto thin-scrollbar`. Stacking two
  // overflow-y-auto containers (inner max-h-96 = 528 px at 22 px root,
  // outer max-h-[420px]) made BOTH render their own scrollbar once the
  // feed grew past ~420 px (the user-reported "双 scrollbar"). Keeping
  // a single scroller — the parent's — is the bug-free path. If a
  // future caller wants to use ActivityFeed without an outer max-h,
  // they should add their OWN overflow wrapper at the call site rather
  // than pushing it back inside the component.
  return (
    <div className="space-y-1">
      {rows.map(r => {
        const color = ACTION_COLOR[r.action] ?? "#64748b";
        const label = ACTION_LABEL[r.action] ?? r.action.replace(/_/g, " ").toUpperCase();
        return (
          <div
            key={r.id}
            className="rounded-md border p-2 flex items-start gap-2"
            style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-base)" }}
          >
            <span
              className="shrink-0 mt-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border"
              style={{
                color,
                backgroundColor: color + "1a",
                borderColor:     color + "55",
              }}
            >
              {label}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-semibold truncate" style={{ color: "var(--ats-fg-primary)" }}>
                  {r.email || <em style={{ color: "var(--ats-fg-muted)" }}>(no email)</em>}
                </span>
                <span className="text-[10px] shrink-0" style={{ color: "var(--ats-fg-muted)" }}>
                  {fmtDateTime(r.created_at)}
                </span>
              </div>
              {r.query && (
                <p className="text-[11px] truncate" style={{ color: "var(--ats-fg-secondary)" }}>
                  {r.query}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}


// ── Announcement log ────────────────────────────────────────────────────────

function AnnouncementLog({
  rows, onDelete, onEdit,
}: {
  rows: AdminAnnouncement[];
  onDelete?: (id: string) => void | Promise<void>;
  onEdit?: (id: string, newText: string) => void | Promise<void>;
}) {
  // Track which row is currently being edited + the draft text. Only
  // one row can be in edit mode at a time; opening another edit cancels
  // the current draft. Keeping this as a single string (id | null) is
  // simpler than a Map and matches the "edit one thing at a time" UX.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState<string>("");

  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No announcements yet.
      </div>
    );
  }

  const startEdit = (a: AdminAnnouncement) => {
    setEditingId(a.id);
    setDraft(a.text);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };
  const saveEdit = async () => {
    if (!editingId || !onEdit) return;
    await onEdit(editingId, draft);
    cancelEdit();
  };

  return (
    <div className="max-h-96 overflow-y-auto thin-scrollbar pr-1 space-y-1.5">
      {rows.map(a => {
        const isSeed = a.author_email === "dev@academicats.com";
        const isEditing = editingId === a.id;
        return (
          <div
            key={a.id}
            className="rounded-md border p-2 relative"
            style={{ borderColor: isEditing ? "var(--ats-border-accent)" : "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-base)" }}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span
                className="text-[10px] font-semibold"
                style={{ color: isSeed ? "#d97706" : "var(--ats-fg-accent)" }}
              >
                {isSeed ? "SEED" : (a.author_email || "NAMELESS CAT")}
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  {fmtDateTime(a.created_at)}
                </span>
                {/* Per-row action buttons — ALWAYS visible (previously
                    hover-only, which users reported was hard to find).
                    Edit works on every row (dev-gated on the backend
                    anyway); most common use is trimming a seed message
                    without re-seeding or removing spam inline. */}
                {onEdit && !isEditing && (
                  <button
                    onClick={() => startEdit(a)}
                    title="Edit this announcement's text"
                    className="text-[10px] rounded border px-1 leading-4 transition-colors"
                    style={{ color: "var(--ats-fg-accent)", borderColor: "var(--ats-border-accent)" }}
                  >
                    ✎ Edit
                  </button>
                )}
                {onDelete && !isEditing && (
                  <button
                    onClick={() => onDelete(a.id)}
                    title="Delete this announcement"
                    className="text-[10px] rounded border px-1 leading-4 transition-colors"
                    style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.45)" }}
                  >
                    ❌
                  </button>
                )}
              </div>
            </div>
            {isEditing ? (
              <div className="space-y-1.5">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  maxLength={280}
                  autoFocus
                  className="w-full rounded-md border px-2 py-1.5 text-[11px] resize-none outline-none focus:border-blue-500/50"
                  style={{
                    backgroundColor: "var(--ats-bg-panel)",
                    borderColor:     "var(--ats-border-subtle)",
                    color:           "var(--ats-fg-primary)",
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                    {draft.length}/280
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={cancelEdit}
                      className="text-[10px] rounded border px-2 py-0.5"
                      style={{ color: "var(--ats-fg-muted)", borderColor: "var(--ats-border-subtle)" }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void saveEdit()}
                      disabled={draft.trim().length < 3 || draft === a.text}
                      className="text-[10px] font-bold rounded border px-2 py-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{
                        color:           "var(--ats-fg-accent)",
                        borderColor:     "var(--ats-border-accent)",
                        backgroundColor: "var(--ats-bg-accent-soft)",
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed break-words" style={{ color: "var(--ats-fg-secondary)" }}>
                {a.text}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── System snapshot side panel ──────────────────────────────────────────────

function SystemSnapshot({ overview }: { overview: Overview | null }) {
  const rows: { icon: React.ReactNode; label: string; value: string | number }[] = [
    { icon: <Users     size={12} />, label: "Total profiles",        value: overview?.users.total ?? "—" },
    { icon: <Activity  size={12} />, label: "Active today",          value: overview?.today.active_users ?? "—" },
    { icon: <MessageSquare size={12} />, label: "Conversations",     value: overview?.conversations ?? "—" },
    { icon: <Database  size={12} />, label: "History entries",       value: overview?.history_entries ?? "—" },
    { icon: <FileText  size={12} />, label: "Announcements stored",  value: overview?.announcements_total ?? "—" },
    { icon: <DollarSign size={12} />, label: "Today's LLM cost",     value: overview ? `$${overview.today.llm_cost_usd.toFixed(4)}` : "—" },
    { icon: <Clock     size={12} />, label: "Server time (NY)",      value: overview ? fmtDateTime(overview.server_time) : "—" },
    { icon: <Clock     size={12} />, label: "Day bucket",            value: overview?.today.day_utc ?? "—" },
  ];
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div
          key={i}
          className="flex items-center justify-between py-1.5 border-b last:border-0"
          style={{ borderColor: "var(--ats-border-subtle)" }}
        >
          <span className="inline-flex items-center gap-2 text-[11px]" style={{ color: "var(--ats-fg-secondary)" }}>
            <span style={{ color: "var(--ats-fg-muted)" }}>{r.icon}</span>
            {r.label}
          </span>
          <span className="text-xs font-bold tabular-nums" style={{ color: "var(--ats-fg-primary)" }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── DB stats panel ─────────────────────────────────────────────────────────
// Row counts per table + a progress bar against the 500 MB Supabase free-tier
// ceiling. The byte estimate is rough (rows × avg_row_size) — the goal is
// "is the tank 20% or 90% full", not byte-exact accuracy.

function DbStatsPanel({ data }: { data: DbStats | null }) {
  if (!data) {
    return <div className="text-xs italic py-4 text-center" style={{ color: "var(--ats-fg-muted)" }}>Loading…</div>;
  }
  const pctFull = Math.min(100, Math.round((data.estimated_bytes / data.free_tier_limit_bytes) * 100));
  const barColor =
    pctFull >= 80 ? "#ef4444" :
    pctFull >= 50 ? "#f59e0b" :
                    "#10b981";
  const tables = [...data.tables].sort((a, b) => b.rows - a.rows);
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[11px]" style={{ color: "var(--ats-fg-secondary)" }}>
            Estimated: <strong style={{ color: "var(--ats-fg-primary)" }}>{fmtBytes(data.estimated_bytes)}</strong>
            {" / "}{fmtBytes(data.free_tier_limit_bytes)}
          </span>
          <span className="text-xs font-bold tabular-nums" style={{ color: barColor }}>
            {pctFull}%
          </span>
        </div>
        <div className="h-2 w-full rounded-full overflow-hidden" style={{ backgroundColor: "var(--ats-border-subtle)" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pctFull}%`, backgroundColor: barColor }} />
        </div>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider border-b" style={{ color: "var(--ats-fg-muted)", borderColor: "var(--ats-border-subtle)" }}>
            <th className="pb-1.5 pr-3 font-semibold">Table</th>
            <th className="pb-1.5 font-semibold text-right">Rows</th>
          </tr>
        </thead>
        <tbody style={{ color: "var(--ats-fg-primary)" }}>
          {tables.map(t => {
            // rows < 0 means the COUNT query failed — most likely the
            // table hasn't been migrated into this Supabase project yet.
            // Show an explicit warning instead of the old "?" which was
            // ambiguous ("is it 0 rows, or broken?"). This is especially
            // important for user_usage_daily — a missing migration
            // there silently zeroes out every KPI on the dashboard.
            const missing = t.rows < 0;
            return (
              <tr key={t.name} className="border-b" style={{ borderColor: "var(--ats-border-subtle)" }}>
                <td className="py-1 pr-3 font-mono text-[11px]">
                  {t.name}
                  {missing && (
                    <span
                      className="ml-2 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide rounded border px-1 py-0.5"
                      style={{ color: "#f59e0b", backgroundColor: "#f59e0b1a", borderColor: "#f59e0b55" }}
                      title="COUNT query failed — table likely missing from Supabase. Run the schema migration."
                    >
                      ⚠ not found
                    </span>
                  )}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {missing ? <span style={{ color: "var(--ats-fg-muted)" }}>—</span> : t.rows.toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {tables.some(t => t.rows < 0) && (
        <p className="text-[10px] font-semibold mt-2" style={{ color: "#f59e0b" }}>
          ⚠ One or more tables are missing from Supabase — run the schema migration in supabase_schema.sql.
          Tables marked &ldquo;not found&rdquo; above silently kill any admin KPI that sources from them
          (e.g. missing <code>user_usage_daily</code> zeroes out Active today / Searches today / Cost today).
        </p>
      )}
      {pctFull >= 80 && (
        <p className="text-[10px] font-semibold mt-2" style={{ color: "#ef4444" }}>
          ⚠ Storage above 80%. Upgrade Supabase Pro ($25/mo → 8 GB) or enable history-entry TTL.
        </p>
      )}
    </div>
  );
}

// ── System health panel ───────────────────────────────────────────────────
// Redis status, worker count, LLM key pool breakdown. Replaces flipping
// between Railway logs + Upstash dashboard during dev/support.

function SystemHealthPanel({ data }: { data: SystemHealth | null }) {
  if (!data) {
    return <div className="text-xs italic py-4 text-center" style={{ color: "var(--ats-fg-muted)" }}>Loading…</div>;
  }
  const redisGood = data.redis.configured;
  const pool = data.key_pool ?? {};

  // Filter out the reserved "error" key (backend uses it to report a
  // gateway-level failure) — we render its message separately so it
  // doesn't collide with the per-provider rows.
  const poolError    = (pool as { error?: string }).error;
  const providers    = Object.entries(pool).filter(([k]) => k !== "error");

  // Aggregate per-provider counts so the display is "anthropic · 1 key
  // · 0 errors" rather than the raw JSON blob it was showing before.
  const summarise = (info: KeyPoolEntry[] | { error?: string } | unknown) => {
    if (!Array.isArray(info)) return null;
    const keys = info as KeyPoolEntry[];
    const available = keys.filter(k => k.status === "available").length;
    const disabled  = keys.length - available;
    const errors    = keys.reduce((s, k) => s + (typeof k.errors === "number" ? k.errors : 0), 0);
    return { total: keys.length, available, disabled, errors };
  };

  // Live capacity signals — active SSE streams + last-60s LLM rate.
  // The SSE gauge is the single best proxy for "is the server saturated
  // right now?" since each stream is a long-held connection. The LLM
  // rate gauge shows OpenAI RPM / TPM consumption so ops can see a
  // tier-limit approach BEFORE the 429s start landing.
  const cap = data.capacity;
  const sse = cap?.sse;
  const llm = cap?.llm_last_60s;
  const headroom = data.openai_headroom;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg border p-2" style={{ borderColor: "var(--ats-border-subtle)" }}>
          <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--ats-fg-muted)" }}>Redis</p>
          <p className="font-bold" style={{ color: redisGood ? "#10b981" : "#f59e0b" }}>
            {redisGood ? "Connected" : "In-memory fallback"}
          </p>
          <p className="text-[10px] leading-snug" style={{ color: "var(--ats-fg-muted)" }}>
            {data.redis.reason ?? data.redis.backend}
          </p>
        </div>
        <div className="rounded-lg border p-2" style={{ borderColor: "var(--ats-border-subtle)" }}>
          <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--ats-fg-muted)" }}>Workers</p>
          <p className="font-bold tabular-nums" style={{ color: "var(--ats-fg-primary)" }}>{data.workers}</p>
          <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>uvicorn procs</p>
        </div>
      </div>

      {/* Capacity row — 2-up grid: Active SSE streams | Past-60s LLM rate.
          Only renders if the backend returned the capacity dict (old
          deploys without capacity.py get a graceful empty render). */}
      {cap && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border p-2" style={{ borderColor: "var(--ats-border-subtle)" }}>
            <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--ats-fg-muted)" }}>Active SSE streams</p>
            <p className="font-bold tabular-nums" style={{
              color: (sse?.active ?? 0) >= 20 ? "#ef4444" : (sse?.active ?? 0) >= 10 ? "#f59e0b" : "#10b981",
            }}>
              {sse?.active ?? 0}
            </p>
            <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
              peak {sse?.peak_since_boot ?? 0} since boot
            </p>
          </div>
          <div className="rounded-lg border p-2" style={{ borderColor: "var(--ats-border-subtle)" }}>
            <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--ats-fg-muted)" }}>LLM (last 60s)</p>
            <p className="font-bold tabular-nums" style={{ color: "var(--ats-fg-primary)" }}>
              {llm?.rpm ?? 0} <span className="text-[10px] font-normal" style={{ color: "var(--ats-fg-muted)" }}>req/min</span>
            </p>
            <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
              {((llm?.tpm_in ?? 0) + (llm?.tpm_out ?? 0)).toLocaleString()} tok · ${(llm?.cost_window_usd ?? 0).toFixed(4)}
              {(llm?.errors ?? 0) > 0 && <span className="ml-1" style={{ color: "#ef4444" }}>· {llm?.errors} err</span>}
            </p>
          </div>
        </div>
      )}

      {/* OpenAI headroom — compares current RPM/TPM against a tier cap
          so ops can see "we're at 35% of Tier-1 RPM" at a glance.
          Colour of the bar ladders green → amber → red so a glance at
          the panel tells you whether to consider upgrading tiers.
          The banner ABOVE the bars appears when either axis crosses
          60% — this is the "lead time" threshold: if you see it, you
          still have a few minutes to upgrade before 429s start landing. */}
      {headroom && (
        <div className="rounded-lg border p-2" style={{ borderColor: "var(--ats-border-subtle)" }}>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--ats-fg-muted)" }}>
              OpenAI headroom vs {headroom.tier.toUpperCase()}
            </p>
            <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
              caps: {headroom.caps.rpm.toLocaleString()} RPM · {headroom.caps.tpm.toLocaleString()} TPM
            </span>
          </div>
          {(() => {
            // Decide whether to show the warning banner based on the
            // HIGHER of RPM / TPM percentage. Two-tier threshold so the
            // message escalates: 60%+ = "watch", 85%+ = "act now".
            const hotPct = Math.max(headroom.pct.rpm, headroom.pct.tpm);
            const axis   = headroom.pct.rpm > headroom.pct.tpm ? "RPM" : "TPM";
            if (hotPct >= 85) {
              return (
                <div
                  className="rounded-md border px-2 py-1.5 mb-2 flex items-start gap-2"
                  style={{ borderColor: "rgba(239,68,68,0.5)", backgroundColor: "rgba(239,68,68,0.12)" }}
                >
                  <span aria-hidden className="text-sm">🚨</span>
                  <div className="flex-1 text-[10px] leading-snug">
                    <p className="font-bold" style={{ color: "#ef4444" }}>
                      {axis} at {hotPct.toFixed(0)}% of {headroom.tier.toUpperCase()} cap — 429s imminent
                    </p>
                    <p style={{ color: "#fca5a5" }}>
                      Upgrade OpenAI tier now. Users will start seeing "rate limit reached" errors within the next minute at this rate.
                    </p>
                  </div>
                </div>
              );
            }
            if (hotPct >= 60) {
              return (
                <div
                  className="rounded-md border px-2 py-1.5 mb-2 flex items-start gap-2"
                  style={{ borderColor: "rgba(245,158,11,0.5)", backgroundColor: "rgba(245,158,11,0.10)" }}
                >
                  <span aria-hidden className="text-sm">⚠️</span>
                  <div className="flex-1 text-[10px] leading-snug">
                    <p className="font-bold" style={{ color: "#f59e0b" }}>
                      {axis} at {hotPct.toFixed(0)}% of {headroom.tier.toUpperCase()} cap — watch closely
                    </p>
                    <p style={{ color: "#fcd34d" }}>
                      If traffic keeps growing, consider pre-paying OpenAI to jump a tier before you hit the ceiling.
                    </p>
                  </div>
                </div>
              );
            }
            return null;
          })()}
          <HeadroomBar label="RPM" used={headroom.used.rpm} cap={headroom.caps.rpm} pct={headroom.pct.rpm} />
          <div className="h-1" />
          <HeadroomBar label="TPM" used={headroom.used.tpm} cap={headroom.caps.tpm} pct={headroom.pct.tpm} />
        </div>
      )}
      <div>
        <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--ats-fg-muted)" }}>LLM key pool</p>
        {poolError ? (
          <p className="text-xs" style={{ color: "#ef4444" }}>{poolError}</p>
        ) : providers.length === 0 ? (
          <p className="text-xs italic" style={{ color: "var(--ats-fg-muted)" }}>No key pool data available.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider border-b" style={{ color: "var(--ats-fg-muted)", borderColor: "var(--ats-border-subtle)" }}>
                <th className="pb-1.5 pr-3 font-semibold">Provider</th>
                <th className="pb-1.5 pr-3 font-semibold text-right">Keys</th>
                <th className="pb-1.5 pr-3 font-semibold text-right">Available</th>
                <th className="pb-1.5 pr-3 font-semibold text-right">Disabled</th>
                <th className="pb-1.5 font-semibold text-right">Errors</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--ats-fg-primary)" }}>
              {providers.map(([name, info]) => {
                const s = summarise(info);
                if (!s) {
                  return (
                    <tr key={name} className="border-b" style={{ borderColor: "var(--ats-border-subtle)" }}>
                      <td className="py-1 pr-3 font-semibold">{name}</td>
                      <td className="py-1 pr-3 text-right" colSpan={4} style={{ color: "var(--ats-fg-muted)" }}>
                        (no keys configured)
                      </td>
                    </tr>
                  );
                }
                const health = s.disabled > 0 || s.errors > 0
                  ? "#f59e0b" // amber — something's wrong
                  : s.available > 0
                    ? "#10b981" // emerald — healthy
                    : "var(--ats-fg-muted)";
                return (
                  <tr key={name} className="border-b" style={{ borderColor: "var(--ats-border-subtle)" }}>
                    <td className="py-1 pr-3 font-semibold flex items-center gap-1.5">
                      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: health }} />
                      {name}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{s.total}</td>
                    <td className="py-1 pr-3 text-right tabular-nums" style={{ color: s.available > 0 ? "#10b981" : "var(--ats-fg-muted)" }}>{s.available}</td>
                    <td className="py-1 pr-3 text-right tabular-nums" style={{ color: s.disabled > 0 ? "#f59e0b" : "var(--ats-fg-muted)" }}>{s.disabled}</td>
                    <td className="py-1 text-right tabular-nums" style={{ color: s.errors > 0 ? "#ef4444" : "var(--ats-fg-muted)" }}>{s.errors}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Cost alerts panel ─────────────────────────────────────────────────────

function CostAlertsPanel({ alerts }: { alerts: CostAlert[] }) {
  if (alerts.length === 0) {
    return (
      <div className="text-xs italic py-4 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        All users within their tier threshold today. ✓
      </div>
    );
  }
  return (
    <div className="space-y-1.5 max-h-80 overflow-y-auto thin-scrollbar pr-1">
      {alerts.map(a => (
        <div key={a.user_id} className="rounded-lg border p-2" style={{ borderColor: "#ef444455", backgroundColor: "#ef44441a" }}>
          <div className="flex items-baseline justify-between gap-2 mb-0.5">
            <span className="text-[11px] font-semibold truncate max-w-[240px]" style={{ color: "var(--ats-fg-primary)" }} title={a.email ?? ""}>
              {a.email ?? <em style={{ color: "var(--ats-fg-muted)" }}>(no email)</em>}
            </span>
            <span
              className="inline-flex text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide"
              style={{
                color:           TIER_COLORS[a.tier] ?? "#64748b",
                backgroundColor: (TIER_COLORS[a.tier] ?? "#64748b") + "22",
                borderColor:     (TIER_COLORS[a.tier] ?? "#64748b") + "55",
                borderWidth: 1, borderStyle: "solid",
              }}
            >
              {a.tier}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] tabular-nums">
            <span style={{ color: "#ef4444" }}>${a.cost_usd.toFixed(4)}</span>
            <span style={{ color: "var(--ats-fg-muted)" }}>/ limit ${a.threshold.toFixed(2)}</span>
            {a.ratio !== null && (
              <span style={{ color: "#ef4444" }}>
                {a.ratio.toFixed(1)}× over
              </span>
            )}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: "var(--ats-fg-muted)" }}>
            Q{a.counts.quick} · D{a.counts.deep} · S{a.counts.synth} · R{a.counts.reads}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Error log panel ───────────────────────────────────────────────────────

function ErrorLogPanel({ rows }: { rows: AdminError[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-4 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No errors logged. 🎉
      </div>
    );
  }
  return (
    <div className="space-y-1.5 max-h-80 overflow-y-auto thin-scrollbar pr-1">
      {rows.map(e => (
        <div key={e.id} className="rounded-md border p-2" style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-base)" }}>
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <div className="flex items-center gap-1.5">
              <span
                className="text-[9px] font-bold uppercase px-1 py-0.5 rounded border"
                style={{
                  color:           e.source === "frontend" ? "#8b5cf6" : "#ef4444",
                  backgroundColor: (e.source === "frontend" ? "#8b5cf6" : "#ef4444") + "1a",
                  borderColor:     (e.source === "frontend" ? "#8b5cf6" : "#ef4444") + "55",
                }}
              >
                {e.source}
              </span>
              {e.status_code && (
                <span className="text-[9px] font-mono" style={{ color: "var(--ats-fg-muted)" }}>
                  {e.method ? `${e.method} ` : ""}{e.status_code}
                </span>
              )}
              <span className="text-[11px] font-semibold truncate" style={{ color: "var(--ats-fg-primary)" }}>
                {e.error_name ?? "Error"}
              </span>
            </div>
            <span className="text-[9px] shrink-0" style={{ color: "var(--ats-fg-muted)" }}>
              {fmtDateTime(e.created_at)}
            </span>
          </div>
          {e.path && (
            <p className="text-[10px] font-mono truncate" style={{ color: "var(--ats-fg-secondary)" }}>{e.path}</p>
          )}
          {e.message && (
            <p className="text-[11px] mt-0.5 break-words" style={{ color: "var(--ats-fg-secondary)" }}>{e.message}</p>
          )}
          {e.user_email && (
            <p className="text-[9px] mt-0.5" style={{ color: "var(--ats-fg-muted)" }}>user: {e.user_email}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Tier limits editor ────────────────────────────────────────────────────
// Two-dimensional editor: rows = tiers, columns = features. Each cell is
// an <input type="number"> that starts with the effective value (code
// default OR override) and saves on blur / Enter. An "Unlimited" button
// per cell writes -1 → stored as NULL override = "explicitly unlimited".
// A "Reset" button deletes the override row so the cell falls back to
// the code default; visual indicator distinguishes overridden cells.

// Deferred-save tier limits editor. Edits accumulate in a LOCAL draft
// map; nothing hits the backend until the operator clicks the Save
// button. That gives explicit confirmation ("I know my change took
// effect") that auto-save-on-blur didn't — users couldn't tell whether
// typing a number actually persisted.
//
// Draft value semantics (mirror backend):
//   ""   → resets to code default (PATCH with limit_value=null deletes the override)
//   "0+" → explicit numeric cap
//   "-1" → reserved magic value meaning "unlimited" (stored as NULL override)
// ── ClientConfigEditor ───────────────────────────────────────────────────────
// Tiny panel for the runtime client-config knobs surfaced at
// /api/config/client + PATCH /api/admin/config/client. Currently the only
// knob is `workspace_char_limit` — a firm ceiling on the Workspace textarea
// length. Lower values protect the retrieval pipeline from prompt dilution;
// higher values let power users paste longer drafts.
//
// Self-fetches on mount and after every save so the panel always reflects
// what a new client session would receive. No tier-scoping today — this is
// a single global value.
function ClientConfigEditor() {
  const [limit, setLimit] = useState<number | "">("");
  const [saved, setSaved] = useState(0);          // increments on save → resets the value label flash
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const res = await fetch(buildApiUrl("/api/config/client"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { workspace_char_limit?: number };
      if (typeof data.workspace_char_limit === "number") setLimit(data.workspace_char_limit);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/config/client"), {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ workspace_char_limit: Math.round(limit) }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json() as { workspace_char_limit?: number };
      if (typeof data.workspace_char_limit === "number") setLimit(data.workspace_char_limit);
      setSaved(s => s + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [limit]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>Client config</h3>
          <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            Runtime knobs every frontend fetches on page load.
          </p>
        </div>
        {saved > 0 && (
          <span key={saved} className="text-[10px] text-emerald-500 font-semibold animate-pulse">Saved ✓</span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
          Workspace question length limit
        </label>
        <input
          type="number"
          min={100}
          max={10000}
          step={100}
          value={limit}
          onChange={e => {
            const v = e.target.value;
            setLimit(v === "" ? "" : Number(v));
          }}
          className="w-28 rounded border px-2 py-1 text-xs"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-primary)",
          }}
        />
        <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>characters (100–10,000)</span>
        <button
          onClick={() => void save()}
          disabled={busy || typeof limit !== "number"}
          className="rounded border px-2 py-1 text-xs font-semibold transition-colors disabled:opacity-50"
          style={{
            borderColor:     "var(--ats-border-accent)",
            backgroundColor: "var(--ats-bg-accent-soft)",
            color:           "var(--ats-fg-accent)",
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {err && <span className="text-[10px] text-rose-500">{err}</span>}
      </div>
      <p className="mt-1.5 text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
        Lowering this protects the retrieval pipeline from prompt dilution when users paste long drafts.
        Already-open sessions pick up the new cap on their next reload.
      </p>
    </div>
  );
}


// ── BroadcastComposer ────────────────────────────────────────────────────────
// Admin control for fanning ONE popup notification out to every user at once.
// Uses POST /api/admin/notifications/broadcast which writes one
// user_notifications row per profile — active users see the modal within
// ~20s via polling, offline users see it on their next sign-in.
//
// Safety-conscious: there's a visible "N users will receive this" preview,
// plus a confirm step, so no one broadcasts by accident. "Sent N / N"
// feedback stays visible for 6 s then resets.
function BroadcastComposer() {
  const [title, setTitle] = useState("");
  const [body,  setBody]  = useState("");
  const [emoji, setEmoji] = useState("📣");
  const [kind,  setKind]  = useState<"system" | "general">("system");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: number; total: number } | null>(null);
  const [err,    setErr]    = useState("");

  const canSend = (title.trim().length > 0 || body.trim().length > 0) && !busy;

  const send = async () => {
    setBusy(true);
    setErr("");
    setResult(null);
    try {
      const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/notifications/broadcast"), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          title: title.trim(),
          body:  body.trim(),
          emoji: emoji.trim(),
          kind,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json() as { sent: number; failed: number; total: number };
      setResult(data);
      // Clear compose fields so it's obvious the send happened — easy to
      // accidentally broadcast the same message twice if the form is left filled.
      setTitle("");
      setBody("");
      setConfirming(false);
      window.setTimeout(() => setResult(null), 6000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>Broadcast to all users</h3>
          <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            Sends a popup to every account. Online users see it within ~20s; offline users on next sign-in.
          </p>
        </div>
        {result && (
          <span className="text-[11px] font-semibold text-emerald-500">
            Sent {result.sent}/{result.total}{result.failed ? ` (${result.failed} failed)` : ""}
          </span>
        )}
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={emoji}
            onChange={e => setEmoji(e.target.value.slice(0, 4))}
            placeholder="📣"
            maxLength={4}
            className="w-14 rounded border px-2 py-1 text-sm text-center"
            style={{
              borderColor:     "var(--ats-border-subtle)",
              backgroundColor: "var(--ats-bg-panel)",
              color:           "var(--ats-fg-primary)",
            }}
          />
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value.slice(0, 120))}
            placeholder="Title — e.g. We just shipped Paper Review!"
            maxLength={120}
            className="flex-1 rounded border px-2 py-1 text-sm"
            style={{
              borderColor:     "var(--ats-border-subtle)",
              backgroundColor: "var(--ats-bg-panel)",
              color:           "var(--ats-fg-primary)",
            }}
          />
          <select
            value={kind}
            onChange={e => setKind(e.target.value as "system" | "general")}
            className="rounded border px-2 py-1 text-xs"
            style={{
              borderColor:     "var(--ats-border-subtle)",
              backgroundColor: "var(--ats-bg-panel)",
              color:           "var(--ats-fg-primary)",
            }}
          >
            <option value="system">system</option>
            <option value="general">general</option>
          </select>
        </div>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value.slice(0, 1200))}
          placeholder="Body — the announcement itself. Users see this as a modal they must click through."
          rows={3}
          className="w-full resize-y rounded border px-2 py-1 text-sm"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-primary)",
          }}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            {body.length}/1200 chars · {title.length}/120 title
          </span>
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              disabled={!canSend}
              className="ml-auto rounded border px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-50"
              style={{
                borderColor:     "var(--ats-border-accent)",
                backgroundColor: "var(--ats-bg-accent-soft)",
                color:           "var(--ats-fg-accent)",
              }}
            >
              Broadcast…
            </button>
          ) : (
            <div className="ml-auto inline-flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-amber-500">Send to everyone?</span>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded border px-2 py-1 text-xs font-semibold"
                style={{
                  borderColor: "var(--ats-border-subtle)",
                  color:       "var(--ats-fg-muted)",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void send()}
                disabled={busy}
                className="rounded border px-3 py-1 text-xs font-semibold"
                style={{
                  borderColor:     "rgba(239, 68, 68, 0.5)",
                  backgroundColor: "rgba(239, 68, 68, 0.12)",
                  color:           "#ef4444",
                }}
              >
                {busy ? "Sending…" : "Yes, send to everyone"}
              </button>
            </div>
          )}
        </div>
        {err && <div className="text-[11px] text-rose-500">{err}</div>}
      </div>
    </div>
  );
}


// Empty input box is shown as the placeholder "∞" — matches the display
// convention: no cap = unlimited.

type DraftMap = Record<string, Record<string, string>>; // tier → feature → draft text

function TierLimitsEditor({
  data, onSaveAll,
}: {
  data: TierLimitsResponse | null;
  onSaveAll: (
    updates: Array<{ tier: string; feature: string; limit: number | null }>,
  ) => Promise<void>;
}) {
  const TIERS: string[] = ["free", "basic", "scholar", "dev"];
  // Internal feature keys stay as-is (matches the quota table's column
  // names); only the display labels map to the renamed "Evidence Chain"
  // for deep_read.
  const FEATURES: { key: string; label: string }[] = [
    { key: "quick_search", label: "Quick Search"   },
    { key: "deep_search",  label: "Deep Search"    },
    { key: "synthesis",    label: "Synthesis"      },
    { key: "deep_read",    label: "Evidence Chain" },
  ];

  // Draft state keyed by tier → feature. Seed + re-seed from `data.effective`
  // every time the polled data refreshes, so the displayed values mirror
  // what the backend actually thinks is effective. The user's in-flight
  // edits are layered on top via the `draft` state.
  const [draft,       setDraft]       = useState<DraftMap>({});
  const [lastSeedKey, setLastSeedKey] = useState<string>("");
  const [saving,      setSaving]      = useState(false);
  const [saveMsg,     setSaveMsg]     = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  useEffect(() => {
    if (!data) return;
    // Re-seed only when the effective matrix identity actually changes —
    // otherwise every 60 s poll would reset the user's in-flight edits.
    const seedKey = JSON.stringify(data.effective);
    if (seedKey === lastSeedKey) return;
    const next: DraftMap = {};
    for (const tier of TIERS) {
      next[tier] = {};
      for (const f of FEATURES) {
        const v = data.effective[tier]?.[f.key];
        next[tier][f.key] = (v === null || v === undefined) ? "" : String(v);
      }
    }
    setDraft(next);
    setLastSeedKey(seedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lastSeedKey]);

  if (!data) {
    return <div className="text-xs italic py-4 text-center" style={{ color: "var(--ats-fg-muted)" }}>Loading…</div>;
  }

  const overrideMap: Record<string, Record<string, boolean>> = {};
  for (const row of data.overrides) {
    if (!overrideMap[row.tier]) overrideMap[row.tier] = {};
    overrideMap[row.tier][row.feature] = true;
  }

  // Compute which cells have been edited away from the live value. Used
  // for the orange "unsaved" dot and the Save button's change count.
  const dirtyCells: Array<{ tier: string; feature: string; draft: string; live: string }> = [];
  for (const tier of TIERS) {
    for (const f of FEATURES) {
      const liveVal = data.effective[tier]?.[f.key];
      const live    = (liveVal === null || liveVal === undefined) ? "" : String(liveVal);
      const d       = draft[tier]?.[f.key] ?? "";
      if (d.trim() !== live) {
        dirtyCells.push({ tier, feature: f.key, draft: d, live });
      }
    }
  }
  const dirtyCount  = dirtyCells.length;
  const canSave     = dirtyCount > 0 && !saving;

  const setCell = (tier: string, feature: string, value: string) => {
    setDraft(prev => ({
      ...prev,
      [tier]: { ...(prev[tier] ?? {}), [feature]: value },
    }));
  };

  // Revert every draft back to the live effective value. Used by both
  // the Cancel button and after a successful save (the draft should
  // match the newly-persisted live values).
  const revertAll = () => {
    const next: DraftMap = {};
    for (const tier of TIERS) {
      next[tier] = {};
      for (const f of FEATURES) {
        const v = data.effective[tier]?.[f.key];
        next[tier][f.key] = (v === null || v === undefined) ? "" : String(v);
      }
    }
    setDraft(next);
  };

  // Validate each dirty cell then PATCH them all. Validation rules:
  //   ""             → reset override (limit=null on the PATCH)
  //   "-1"           → unlimited (limit=-1 → backend stores NULL override)
  //   "0", "1", …    → numeric cap
  // Non-numeric / negative (other than -1) → flagged, save aborts with
  // an inline error so the operator knows which cell was bad.
  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const updates: Array<{ tier: string; feature: string; limit: number | null }> = [];
      for (const d of dirtyCells) {
        const t = d.draft.trim();
        if (t === "") {
          // Back to code default.
          updates.push({ tier: d.tier, feature: d.feature, limit: null });
          continue;
        }
        const n = Number(t);
        if (!Number.isFinite(n)) {
          throw new Error(`"${d.draft}" is not a number (${d.tier} / ${d.feature})`);
        }
        if (n < -1) {
          throw new Error(`Negative values are not allowed (${d.tier} / ${d.feature})`);
        }
        updates.push({ tier: d.tier, feature: d.feature, limit: Math.floor(n) });
      }
      await onSaveAll(updates);
      setSaveMsg({ text: `Saved ${updates.length} change${updates.length === 1 ? "" : "s"}.`, kind: "ok" });
      // Auto-clear success after ~3 s so stale "Saved" doesn't linger.
      window.setTimeout(() => setSaveMsg(null), 3000);
    } catch (e) {
      setSaveMsg({ text: e instanceof Error ? e.message : String(e), kind: "err" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider border-b" style={{ color: "var(--ats-fg-muted)", borderColor: "var(--ats-border-subtle)" }}>
            <th className="pb-2 pr-3 font-semibold">Tier</th>
            {FEATURES.map(f => (
              <th key={f.key} className="pb-2 pr-3 font-semibold">{f.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TIERS.map(tier => (
            <tr key={tier} className="border-b" style={{ borderColor: "var(--ats-border-subtle)" }}>
              <td className="py-2 pr-3 align-top">
                <span
                  className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide"
                  style={{
                    color:           TIER_COLORS[tier] ?? "#64748b",
                    backgroundColor: (TIER_COLORS[tier] ?? "#64748b") + "22",
                    borderColor:     (TIER_COLORS[tier] ?? "#64748b") + "55",
                    borderWidth: 1, borderStyle: "solid",
                  }}
                >
                  {tier}
                </span>
              </td>
              {FEATURES.map(f => {
                const liveVal = data.effective[tier]?.[f.key];
                const live    = (liveVal === null || liveVal === undefined) ? "" : String(liveVal);
                const d       = draft[tier]?.[f.key] ?? "";
                const dirty   = d.trim() !== live;
                const isOverridden = !!overrideMap[tier]?.[f.key];
                return (
                  <td key={f.key} className="py-2 pr-3 align-top">
                    <div className="flex items-center gap-1">
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                        title={
                          dirty        ? "Unsaved change (click Save below)" :
                          isOverridden ? "Overridden via admin dashboard"    :
                                         "Using code default"
                        }
                        style={{
                          backgroundColor:
                            dirty        ? "#f59e0b"                 :
                            isOverridden ? "var(--ats-fg-accent)"    :
                                           "var(--ats-fg-muted)",
                        }}
                      />
                      <input
                        type="number"
                        min={-1}
                        value={d}
                        onChange={(e) => setCell(tier, f.key, e.target.value)}
                        placeholder="∞"
                        className="w-16 rounded border px-1.5 py-0.5 text-xs tabular-nums outline-none focus:border-[var(--ats-border-accent)]"
                        style={{
                          borderColor:     dirty ? "#f59e0b55" : "var(--ats-border-subtle)",
                          backgroundColor: "var(--ats-bg-base)",
                          color:           "var(--ats-fg-primary)",
                        }}
                      />
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Save / revert footer — always visible so the operator sees that
          changes are deferred, not auto-saved. Save button is explicitly
          bright on dirty to advertise "click me"; dims to disabled when
          there's nothing to persist. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-[10px] flex-1 min-w-0" style={{ color: "var(--ats-fg-muted)" }}>
          Empty = unlimited (—1 also works). <span style={{ color: "#f59e0b" }}>●</span> Unsaved ·
          <span style={{ color: "var(--ats-fg-accent)" }}> ●</span> Overridden ·
          <span style={{ color: "var(--ats-fg-muted)" }}> ○</span> Default.
        </p>
        {dirtyCount > 0 && (
          <button
            onClick={revertAll}
            disabled={saving}
            className="rounded-md border px-3 py-1 text-xs transition-colors disabled:opacity-40"
            style={{
              borderColor: "var(--ats-border-subtle)",
              color:       "var(--ats-fg-secondary)",
            }}
          >Discard</button>
        )}
        <button
          onClick={() => void save()}
          disabled={!canSave}
          className="rounded-md px-4 py-1 text-xs font-bold shadow-sm transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            backgroundColor: "var(--ats-fg-accent)",
            color:           "#ffffff",
            border:          "1px solid var(--ats-fg-accent)",
          }}
        >
          {saving
            ? "Saving…"
            : dirtyCount > 0
              ? `Save ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`
              : "Save"}
        </button>
      </div>

      {saveMsg && (
        <p
          className="mt-2 text-[11px] rounded-md px-3 py-1.5 border"
          style={{
            borderColor:     saveMsg.kind === "ok" ? "#10b98155" : "#ef444455",
            backgroundColor: saveMsg.kind === "ok" ? "#10b9811a" : "#ef44441a",
            color:           saveMsg.kind === "ok" ? "#10b981"   : "#ef4444",
          }}
        >
          {saveMsg.kind === "ok" ? "✓ " : "⚠ "}{saveMsg.text}
          {saveMsg.kind === "ok" && (
            <span className="ml-1" style={{ color: "var(--ats-fg-muted)" }}>
              Applied globally — new requests use the new limits within ~30 s.
            </span>
          )}
        </p>
      )}
    </div>
  );
}


// ── Feedback inbox ────────────────────────────────────────────────────────

function FeedbackInbox({
  rows, onToggle,
}: {
  rows: FeedbackRow[];
  /** Re-throws on failure so the row can show "Saving…" then surface a
   *  visible error instead of silently leaving the pill unchanged. */
  onToggle: (id: number, next: boolean) => Promise<void>;
}) {
  // Per-row in-flight tracking. Keyed by feedback id so two rows can
  // toggle in parallel without blocking each other; we only block the
  // ROW that's currently flipping, not the whole list.
  const [pendingId, setPendingId] = useState<number | null>(null);

  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-4 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No feedback yet. The 🐛 button in the main app posts here.
      </div>
    );
  }
  const CATEGORY_COLOR: Record<string, string> = {
    bug:     "#ef4444",
    feature: "#3b82f6",
    general: "#64748b",
  };

  const handleToggle = async (id: number, next: boolean) => {
    setPendingId(id);
    try {
      await onToggle(id, next);
    } catch (e) {
      // Visible feedback — without this the row pill silently stays as
      // "Resolve" / "Reopen" and the admin can't tell anything failed.
      alert(`Feedback update failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-2 max-h-[28rem] overflow-y-auto thin-scrollbar pr-1">
      {rows.map(f => {
        const color = CATEGORY_COLOR[f.category] ?? "#64748b";
        const isPending = pendingId === f.id;
        return (
          <div
            key={f.id}
            className="rounded-lg border p-2.5"
            style={{
              borderColor:     f.resolved ? "var(--ats-border-subtle)" : color + "55",
              backgroundColor: f.resolved ? "var(--ats-bg-base)"       : color + "0f",
              opacity:         f.resolved ? 0.6 : 1,
            }}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border tracking-wide"
                  style={{ color, backgroundColor: color + "1a", borderColor: color + "55" }}
                >
                  {f.category}
                </span>
                <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  {f.user_email ?? <em>(no email)</em>}
                </span>
                <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  · {fmtDateTime(f.created_at)}
                </span>
              </div>
              <button
                onClick={() => void handleToggle(f.id, !f.resolved)}
                disabled={isPending}
                className="text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors hover:brightness-110 disabled:opacity-50 disabled:cursor-wait"
                style={{
                  borderColor:     f.resolved ? "var(--ats-border-subtle)" : "#10b98155",
                  backgroundColor: f.resolved ? "transparent"              : "#10b9811a",
                  color:           f.resolved ? "var(--ats-fg-muted)"      : "#10b981",
                }}
              >
                {isPending ? "Saving…" : f.resolved ? "Reopen" : "Resolve"}
              </button>
            </div>
            <p className="text-[12px] break-words leading-relaxed" style={{ color: "var(--ats-fg-primary)" }}>
              {f.message}
            </p>
            {f.page_url && (
              <p className="text-[10px] mt-1 font-mono truncate" style={{ color: "var(--ats-fg-muted)" }}>
                {f.page_url}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Human-readable byte formatter — used only by DbStatsPanel.
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function pct(num: number, denom: number): string {
  if (!denom) return "0.0";
  return ((num / denom) * 100).toFixed(1);
}

// All timestamps the admin sees are normalised to America/New_York (the
// canonical "server reference time" since the dev's user-facing rules
// like UTC midnight quota resets and daily-rotated chips are easier to
// reason about against ET) with a Beijing reference appended for
// dev convenience. Previously fmtDate returned `.toISOString().slice(0,10)`
// which was UTC date — visibly wrong for late-evening events on either
// coast — and timestamps like the maintenance set_at used raw
// `.toLocaleString()` which fell back to whichever TZ the dev's browser
// was in. Single source of truth now.

const _NY_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
});
const _NY_DATETIME_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});
const _BJ_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
});
const _BJ_TIME_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit", minute: "2-digit",
  hour12: false,
});

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return _NY_DATE_FMT.format(d);
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  // en-CA gives "YYYY-MM-DD, HH:MM:SS" → strip the comma.
  const ny = _NY_DATETIME_FMT.format(d).replace(", ", " ");
  // Beijing is +12-13 h ahead of ET so the date often differs. Show date
  // + time when it does, time-only when it doesn't (compact when same day,
  // unambiguous when not).
  const sameDay = _NY_DATE_FMT.format(d) === _BJ_DATE_FMT.format(d);
  const bj = sameDay
    ? _BJ_TIME_FMT.format(d)
    : `${_BJ_DATE_FMT.format(d)} ${_BJ_TIME_FMT.format(d)}`;
  return `${ny} ET · ${bj} Beijing`;
}

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}
