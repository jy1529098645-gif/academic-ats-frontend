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
//   - /api/admin/overview            — polled every 10s
//   - /api/admin/system-health       — polled every 10s
//   - /api/admin/usage-timeseries    — refreshed every 60s
//   - /api/admin/users               — refreshed every 60s
//   - /api/admin/announcements-all   — refreshed every 60s
//   - /api/admin/db-stats            — refreshed every 60s
//   - /api/admin/cost-alerts         — refreshed every 60s
//   - /api/admin/errors              — refreshed every 30s
//   - /api/admin/feedback            — refreshed every 30s
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

const OVERVIEW_POLL_MS = 10_000; // hot KPIs
const DETAIL_POLL_MS   = 60_000; // time-series / users / announcements

// ── API response types ──────────────────────────────────────────────────────

type Overview = {
  server_time: string;
  users: { total: number; by_tier: Record<string, number> };
  conversations: number;
  history_entries: number;
  today: {
    day_utc: string;
    active_users: number;
    quick_search_count: number;
    deep_search_count:  number;
    synthesis_count:    number;
    deep_read_count:    number;
    llm_cost_usd:       number;
  };
  announcements_total: number;
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
  tier: "free" | "basic" | "scholar" | "dev" | string;
  tier_updated_at: string | null;
  profile_updated: string | null;
  first_seen_at:   string | null;
  today: {
    quick_search_count: number;
    deep_search_count:  number;
    synthesis_count:    number;
    deep_read_count:    number;
    llm_cost_usd:       number;
  };
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
  const enabled = authChecked && isDev;

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
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/usage-timeseries?days=30"));
    if (!res.ok) throw new Error(`timeseries HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchUsers = useCallback(async (): Promise<{ users: AdminUser[] }> => {
    const res = await fetchWithAdminAuth(buildApiUrl("/api/admin/users?limit=50"));
    if (!res.ok) throw new Error(`users HTTP ${res.status}`);
    return res.json();
  }, []);

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
  const toggleFeedbackResolved = async (id: number, next: boolean) => {
    try {
      const res = await fetchWithAdminAuth(buildApiUrl(`/api/admin/feedback/${id}`), {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ resolved: next }),
      });
      if (!res.ok) throw new Error(`resolve HTTP ${res.status}`);
      feedback.refresh();
    } catch (e) {
      console.error("[admin] toggleFeedbackResolved:", e);
    }
  };

  // ── Gate screens ────────────────────────────────────────────────────────
  // All three gate screens inherit the day-mint theme wrapper below so
  // even an unauthorised visitor sees the correct palette (no brief dark
  // flash before the login redirect).
  if (!authChecked) {
    return (
      <div data-theme="day-mint" data-tone="day" className="min-h-screen bg-[var(--ats-bg-base)] flex items-center justify-center">
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

  // ── Authorised render ───────────────────────────────────────────────────
  const ov = overview.data;
  const ts = timeseries.data?.data ?? [];
  const userList = users.data?.users ?? [];
  const annList  = announcements.data?.announcements ?? [];

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
      className="h-screen overflow-y-auto thin-scrollbar bg-[var(--ats-bg-base)] text-[var(--ats-fg-primary)]"
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
            {overview.lastUpdated > 0 && (
              <span className="inline-flex items-center gap-1">
                <Clock size={11} />
                Updated {relativeTime(overview.lastUpdated)}
              </span>
            )}
            <span className="inline-flex items-center gap-1" title="Signed into admin console as">
              <code style={{ color: "var(--ats-fg-primary)" }}>{authEmail}</code>
            </span>
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

        {/* ── KPI hero ──────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: "var(--ats-fg-secondary)" }}>
            Live KPIs
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard
              icon={<Users size={14} />}
              label="Total users"
              value={ov?.users.total ?? "—"}
              sublabel={`${ov?.users.by_tier.dev ?? 0} dev · ${ov?.users.by_tier.scholar ?? 0} scholar`}
              color="#3b82f6"
            />
            <KpiCard
              icon={<Activity size={14} />}
              label="Active today"
              value={ov?.today.active_users ?? "—"}
              sublabel={ov ? `${pct(ov.today.active_users, ov.users.total)}% of all users` : ""}
              color="#10b981"
            />
            <KpiCard
              icon={<Zap size={14} />}
              label="Searches today"
              value={ov ? (ov.today.quick_search_count + ov.today.deep_search_count) : "—"}
              sublabel={ov ? `${ov.today.quick_search_count} quick · ${ov.today.deep_search_count} deep` : ""}
              color="#8b5cf6"
            />
            <KpiCard
              icon={<Sparkles size={14} />}
              label="Synthesis today"
              value={ov?.today.synthesis_count ?? "—"}
              sublabel={`${ov?.today.deep_read_count ?? 0} deep reads`}
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
              label="Cost today"
              value={ov ? `$${ov.today.llm_cost_usd.toFixed(2)}` : "—"}
              sublabel="LLM usage (USD)"
              color="#ef4444"
            />
          </div>
        </section>

        {/* ── Charts row ────────────────────────────────────────────── */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Time-series (2/3) */}
          <div className="lg:col-span-2 rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                  Usage — last 30 days
                </h3>
                <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                  Daily volumes per feature, zero-filled for quiet days.
                </p>
              </div>
              <TimeseriesLegend />
            </div>
            {ts.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-xs" style={{ color: "var(--ats-fg-muted)" }}>
                No data yet
              </div>
            ) : (
              <LineChart data={ts} />
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

        {/* ── Users table ───────────────────────────────────────────── */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                Recent users
              </h3>
              <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                Sorted by most-recent tier change. Showing {userList.length}.
              </p>
            </div>
            <button
              onClick={() => users.refresh()}
              className="text-[10px] inline-flex items-center gap-1 transition-colors"
              style={{ color: "var(--ats-fg-muted)" }}
            >
              <RefreshCw size={10} /> Refresh
            </button>
          </div>
          <UserTable users={userList} />
        </section>

        {/* ── Announcements + summary side-by-side ──────────────────── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl border p-4" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
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
              <button
                onClick={() => announcements.refresh()}
                className="text-[10px] inline-flex items-center gap-1 transition-colors"
                style={{ color: "var(--ats-fg-muted)" }}
              >
                <RefreshCw size={10} /> Refresh
              </button>
            </div>
            <AnnouncementLog rows={annList} />
          </div>

          <div className="rounded-2xl border p-4" style={panelStyle}>
            <h3 className="text-sm font-bold mb-3" style={{ color: "var(--ats-fg-primary)" }}>
              System snapshot
            </h3>
            <SystemSnapshot overview={ov} />
          </div>
        </section>

        {/* ── Integrated monitoring: DB / health / errors / cost / feedback ── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
        </section>

        {/* Cost alerts + Error log side-by-side */}
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
            <CostAlertsPanel alerts={costAlerts.data?.alerts ?? []} />
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

        {/* Activity feed — what each user actually did, newest first */}
        <section className="rounded-2xl border p-4" style={panelStyle}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold" style={{ color: "var(--ats-fg-primary)" }}>
                Recent activity
              </h3>
              <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                Every logged-in search / synthesis / deep-read emits one row.
                Refreshes every 30 s.
              </p>
            </div>
            <button
              onClick={() => activity.refresh()}
              className="text-[10px] inline-flex items-center gap-1"
              style={{ color: "var(--ats-fg-muted)" }}
            >
              <RefreshCw size={10} /> Refresh
            </button>
          </div>
          <ActivityFeed rows={activity.data?.activity ?? []} />
        </section>

        {/* Tier limits editor — full width because it's a table */}
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
            <button
              onClick={() => tierLimits.refresh()}
              className="text-[10px] inline-flex items-center gap-1"
              style={{ color: "var(--ats-fg-muted)" }}
            >
              <RefreshCw size={10} /> Refresh
            </button>
          </div>
          <TierLimitsEditor data={tierLimits.data} onSaveAll={saveTierLimitsBatch} />
        </section>

        {/* Feedback inbox — full width so long messages are readable */}
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
            <button onClick={() => feedback.refresh()} className="text-[10px] inline-flex items-center gap-1" style={{ color: "var(--ats-fg-muted)" }}>
              <RefreshCw size={10} /> Refresh
            </button>
          </div>
          <FeedbackInbox rows={feedback.data?.feedback ?? []} onToggle={toggleFeedbackResolved} />
        </section>

        <footer className="pt-2 pb-8 text-center">
          <p className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            Admin console · polling overview every {Math.round(OVERVIEW_POLL_MS / 1000)}s,
            details every {Math.round(DETAIL_POLL_MS / 1000)}s ·
            <Link href="/" className="ml-1 underline hover:opacity-80">Back to app</Link>
          </p>
        </footer>
      </main>
    </div>
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
    <div data-theme="day-mint" data-tone="day" className="min-h-screen bg-[var(--ats-bg-base)] flex items-center justify-center px-4">
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

function LineChart({ data }: { data: TimeSeriesPoint[] }) {
  const W = 800;
  const H = 260;
  const P = { top: 16, right: 20, bottom: 28, left: 40 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;

  const max = useMemo(() => {
    const m = Math.max(
      1,
      ...data.flatMap(d => [
        d.quick_search_count, d.deep_search_count, d.synthesis_count, d.deep_read_count,
      ]),
    );
    // Round up to a nice number for axis labels.
    const power = Math.pow(10, Math.floor(Math.log10(m)));
    return Math.ceil(m / power) * power;
  }, [data]);

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

  // X-axis tick positions — every ~5 days.
  const tickStride = Math.max(1, Math.ceil(n / 6));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-64" aria-label="Usage time series">
      {/* Grid — stroke uses --ats-border-subtle so axes dim on dark themes
          but pop on the day-mint default. */}
      {[0, 0.25, 0.5, 0.75, 1].map((frac, i) => {
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
      {/* X ticks */}
      {data.map((d, i) => {
        if (i % tickStride !== 0 && i !== n - 1) return null;
        const x = P.left + i * stepX;
        return (
          <text key={d.day} x={x} y={H - 10} textAnchor="middle" fontSize={9} fill="var(--ats-fg-muted)">
            {d.day.slice(5)}
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

function TimeseriesLegend() {
  const items = [
    { color: "#3b82f6", label: "Quick search" },
    { color: "#8b5cf6", label: "Deep search" },
    { color: "#ec4899", label: "Synthesis" },
    { color: "#10b981", label: "Deep reads" },
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

function UserTable({ users }: { users: AdminUser[] }) {
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
            <th className="pb-2 pr-3 font-semibold text-right">Quick</th>
            <th className="pb-2 pr-3 font-semibold text-right">Deep</th>
            <th className="pb-2 pr-3 font-semibold text-right">Synth</th>
            <th className="pb-2 pr-3 font-semibold text-right">Reads</th>
            <th className="pb-2 pr-3 font-semibold text-right">Cost (USD)</th>
            <th className="pb-2 pr-3 font-semibold">First seen</th>
            <th className="pb-2 font-semibold">Tier changed</th>
          </tr>
        </thead>
        <tbody style={{ color: "var(--ats-fg-primary)" }}>
          {users.map(u => (
            <tr
              key={u.id}
              className="border-b transition-colors hover:bg-[var(--ats-bg-accent-soft)]"
              style={{ borderColor: "var(--ats-border-subtle)" }}
            >
              <td className="py-1.5 pr-3 truncate max-w-[220px]" title={u.email ?? ""}>
                {u.email ?? <span className="italic" style={{ color: "var(--ats-fg-muted)" }}>(no email)</span>}
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
              <td className="py-1.5 pr-3 text-right tabular-nums">{u.today.quick_search_count}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{u.today.deep_search_count}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{u.today.synthesis_count}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{u.today.deep_read_count}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: "var(--ats-fg-secondary)" }}>
                {u.today.llm_cost_usd.toFixed(4)}
              </td>
              <td className="py-1.5 pr-3" style={{ color: "var(--ats-fg-secondary)" }} title={u.first_seen_at ?? ""}>
                {fmtDate(u.first_seen_at)}
              </td>
              <td className="py-1.5" style={{ color: "var(--ats-fg-muted)" }}>
                {fmtDate(u.tier_updated_at)}
              </td>
            </tr>
          ))}
        </tbody>
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
        No activity yet. Rows appear here as soon as a signed-in user runs a search / synthesis / deep-read.
      </div>
    );
  }
  const ACTION_COLOR: Record<string, string> = {
    search:    "#3b82f6",
    synthesis: "#8b5cf6",
    deep_read: "#10b981",
  };
  return (
    <div className="max-h-96 overflow-y-auto thin-scrollbar pr-1 space-y-1">
      {rows.map(r => {
        const color = ACTION_COLOR[r.action] ?? "#64748b";
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
              {r.action}
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

function AnnouncementLog({ rows }: { rows: AdminAnnouncement[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-xs italic py-6 text-center" style={{ color: "var(--ats-fg-muted)" }}>
        No announcements yet.
      </div>
    );
  }
  return (
    <div className="max-h-96 overflow-y-auto thin-scrollbar pr-1 space-y-1.5">
      {rows.map(a => {
        const isSeed = a.author_email === "dev@academicats.com";
        return (
          <div
            key={a.id}
            className="rounded-md border p-2"
            style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-base)" }}
          >
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span
                className="text-[10px] font-semibold"
                style={{ color: isSeed ? "#d97706" : "var(--ats-fg-accent)" }}
              >
                {isSeed ? "SEED" : (a.author_email || "NAMELESS CAT")}
              </span>
              <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
                {fmtDateTime(a.created_at)}
              </span>
            </div>
            <p className="text-[11px] leading-relaxed break-words" style={{ color: "var(--ats-fg-secondary)" }}>
              {a.text}
            </p>
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
    { icon: <Clock     size={12} />, label: "Server time (UTC)",     value: overview ? fmtDateTime(overview.server_time) : "—" },
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
  const FEATURES: { key: string; label: string }[] = [
    { key: "quick_search", label: "Quick Search" },
    { key: "deep_search",  label: "Deep Search"  },
    { key: "synthesis",    label: "Synthesis"    },
    { key: "deep_read",    label: "Deep Read"    },
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
  onToggle: (id: number, next: boolean) => void;
}) {
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
  return (
    <div className="space-y-2 max-h-[28rem] overflow-y-auto thin-scrollbar pr-1">
      {rows.map(f => {
        const color = CATEGORY_COLOR[f.category] ?? "#64748b";
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
                onClick={() => onToggle(f.id, !f.resolved)}
                className="text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors hover:brightness-110"
                style={{
                  borderColor:     f.resolved ? "var(--ats-border-subtle)" : "#10b98155",
                  backgroundColor: f.resolved ? "transparent"              : "#10b9811a",
                  color:           f.resolved ? "var(--ats-fg-muted)"      : "#10b981",
                }}
              >
                {f.resolved ? "Reopen" : "Resolve"}
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

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}
