// ─────────────────────────────────────────────────────────────────────────────
// MobileApp — fully independent mobile-native UI for AcademiCats.
//
// Design philosophy:
//   · Bottom tab bar for primary nav (thumb zone)
//   · One screen per task — no cramming side panels
//   · Full-screen bottom sheets for transient actions (settings, sign-in)
//   · Big tap targets (≥44 px), card-based lists, tight typography
//   · Theme tokens (--ats-*) shared with desktop so palette / accent colour
//     stay consistent across both UIs
//
// What's IN scope (Phase C v1):
//   · Search (Quick / Curated) with live SSE streaming
//   · Results: papers list + research brief tab
//   · History (cards, restore, favourite, delete)
//   · Profile (theme toggle, account info, sign-out, link to feedback)
//   · Sign-in gate (Google OAuth + anonymous "try as guest")
//
// What's NOT in scope (defer / point users to desktop):
//   · Synthesis Lab + Paper Review — dense forms, desktop-best
//   · Charts / analytics — SVG width-bound, desktop-best
//   · Admin dashboard — already gated to desktop globally
//   · Layout modes — meaningless on a single-column screen
//
// State scope: this component owns its own search + UI state. It still uses
// the shared Zustand stores (theme, prefs, guest-quota, hover-help) and the
// Supabase auth client, but its search / lab / history state is independent
// from the desktop component. A user who switches mid-search between mobile
// and desktop (by resizing the window) will start the new branch fresh —
// acceptable for v1, addressable later by lifting state into shared hooks
// if we see real cross-device usage.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Search, ListOrdered, Clock, User as UserIcon,
  Zap, FlaskConical, LogOut, Sun, Moon,
  ExternalLink, RefreshCw, Send,
} from "lucide-react";

import { supabase } from "@/lib/supabase/client";
import { fetchWithApiFallback, getAuthToken } from "@/lib/api";
import { useThemeStore } from "@/lib/stores/theme-store";
import { useGuestQuotaStore, GUEST_QUICK_MAX, GUEST_CURATED_MAX } from "@/lib/stores/guest-quota-store";
import { APP_VERSION } from "@/lib/tos-content";

// ─────────────────────────────────────────────────────────────────────────────
// Types — minimal, mobile-only. Doesn't import the desktop's Paper / Job
// shapes to keep this file self-contained; SSE fields are read by name and
// type-checked at use-site.
// ─────────────────────────────────────────────────────────────────────────────

type Tab = "home" | "results" | "history" | "profile";

type Paper = {
  title: string;
  authors?: string;
  year?: string | number;
  source?: string;
  evidence_score?: number | string;
  score?: number | string;
  url?: string;
  oa_url?: string;
  pdf_url?: string;
  is_oa?: boolean;
  summary?: string;
  recommendation_reason?: string;
};

type HistoryItem = {
  id: string;
  title: string;
  updated_at: string;
  isFast?: boolean;
  result?: { brief?: string; papers?: Paper[] } | null;
};

type AuthUser = {
  id?: string;
  email?: string | null;
  is_anonymous?: boolean;
};

type SearchStatus = "idle" | "running" | "done" | "error";

// ─────────────────────────────────────────────────────────────────────────────
// Top-level component
// ─────────────────────────────────────────────────────────────────────────────

