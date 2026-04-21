// ─────────────────────────────────────────────────────────────────────────────
// /admin — dev-only commercial monitoring dashboard.
//
// Access control happens in two places:
//   1. Client-side: we check `authUser.email` against the DEV_ACCTS list
//      from page.tsx. If the visitor isn't a dev we render an "access
//      denied" screen instead of firing the API calls. This is a UX
//      gate only — anyone with a JWT could hit the endpoints directly.
//   2. Server-side: every /api/admin/* endpoint re-runs `_require_dev`
//      which enforces tier == "dev" or membership in the email allowlist.
//
// Data flow:
//   - /api/admin/overview            — polled every 10s
//   - /api/admin/usage-timeseries    — refreshed every 60s
//   - /api/admin/users               — refreshed every 60s
//   - /api/admin/announcements-all   — refreshed every 60s
//
// Charts are hand-rolled SVG (see `LineChart` / `DonutChart` below) so we
// don't pull in a chart library for a single-page internal tool.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { buildApiUrl, fetchWithAuth } from "@/lib/api";
import {
  BarChart as BarChartIcon, Users, Activity, MessageSquare, Zap,
  DollarSign, RefreshCw, ArrowLeft, AlertTriangle, Sparkles,
  FileText, Clock, Database,
} from "lucide-react";

// ── Must stay in sync with the same list in src/app/page.tsx ────────────────
const DEV_ACCTS = [
  "dev01@academicats.com",
  "dev02@academicats.com",
  "dev03@academicats.com",
];

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
  today: {
    quick_search_count: number;
    deep_search_count:  number;
    synthesis_count:    number;
    deep_read_count:    number;
    llm_cost_usd:       number;
  };
};

type AdminAnnouncement = {
  id: string;
  author_id: string | null;
  author_email: string;
  text: string;
  is_public: boolean;
  created_at: string;
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
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authEmail,   setAuthEmail]   = useState<string | null>(null);

  // Gate — only dev accounts get past here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        const email = data.session?.user?.email ?? null;
        setAuthEmail(email);
        setAuthChecked(true);
      } catch {
        setAuthChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isDev = authEmail ? DEV_ACCTS.includes(authEmail) : false;
  const enabled = authChecked && isDev;

  // ── Fetchers ────────────────────────────────────────────────────────────
  const fetchOverview = useCallback(async (): Promise<Overview> => {
    const res = await fetchWithAuth(buildApiUrl("/api/admin/overview"));
    if (!res.ok) throw new Error(`overview HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchTimeseries = useCallback(async (): Promise<{ data: TimeSeriesPoint[] }> => {
    const res = await fetchWithAuth(buildApiUrl("/api/admin/usage-timeseries?days=30"));
    if (!res.ok) throw new Error(`timeseries HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchUsers = useCallback(async (): Promise<{ users: AdminUser[] }> => {
    const res = await fetchWithAuth(buildApiUrl("/api/admin/users?limit=50"));
    if (!res.ok) throw new Error(`users HTTP ${res.status}`);
    return res.json();
  }, []);

  const fetchAnnouncements = useCallback(async (): Promise<{ announcements: AdminAnnouncement[] }> => {
    const res = await fetchWithAuth(buildApiUrl("/api/admin/announcements-all"));
    if (!res.ok) throw new Error(`announcements HTTP ${res.status}`);
    return res.json();
  }, []);

  const overview     = usePolling(fetchOverview,     OVERVIEW_POLL_MS, enabled);
  const timeseries   = usePolling(fetchTimeseries,   DETAIL_POLL_MS,   enabled);
  const users        = usePolling(fetchUsers,        DETAIL_POLL_MS,   enabled);
  const announcements= usePolling(fetchAnnouncements,DETAIL_POLL_MS,   enabled);

  const refreshAll = () => {
    overview.refresh();
    timeseries.refresh();
    users.refresh();
    announcements.refresh();
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

  if (!authEmail) {
    return (
      <div data-theme="day-mint" data-tone="day" className="min-h-screen bg-[var(--ats-bg-base)] flex items-center justify-center">
        <div
          className="rounded-2xl border p-8 max-w-md text-center"
          style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}
        >
          <AlertTriangle className="mx-auto mb-3 text-amber-500" size={32} />
          <h1 className="text-lg font-bold mb-2" style={{ color: "var(--ats-fg-primary)" }}>Admin console</h1>
          <p className="text-sm mb-4" style={{ color: "var(--ats-fg-secondary)" }}>
            Please sign in with a developer account to access the monitoring dashboard.
          </p>
          <button
            onClick={() => router.push("/login")}
            className="rounded-lg border px-4 py-2 text-sm font-semibold hover:brightness-110 transition-all"
            style={{
              borderColor:     "var(--ats-border-accent)",
              backgroundColor: "var(--ats-bg-accent-soft)",
              color:           "var(--ats-fg-accent)",
            }}
          >
            Go to login
          </button>
        </div>
      </div>
    );
  }

  if (!isDev) {
    return (
      <div data-theme="day-mint" data-tone="day" className="min-h-screen bg-[var(--ats-bg-base)] flex items-center justify-center">
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-8 max-w-md text-center">
          <AlertTriangle className="mx-auto mb-3 text-red-500" size={32} />
          <h1 className="text-lg font-bold mb-2" style={{ color: "var(--ats-fg-primary)" }}>Access denied</h1>
          <p className="text-sm" style={{ color: "var(--ats-fg-secondary)" }}>
            The admin console is restricted to developer accounts. You&apos;re signed in as
            <code className="ml-1" style={{ color: "var(--ats-fg-primary)" }}>{authEmail}</code>.
          </p>
          <Link href="/" className="inline-block mt-4 text-xs underline" style={{ color: "var(--ats-fg-muted)" }}>
            ← Back to the main app
          </Link>
        </div>
      </div>
    );
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