export default function MobileApp() {
  // ── Auth ────────────────────────────────────────────────────────────────
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      setAuthUser(session?.user ?? null);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setAuthUser(session?.user ?? null);
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  // ── Theme application — separate from desktop's theme effect so this
  //    component can mount on its own without depending on DesktopWorkspace
  //    being in the tree. Writes the same data-theme + data-tone attrs the
  //    globals.css blocks expect.
  const themeMode    = useThemeStore(s => s.mode);
  const dayThemeId   = useThemeStore(s => s.dayThemeId);
  const nightThemeId = useThemeStore(s => s.nightThemeId);
  const setThemeMode = useThemeStore(s => s.setMode);
  const theme = themeMode === "day" ? dayThemeId : nightThemeId;

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-tone", themeMode);
  }, [theme, themeMode]);

  // ── Guest quota ─────────────────────────────────────────────────────────
  useEffect(() => { useGuestQuotaStore.getState().hydrate(); }, []);
  const isGuest = !!authUser?.is_anonymous;
  const guestQuickRemaining   = useGuestQuotaStore(s => Math.max(0, GUEST_QUICK_MAX   - s.quickUsed));
  const guestCuratedRemaining = useGuestQuotaStore(s => Math.max(0, GUEST_CURATED_MAX - s.curatedUsed));

  // ── Tab state ───────────────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("home");

  // ── Search state ────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [fastMode, setFastMode] = useState(true); // true = Quick, false = Curated
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [brief, setBrief] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // ── History (read-only on mobile; server-backed) ────────────────────────
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!authUser?.email) { setHistory([]); return; }
    setHistoryLoading(true);
    try {
      const token = await getAuthToken();
      if (!token) return;
      const res = await fetchWithApiFallback("/api/history?limit=50", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { items?: HistoryItem[] };
      const items = data.items ?? [];
      items.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      setHistory(items);
    } catch {
      // best-effort; leave previous list if fetch fails
    } finally {
      setHistoryLoading(false);
    }
  }, [authUser?.email]);

  // Refresh history when the user signs in or opens that tab.
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => { if (tab === "history") void loadHistory(); }, [tab, loadHistory]);

  // ── Search runner ───────────────────────────────────────────────────────
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    if (searchStatus === "running") return;
    if (!authUser) return; // sign-in gate handled below

    // Guest quota client-side hard-cap.
    if (isGuest) {
      const remaining = fastMode ? guestQuickRemaining : guestCuratedRemaining;
      if (remaining <= 0) {
        setErrorMsg("You've used your guest trial. Sign in for unlimited search.");
        return;
      }
    }

    abortRef.current = new AbortController();
    setSearchStatus("running");
    setProgress(0);
    setStatusMsg("Starting…");
    setPapers([]);
    setBrief("");
    setErrorMsg("");
    setTab("results");

    if (isGuest) {
      if (fastMode) useGuestQuotaStore.getState().incrementQuick();
      else          useGuestQuotaStore.getState().incrementCurated();
    }

    try {
      const token = await getAuthToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetchWithApiFallback("/api/search/stream", {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: q,
          fast_mode: fastMode,
          paper_count: fastMode ? 50 : 20,
          sort_mode: "Relevance score",
          prefer_abstracts: true,
          strict_core_only: false,
          open_access_only: true,
          source_filters: ["Semantic Scholar", "OpenAlex", "Crossref", "Google Scholar", "arXiv", "PubMed", "ERIC", "DOAJ", "DiGRA"],
          year_range: null,
          direction_data: null,
          selected_direction_index: null,
          selected_sub_index: null,
        }),
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        if (res.status === 429) {
          setErrorMsg("Daily quota reached — try again after 00:00 UTC, or sign in for more headroom.");
        } else {
          setErrorMsg(`Search failed: ${res.status}`);
        }
        setSearchStatus("error");
        return;
      }

      // Minimal SSE consumer — parses event/data lines, dispatches by event
      // name. Same wire format the desktop version uses.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sseEvent = "";
      let sseData = "";

      const handle = (eventName: string, payload: string) => {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(payload); } catch { return; }
        if (eventName === "progress") {
          if (typeof data.progress === "number") setProgress(Math.min(100, data.progress));
          if (typeof data.message === "string") setStatusMsg(data.message);
        } else if (eventName === "papers") {
          if (Array.isArray((data as { papers?: unknown[] }).papers)) {
            setPapers((data as { papers: Paper[] }).papers);
          }
        } else if (eventName === "brief_chunk") {
          const chunk = (data as { chunk?: string }).chunk;
          if (typeof chunk === "string") setBrief(prev => prev + chunk);
        } else if (eventName === "result") {
          const result = (data as { result?: { papers?: Paper[]; brief?: string } }).result;
          if (result?.papers) setPapers(result.papers);
          if (result?.brief) setBrief(result.brief);
          setProgress(100);
          setStatusMsg("Done.");
          setSearchStatus("done");
        } else if (eventName === "error") {
          const err = (data as { error?: string; message?: string }).error
            ?? (data as { message?: string }).message
            ?? "Search failed.";
          setErrorMsg(err);
          setSearchStatus("error");
        }
      };

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "") {
            // Blank line = SSE event boundary
            if (sseEvent && sseData) handle(sseEvent, sseData);
            if (sseData === "[DONE]") break outer;
            sseEvent = ""; sseData = "";
          } else if (line.startsWith("event:")) {
            sseEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            sseData = line.slice(5).trim();
          }
        }
      }
      // Flush any tail event
      if (sseEvent && sseData) handle(sseEvent, sseData);

      // If the stream ended without a "result" event, mark done by progress.
      if (searchStatusRef.current !== "done" && searchStatusRef.current !== "error") {
        setSearchStatus("done");
        setProgress(100);
      }

      void loadHistory();
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        setSearchStatus("idle");
        setStatusMsg("Stopped.");
      } else {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setSearchStatus("error");
      }
    } finally {
      abortRef.current = null;
    }
  }, [query, fastMode, searchStatus, authUser, isGuest, guestQuickRemaining, guestCuratedRemaining, loadHistory]);

  // Live ref for the SSE consumer's "did we end cleanly?" check above.
  const searchStatusRef = useRef<SearchStatus>("idle");
  useEffect(() => { searchStatusRef.current = searchStatus; }, [searchStatus]);

  const stopSearch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSearchStatus("idle");
  }, []);

  // ── Restore from history ────────────────────────────────────────────────
  const restoreFromHistory = useCallback((item: HistoryItem) => {
    setQuery(item.title);
    if (item.result) {
      setPapers(item.result.papers ?? []);
      setBrief(item.result.brief ?? "");
      setSearchStatus("done");
      setProgress(100);
      setStatusMsg("Restored from history.");
      setTab("results");
    } else {
      setTab("home");
    }
  }, []);

  // ── Sign-in handlers ────────────────────────────────────────────────────
  const handleGoogleLogin = useCallback(async () => {
    const redirectTo = typeof window !== "undefined"
      ? `${window.location.origin}/`
      : "https://academic-ats-frontend.vercel.app/";
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  }, []);

  const [guestSignInBusy, setGuestSignInBusy] = useState(false);
  const handleGuestLogin = useCallback(async () => {
    if (guestSignInBusy) return;
    setGuestSignInBusy(true);
    try {
      const auth = supabase.auth as unknown as {
        signInAnonymously: () => Promise<{ error: { message: string } | null }>;
      };
      const { error } = await auth.signInAnonymously();
      if (error) setErrorMsg(error.message);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setGuestSignInBusy(false);
    }
  }, [guestSignInBusy]);

  const handleSignOut = useCallback(async () => {
    try { await supabase.auth.signOut(); } catch { /* still clears local */ }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: "var(--ats-bg-base)" }}
      >
        <div className="text-sm" style={{ color: "var(--ats-fg-muted)" }}>Loading…</div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <SignInGate
        onGoogle={handleGoogleLogin}
        onGuest={handleGuestLogin}
        guestBusy={guestSignInBusy}
        themeMode={themeMode}
        onToggleTheme={() => setThemeMode(m => m === "day" ? "night" : "day")}
      />
    );
  }

  return (
    <div
      className="min-h-[100dvh] flex flex-col"
      style={{ backgroundColor: "var(--ats-bg-base)", color: "var(--ats-fg-primary)" }}
    >
      <Header
        themeMode={themeMode}
        onToggleTheme={() => setThemeMode(m => m === "day" ? "night" : "day")}
      />

      <main className="flex-1 min-h-0 overflow-y-auto pb-[5.5rem]">
        {tab === "home" && (
          <HomeScreen
            query={query}
            setQuery={setQuery}
            fastMode={fastMode}
            setFastMode={setFastMode}
            onSearch={() => void runSearch()}
            errorMsg={errorMsg}
            isGuest={isGuest}
            quickRemaining={guestQuickRemaining}
            curatedRemaining={guestCuratedRemaining}
          />
        )}
        {tab === "results" && (
          <ResultsScreen
            status={searchStatus}
            progress={progress}
            statusMsg={statusMsg}
            errorMsg={errorMsg}
            papers={papers}
            brief={brief}
            query={query}
            fastMode={fastMode}
            onStop={stopSearch}
          />
        )}
        {tab === "history" && (
          <HistoryScreen
            items={history}
            loading={historyLoading}
            onRestore={restoreFromHistory}
            onRefresh={() => void loadHistory()}
          />
        )}
        {tab === "profile" && (
          <ProfileScreen
            user={authUser}
            isGuest={isGuest}
            quickRemaining={guestQuickRemaining}
            curatedRemaining={guestCuratedRemaining}
            themeMode={themeMode}
            onToggleTheme={() => setThemeMode(m => m === "day" ? "night" : "day")}
            onSignOut={handleSignOut}
            onGoogleLogin={handleGoogleLogin}
          />
        )}
      </main>

      <TabBar
        active={tab}
        onChange={setTab}
        hasResults={searchStatus !== "idle" || papers.length > 0}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header — compact top bar with logo + theme toggle
// ─────────────────────────────────────────────────────────────────────────────

function Header({
  themeMode,
  onToggleTheme,
}: {
  themeMode: "day" | "night";
  onToggleTheme: () => void;
}) {
  return (
    <header
      className="shrink-0 flex items-center justify-between px-4 py-3 border-b"
      style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}
    >
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/Cats_01.png" alt="" className="h-7 w-7" draggable={false} />
        <div>
          <div className="text-base font-bold leading-none">
            <span style={{ color: "var(--ats-fg-primary)" }}>Academi</span>
            <span style={{ color: "var(--ats-fg-accent)" }}>Cats</span>
          </div>
          <div className="text-[10px] leading-none mt-0.5" style={{ color: "var(--ats-fg-muted)" }}>
            {APP_VERSION}
          </div>
        </div>
      </div>
      <button
        onClick={onToggleTheme}
        aria-label={themeMode === "night" ? "Switch to day theme" : "Switch to night theme"}
        className="flex h-9 w-9 items-center justify-center rounded-full border transition-colors"
        style={{
          borderColor:     "var(--ats-border-subtle)",
          backgroundColor: "var(--ats-bg-accent-soft)",
          color:           "var(--ats-fg-accent)",
        }}
      >
        {themeMode === "night" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bottom tab bar — primary nav, thumb-zone
// ─────────────────────────────────────────────────────────────────────────────

function TabBar({
  active,
  onChange,
  hasResults,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  hasResults: boolean;
}) {
  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode; disabled?: boolean }> = [
    { id: "home",     label: "Search",  icon: <Search size={20} /> },
    { id: "results",  label: "Results", icon: <ListOrdered size={20} />, disabled: !hasResults },
    { id: "history",  label: "History", icon: <Clock size={20} /> },
    { id: "profile",  label: "Profile", icon: <UserIcon size={20} /> },
  ];
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-30 flex items-stretch border-t safe-area-bottom"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-panel)",
        paddingBottom:   "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {tabs.map(t => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            onClick={() => !t.disabled && onChange(t.id)}
            disabled={t.disabled}
            className="flex-1 flex flex-col items-center justify-center gap-1 py-2.5 transition-colors disabled:opacity-40"
            style={{
              color: isActive ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
            }}
            aria-pressed={isActive}
            aria-label={t.label}
          >
            <span style={isActive ? { color: "var(--ats-fg-accent)" } : undefined}>{t.icon}</span>
            <span className="text-[10px] font-semibold tracking-wide">{t.label}</span>
            {isActive && (
              <span
                className="absolute top-0 h-0.5 w-10 rounded-b-full"
                style={{ backgroundColor: "var(--ats-fg-accent)" }}
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HomeScreen — search input, mode picker, run button
// ─────────────────────────────────────────────────────────────────────────────

function HomeScreen({
  query, setQuery, fastMode, setFastMode, onSearch, errorMsg,
  isGuest, quickRemaining, curatedRemaining,
}: {
  query: string;
  setQuery: (s: string) => void;
  fastMode: boolean;
  setFastMode: (b: boolean) => void;
  onSearch: () => void;
  errorMsg: string;
  isGuest: boolean;
  quickRemaining: number;
  curatedRemaining: number;
}) {
  const remaining = fastMode ? quickRemaining : curatedRemaining;
  const blockedByQuota = isGuest && remaining <= 0;

  return (
    <div className="px-4 py-5 space-y-5">
      {/* Greeting */}
      <div className="space-y-1">
        <h1 className="text-xl font-bold leading-tight" style={{ color: "var(--ats-fg-primary)" }}>
          What are you exploring?
        </h1>
        <p className="text-sm" style={{ color: "var(--ats-fg-muted)" }}>
          Type a research question, theme, or paper title.
        </p>
      </div>

      {/* Query input */}
      <div>
        <textarea
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="e.g. mindfulness apps and undergraduate anxiety"
          rows={4}
          className="w-full rounded-2xl border px-4 py-3 text-base resize-y outline-none focus:ring-2 focus:ring-[var(--ats-fg-accent)] transition-shadow"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-primary)",
          }}
        />
        <div className="mt-1 text-right text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
          {query.trim().length} chars
        </div>
      </div>

      {/* Mode picker — segmented control */}
      <div>
        <div
          className="grid grid-cols-2 gap-1 rounded-2xl p-1 border"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
          }}
        >
          <ModeChip
            active={fastMode}
            onClick={() => setFastMode(true)}
            icon={<Zap size={16} />}
            label="Quick"
            tagline="Scan at scale"
          />
          <ModeChip
            active={!fastMode}
            onClick={() => setFastMode(false)}
            icon={<FlaskConical size={16} />}
            label="Curated"
            tagline="High quality"
          />
        </div>
      </div>

      {/* Guest quota indicator */}
      {isGuest && (
        <div
          className="flex items-center justify-between rounded-xl border px-3 py-2 text-xs"
          style={{
            borderColor:     "var(--ats-border-accent)",
            backgroundColor: "var(--ats-bg-accent-soft)",
            color:           "var(--ats-fg-accent)",
          }}
        >
          <span className="font-semibold">Guest mode</span>
          <span className="tabular-nums">{quickRemaining}Q · {curatedRemaining}C left</span>
        </div>
      )}

      {/* Error */}
      {errorMsg && (
        <div
          className="rounded-xl border px-3 py-2 text-xs"
          style={{ borderColor: "#ef444455", backgroundColor: "#ef44441a", color: "#ef4444" }}
        >
          {errorMsg}
        </div>
      )}

      {/* Run button — large, sticky-feeling */}
      <button
        onClick={onSearch}
        disabled={!query.trim() || blockedByQuota}
        className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-base font-bold shadow-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.99]"
        style={{
          backgroundColor: "var(--ats-fg-accent)",
          color:           "#ffffff",
        }}
      >
        {fastMode ? <Zap size={18} /> : <FlaskConical size={18} />}
        <span>{blockedByQuota ? "Sign in for unlimited search" : (fastMode ? "Quick Search" : "Curated Analysis")}</span>
      </button>

      {/* Soft-pointer to desktop for advanced features */}
      <div className="rounded-xl border border-dashed px-3 py-2.5 text-[11px] leading-relaxed"
        style={{ borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-muted)" }}
      >
        Need the writing Lab, charts, or evidence chain? Open AcademiCats on a laptop or desktop browser for the full toolkit.
      </div>
    </div>
  );
}

function ModeChip({
  active, onClick, icon, label, tagline,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tagline: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-xl py-2.5 transition-colors"
      style={{
        backgroundColor: active ? "var(--ats-fg-accent)" : "transparent",
        color:           active ? "#ffffff" : "var(--ats-fg-secondary)",
      }}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-sm font-bold">{label}</span>
      </div>
      <span className="text-[10px] opacity-80">{tagline}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ResultsScreen — papers list + brief tab
// ─────────────────────────────────────────────────────────────────────────────

function ResultsScreen({
  status, progress, statusMsg, errorMsg, papers, brief, query, fastMode, onStop,
}: {
  status: SearchStatus;
  progress: number;
  statusMsg: string;
  errorMsg: string;
  papers: Paper[];
  brief: string;
  query: string;
  fastMode: boolean;
  onStop: () => void;
}) {
  const [view, setView] = useState<"papers" | "brief">("papers");

  // Note: we used to auto-flip the active tab when papers arrived, but that
  // ripped the user out of the Brief view if they switched to it during
  // streaming. The initial state already defaults to "papers"; respect any
  // manual switch from there.

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Query echo */}
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider font-bold" style={{ color: "var(--ats-fg-muted)" }}>
          {fastMode ? "Quick Search" : "Curated Analysis"}
        </div>
        <h2 className="text-base font-semibold leading-snug break-words" style={{ color: "var(--ats-fg-primary)" }}>
          {query || "—"}
        </h2>
      </div>

      {/* Progress / status */}
      {status === "running" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span style={{ color: "var(--ats-fg-secondary)" }}>{statusMsg || "Working…"}</span>
            <span className="tabular-nums font-semibold" style={{ color: "var(--ats-fg-accent)" }}>
              {progress}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--ats-border-subtle)" }}>
            <div
              className="h-full transition-all duration-300"
              style={{ width: `${progress}%`, backgroundColor: "var(--ats-fg-accent)" }}
            />
          </div>
          <button
            onClick={onStop}
            className="w-full rounded-xl border py-2 text-xs font-semibold"
            style={{
              borderColor:     "#ef444455",
              backgroundColor: "#ef44441a",
              color:           "#ef4444",
            }}
          >
            Stop
          </button>
        </div>
      )}

      {status === "error" && errorMsg && (
        <div
          className="rounded-xl border px-3 py-3 text-sm"
          style={{ borderColor: "#ef444455", backgroundColor: "#ef44441a", color: "#ef4444" }}
        >
          {errorMsg}
        </div>
      )}

      {status === "idle" && papers.length === 0 && !brief && (
        <div
          className="rounded-xl border border-dashed px-4 py-8 text-center text-sm"
          style={{ borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-muted)" }}
        >
          No results yet. Run a search from the Search tab.
        </div>
      )}

      {/* View switch — only shown when at least one of the views has content */}
      {(papers.length > 0 || brief) && (
        <div
          className="grid grid-cols-2 gap-1 rounded-xl p-1 border"
          style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}
        >
          <button
            onClick={() => setView("papers")}
            className="rounded-lg py-2 text-sm font-semibold transition-colors"
            style={{
              backgroundColor: view === "papers" ? "var(--ats-fg-accent)" : "transparent",
              color:           view === "papers" ? "#ffffff" : "var(--ats-fg-secondary)",
            }}
          >
            Papers · {papers.length}
          </button>
          <button
            onClick={() => setView("brief")}
            disabled={!brief && status !== "running"}
            className="rounded-lg py-2 text-sm font-semibold transition-colors disabled:opacity-40"
            style={{
              backgroundColor: view === "brief" ? "var(--ats-fg-accent)" : "transparent",
              color:           view === "brief" ? "#ffffff" : "var(--ats-fg-secondary)",
            }}
          >
            Brief
          </button>
        </div>
      )}

      {/* Papers view */}
      {view === "papers" && papers.length > 0 && (
        <div className="space-y-3">
          {papers.map((p, i) => <PaperCard key={i} paper={p} index={i} />)}
        </div>
      )}

      {/* Brief view */}
      {view === "brief" && (
        <div
          className="rounded-xl border p-4 prose prose-invert max-w-none break-words
            prose-p:text-sm prose-p:leading-7 prose-p:my-2
            prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
            prose-h1:text-base prose-h2:text-base prose-h3:text-sm
            prose-strong:font-semibold
            prose-ul:my-2 prose-ol:my-2 prose-ul:pl-5 prose-ol:pl-5
            prose-li:text-sm prose-li:leading-6 prose-li:my-0.5"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-primary)",
          }}
        >
          {brief
            ? <ReactMarkdown>{brief}</ReactMarkdown>
            : <div className="text-sm" style={{ color: "var(--ats-fg-muted)" }}>
                {status === "running" ? "Drafting brief…" : "No brief yet."}
              </div>
          }
        </div>
      )}
    </div>
  );
}

function PaperCard({ paper, index }: { paper: Paper; index: number }) {
  const score = useMemo(() => {
    const v = paper.evidence_score ?? paper.score;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }, [paper]);

  const tier = useMemo(() => {
    if (score === null) return null;
    if (score >= 75) return { label: "Strong", color: "#10b981" };
    if (score >= 65) return { label: "Good",   color: "#3b82f6" };
    if (score >= 40) return { label: "Moderate", color: "#f59e0b" };
    return { label: "Weak", color: "#ef4444" };
  }, [score]);

  const url = paper.url || paper.oa_url || paper.pdf_url;

  return (
    <article
      className="rounded-xl border p-3.5 space-y-2"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-panel)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-bold tabular-nums shrink-0" style={{ color: "var(--ats-fg-muted)" }}>
          {String(index + 1).padStart(2, "0")}
        </span>
        {tier && (
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums"
            style={{
              backgroundColor: `${tier.color}1a`,
              color: tier.color,
              border: `1px solid ${tier.color}55`,
            }}
          >
            {tier.label} · {score}
          </span>
        )}
      </div>
      <h3 className="text-sm font-semibold leading-snug break-words" style={{ color: "var(--ats-fg-primary)" }}>
        {paper.title}
      </h3>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>
        {paper.authors && <span className="line-clamp-1">{paper.authors}</span>}
        {paper.year && <span>· {paper.year}</span>}
        {paper.source && <span>· {paper.source}</span>}
        {paper.is_oa && <span className="font-semibold" style={{ color: "#10b981" }}>· OA</span>}
      </div>
      {paper.summary && (
        <p className="text-xs leading-relaxed line-clamp-3" style={{ color: "var(--ats-fg-secondary)" }}>
          {paper.summary}
        </p>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-accent-soft)",
            color:           "var(--ats-fg-accent)",
          }}
        >
          Open paper <ExternalLink size={12} />
        </a>
      )}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HistoryScreen — list of past searches as cards
// ─────────────────────────────────────────────────────────────────────────────

function HistoryScreen({
  items, loading, onRestore, onRefresh,
}: {
  items: HistoryItem[];
  loading: boolean;
  onRestore: (item: HistoryItem) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="px-4 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold">History</h2>
        <button
          onClick={onRefresh}
          className="flex items-center gap-1 text-xs"
          style={{ color: "var(--ats-fg-muted)" }}
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {loading && (
        <div className="text-xs" style={{ color: "var(--ats-fg-muted)" }}>Loading…</div>
      )}

      {!loading && items.length === 0 && (
        <div
          className="rounded-xl border border-dashed px-4 py-8 text-center text-sm"
          style={{ borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-muted)" }}
        >
          No history yet. Run a search to start a timeline.
        </div>
      )}

      {!loading && items.map(item => {
        const d = new Date(item.updated_at);
        return (
          <button
            key={item.id}
            onClick={() => onRestore(item)}
            className="block w-full rounded-xl border p-3.5 text-left transition-colors active:scale-[0.99]"
            style={{
              borderColor:     "var(--ats-border-subtle)",
              backgroundColor: "var(--ats-bg-panel)",
            }}
          >
            <div className="flex items-start justify-between gap-2 mb-1">
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold"
                style={{
                  backgroundColor: item.isFast ? "#10b9811a" : "#f59e0b1a",
                  color:           item.isFast ? "#10b981"   : "#f59e0b",
                }}
              >
                {item.isFast ? "Quick" : "Curated"}
              </span>
              <span className="text-[10px] tabular-nums" style={{ color: "var(--ats-fg-muted)" }}>
                {d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <p className="text-sm font-semibold leading-snug line-clamp-2 break-words" style={{ color: "var(--ats-fg-primary)" }}>
              {item.title}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProfileScreen — account info + theme toggle + sign-out
// ─────────────────────────────────────────────────────────────────────────────

function ProfileScreen({
  user, isGuest, quickRemaining, curatedRemaining,
  themeMode, onToggleTheme, onSignOut, onGoogleLogin,
}: {
  user: AuthUser;
  isGuest: boolean;
  quickRemaining: number;
  curatedRemaining: number;
  themeMode: "day" | "night";
  onToggleTheme: () => void;
  onSignOut: () => void;
  onGoogleLogin: () => void;
}) {
  const shortGuestId = useMemo(() => {
    if (!isGuest || !user.id) return "";
    const head = String(user.id).split("-")[0] || "";
    return head ? `G-${head.toUpperCase()}` : "";
  }, [isGuest, user.id]);

  return (
    <div className="px-4 py-4 space-y-4">
      <h2 className="text-base font-bold">Profile</h2>

      {/* User card */}
      <div
        className="rounded-xl border p-4 space-y-2"
        style={{
          borderColor:     "var(--ats-border-subtle)",
          backgroundColor: "var(--ats-bg-panel)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="h-10 w-10 rounded-full flex items-center justify-center text-base font-bold"
            style={{
              backgroundColor: "var(--ats-fg-accent)",
              color:           "#ffffff",
            }}
          >
            {(user.email?.[0] ?? (isGuest ? "G" : "?")).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            {isGuest ? (
              <>
                <p className="text-sm font-semibold">Guest session</p>
                <p className="text-[11px] tabular-nums font-mono" style={{ color: "var(--ats-fg-muted)" }}>
                  {shortGuestId}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold truncate">{user.email}</p>
                <p className="text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>Signed in</p>
              </>
            )}
          </div>
        </div>

        {isGuest && (
          <div className="text-xs leading-relaxed pt-2 border-t" style={{ borderColor: "var(--ats-border-subtle)", color: "var(--ats-fg-secondary)" }}>
            <p>Guest searches: {quickRemaining}Q · {curatedRemaining}C left</p>
            <button
              onClick={onGoogleLogin}
              className="mt-2 w-full inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
              style={{
                borderColor:     "var(--ats-border-accent)",
                backgroundColor: "var(--ats-bg-accent-soft)",
                color:           "var(--ats-fg-accent)",
              }}
            >
              Sign in to keep your work
            </button>
          </div>
        )}
      </div>

      {/* Theme */}
      <SettingsRow
        icon={themeMode === "night" ? <Sun size={18} /> : <Moon size={18} />}
        label={themeMode === "night" ? "Switch to Day mode" : "Switch to Night mode"}
        onClick={onToggleTheme}
      />

      {/* Feedback link (mailto) */}
      <SettingsRow
        icon={<Send size={18} />}
        label="Send feedback"
        href="mailto:jy1529098645@gmail.com?subject=AcademiCats%20feedback"
      />

      {/* Sign out */}
      <button
        onClick={onSignOut}
        className="w-full flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors"
        style={{
          borderColor:     "#ef444455",
          backgroundColor: "#ef44441a",
          color:           "#ef4444",
        }}
      >
        <LogOut size={16} /> Sign out
      </button>

      <p className="text-[10px] text-center pt-2" style={{ color: "var(--ats-fg-muted)" }}>
        AcademiCats {APP_VERSION} · Mobile UI
      </p>
    </div>
  );
}

function SettingsRow({
  icon, label, onClick, href,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
}) {
  const className = "w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold text-left transition-colors";
  const style = {
    borderColor:     "var(--ats-border-subtle)",
    backgroundColor: "var(--ats-bg-panel)",
    color:           "var(--ats-fg-primary)",
  } as React.CSSProperties;
  const content = (
    <>
      <span style={{ color: "var(--ats-fg-accent)" }}>{icon}</span>
      <span className="flex-1">{label}</span>
    </>
  );
  if (href) {
    return <a href={href} className={className} style={style}>{content}</a>;
  }
  return <button onClick={onClick} className={className} style={style}>{content}</button>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sign-in gate — shown when authUser is null
// ─────────────────────────────────────────────────────────────────────────────

function SignInGate({
  onGoogle, onGuest, guestBusy,
  themeMode, onToggleTheme,
}: {
  onGoogle: () => void;
  onGuest: () => void;
  guestBusy: boolean;
  themeMode: "day" | "night";
  onToggleTheme: () => void;
}) {
  return (
    <div
      className="min-h-[100dvh] flex flex-col"
      style={{ backgroundColor: "var(--ats-bg-base)", color: "var(--ats-fg-primary)" }}
    >
      <header className="flex items-center justify-end px-4 py-3">
        <button
          onClick={onToggleTheme}
          aria-label={themeMode === "night" ? "Switch to day theme" : "Switch to night theme"}
          className="flex h-9 w-9 items-center justify-center rounded-full border transition-colors"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-accent-soft)",
            color:           "var(--ats-fg-accent)",
          }}
        >
          {themeMode === "night" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/Cats_01.png" alt="" className="h-20 w-20 mb-4" draggable={false} />
        <h1 className="text-2xl font-bold mb-1">
          <span style={{ color: "var(--ats-fg-primary)" }}>Academi</span>
          <span style={{ color: "var(--ats-fg-accent)" }}>Cats</span>
        </h1>
        <p className="text-sm mb-8" style={{ color: "var(--ats-fg-muted)" }}>
          An academic search assistant for structuring and verifying thought.
        </p>

        <div className="w-full max-w-sm space-y-3">
          <button
            onClick={onGoogle}
            className="w-full flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors"
            style={{
              borderColor:     "var(--ats-border-subtle)",
              backgroundColor: "var(--ats-bg-panel)",
              color:           "var(--ats-fg-primary)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
              <path d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 20-9 20-20 0-1.2-.1-2.4-.4-3.5z" fill="#FFC107"/>
              <path d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" fill="#FF3D00"/>
              <path d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.6 34.9 26.9 36 24 36c-5.3 0-9.7-3.4-11.3-8H6.1C9.4 35.6 16.2 44 24 44z" fill="#4CAF50"/>
              <path d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.5 5.5C41.7 36.2 44 30.5 44 24c0-1.2-.1-2.4-.4-3.5z" fill="#1976D2"/>
            </svg>
            Continue with Google
          </button>

          <div className="flex items-center gap-2" style={{ color: "var(--ats-fg-muted)" }}>
            <div className="flex-1 h-px" style={{ backgroundColor: "var(--ats-border-subtle)" }} />
            <span className="text-[10px] uppercase tracking-wider">or</span>
            <div className="flex-1 h-px" style={{ backgroundColor: "var(--ats-border-subtle)" }} />
          </div>

          <button
            onClick={onGuest}
            disabled={guestBusy}
            className="w-full rounded-xl border px-4 py-3 text-sm font-medium transition-colors disabled:opacity-50"
            style={{
              borderColor:     "var(--ats-border-subtle)",
              backgroundColor: "transparent",
              color:           "var(--ats-fg-secondary)",
            }}
          >
            {guestBusy
              ? "Starting guest session…"
              : `Try as guest · ${GUEST_QUICK_MAX} Quick + ${GUEST_CURATED_MAX} Curated`}
          </button>
        </div>

        <p className="mt-8 text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
          {APP_VERSION}
        </p>
      </main>
    </div>
  );
}
