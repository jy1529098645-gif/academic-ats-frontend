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
  Search, ListOrdered, User as UserIcon,
  Zap, FlaskConical, LogOut, Sun, Moon,
  ExternalLink, RefreshCw, Send,
  PenLine, ClipboardList, ChevronDown,
} from "lucide-react";

import { supabase } from "@/lib/supabase/client";
import { fetchWithApiFallback, getAuthToken } from "@/lib/api";
import { useThemeStore } from "@/lib/stores/theme-store";
import { useGuestQuotaStore, GUEST_QUICK_MAX, GUEST_CURATED_MAX } from "@/lib/stores/guest-quota-store";
import { APP_VERSION } from "@/lib/tos-content";
import { labFieldSpec } from "@/lib/lab-fields";
import { PaperCharts } from "@/app/charts";
import { WORKSPACE_PLACEHOLDERS } from "@/lib/workspace-placeholders";
import { useRecommendedTerms } from "@/lib/hooks/use-recommended-terms";

// ─────────────────────────────────────────────────────────────────────────────
// Types — minimal, mobile-only. Doesn't import the desktop's Paper / Job
// shapes to keep this file self-contained; SSE fields are read by name and
// type-checked at use-site.
// ─────────────────────────────────────────────────────────────────────────────

type Tab = "home" | "results" | "lab" | "review" | "profile";

// Section metadata used by both the Drawer (slide-out left nav) and any
// section-aware logic. Single source of truth so adding a new section means
// editing one array, not three.
type SectionMeta = {
  id: Tab;
  label: string;
  blurb: string;        // one-line description shown inside the drawer row
  icon: React.ReactNode;
  hideUntilResults?: boolean; // Results — only show once the user has run
};

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
  // The bottom TabBar drives section navigation. Six tabs is the upper end
  // for a comfortable phone layout, but Results is conditional (only visible
  // once the user has run a search), so the bar shows 5 most of the time
  // and grows to 6 after the first search — both densities tap-tested.
  const [tab, setTab] = useState<Tab>("home");

  // ── Search state ────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [fastMode, setFastMode] = useState(true); // true = Quick, false = Curated
  // User-tunable result-set size. Desktop has separate Quick / Curated counts
  // and a 3–500 range; mobile collapses that to a single value with a chip
  // strip of presets (20 / 50 / 100 / 200) plus a custom number entry. 50 is
  // the default — matches desktop's Quick default and is a comfortable
  // "single-screen" depth on a phone.
  const [paperCount, setPaperCount] = useState<number>(50);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [brief, setBrief] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Sort the paper list by evidence/relevance score descending. The backend
  // returns them sorted, but during streaming partial batches arrive in
  // source-of-arrival order, and `setPapers` from history restoration may
  // also bypass the backend sort. Sorting here in a useMemo guarantees a
  // consistent ordering for both the Results list and the Charts panel.
  const sortedPapers = useMemo(() => {
    const toNum = (v: unknown): number => {
      if (v == null) return 0;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return [...papers].sort(
      (a, b) => toNum(b.evidence_score ?? b.score) - toNum(a.evidence_score ?? a.score),
    );
  }, [papers]);

  // (History was removed from mobile per product decision — no server fetch
  // is required and the History tab is gone from the bottom bar. The server
  // still records search runs for desktop access; mobile just doesn't
  // surface them.)

  // ── Synthesis Lab state ─────────────────────────────────────────────────
  // Mobile keeps Lab streamlined: pick an output type, type a topic, hit Run.
  // No multi-extras editor, no model picker, no points list — those live on
  // desktop. The backend accepts an empty extras object and falls back to
  // sensible defaults. Result streams into `labResult` as Markdown.
  const [labOutputType, setLabOutputType] = useState<string>("synthesis");
  const [labCoreArg, setLabCoreArg] = useState<string>("");
  const [labResult, setLabResult] = useState<string>("");
  const [labStatus, setLabStatus] = useState<string>("");
  const [labGenerating, setLabGenerating] = useState<boolean>(false);
  const [labError, setLabError] = useState<string>("");
  const labAbortRef = useRef<AbortController | null>(null);

  const runLab = useCallback(async () => {
    if (labGenerating) return;
    if (!labCoreArg.trim()) {
      setLabError("Please describe what you want to write about.");
      return;
    }
    const ac = new AbortController();
    labAbortRef.current = ac;
    setLabGenerating(true);
    setLabResult("");
    setLabStatus("Starting…");
    setLabError("");
    try {
      const token = await getAuthToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetchWithApiFallback("/api/forge/synthesize", {
        method: "POST",
        headers,
        signal: ac.signal,
        body: JSON.stringify({
          papers: [],
          core_argument: labCoreArg.trim(),
          supporting_points: [],
          extras: {},
          output_type: labOutputType,
          citation_format: "APA",
          language: "English",
          target_pages: 2,
          writing_model: "gpt-5.3",
        }),
      });
      if (!res.ok) {
        if (res.status === 429) setLabError("Daily quota reached. Sign in for more headroom.");
        else setLabError(`Synthesis failed: ${res.status}`);
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break outer;
          try {
            const obj = JSON.parse(payload) as Record<string, string>;
            if (obj.chunk) setLabResult(prev => prev + obj.chunk);
            if (obj.error) setLabError(obj.error);
            if (obj.status) setLabStatus(obj.status);
          } catch { /* malformed line */ }
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        setLabError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLabGenerating(false);
      setLabStatus("");
      labAbortRef.current = null;
    }
  }, [labCoreArg, labOutputType, labGenerating]);

  const stopLab = useCallback(() => {
    labAbortRef.current?.abort();
    labAbortRef.current = null;
    setLabGenerating(false);
  }, []);

  // ── Paper Review state ──────────────────────────────────────────────────
  type DraftLevel = "final" | "working" | "sketch";
  const [reviewText, setReviewText] = useState<string>("");
  const [reviewDraftLevel, setReviewDraftLevel] = useState<DraftLevel>("working");
  const [reviewResult, setReviewResult] = useState<string>("");
  const [reviewStatus, setReviewStatus] = useState<string>("");
  const [reviewGenerating, setReviewGenerating] = useState<boolean>(false);
  const [reviewError, setReviewError] = useState<string>("");
  const reviewAbortRef = useRef<AbortController | null>(null);

  const runReview = useCallback(async () => {
    if (reviewGenerating) return;
    const text = reviewText.trim();
    if (text.length < 200) {
      setReviewError("Paste at least a few paragraphs (≥ 200 chars) for a meaningful review.");
      return;
    }
    const ac = new AbortController();
    reviewAbortRef.current = ac;
    setReviewGenerating(true);
    setReviewResult("");
    setReviewStatus("Starting review…");
    setReviewError("");
    try {
      const token = await getAuthToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetchWithApiFallback("/api/forge/review-paper", {
        method: "POST",
        headers,
        signal: ac.signal,
        body: JSON.stringify({
          paper_text: text,
          context_hint: "",
          language: "English",
          draft_level: reviewDraftLevel,
        }),
      });
      if (!res.ok) {
        if (res.status === 429) setReviewError("Daily quota reached. Sign in for more headroom.");
        else setReviewError(`Review failed: ${res.status}`);
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break outer;
          try {
            const obj = JSON.parse(payload) as Record<string, string>;
            if (obj.chunk) setReviewResult(prev => prev + obj.chunk);
            if (obj.error) setReviewError(obj.error);
            if (obj.status) setReviewStatus(obj.status);
          } catch { /* malformed line */ }
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        setReviewError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setReviewGenerating(false);
      setReviewStatus("");
      reviewAbortRef.current = null;
    }
  }, [reviewText, reviewDraftLevel, reviewGenerating]);

  const stopReview = useCallback(() => {
    reviewAbortRef.current?.abort();
    reviewAbortRef.current = null;
    setReviewGenerating(false);
  }, []);

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
          paper_count: paperCount,
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
  }, [query, fastMode, paperCount, searchStatus, authUser, isGuest, guestQuickRemaining, guestCuratedRemaining]);

  // Live ref for the SSE consumer's "did we end cleanly?" check above.
  const searchStatusRef = useRef<SearchStatus>("idle");
  useEffect(() => { searchStatusRef.current = searchStatus; }, [searchStatus]);

  const stopSearch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSearchStatus("idle");
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

  // ── Section catalogue — single source of truth for the Drawer ─────────
  const hasResults = searchStatus !== "idle" || papers.length > 0;
  const sections: SectionMeta[] = [
    { id: "home",     label: "Search",         blurb: "Find papers across 9 sources",     icon: <Search size={22} /> },
    { id: "results",  label: "Results",        blurb: "Papers + research brief",          icon: <ListOrdered size={22} />, hideUntilResults: true },
    { id: "lab",      label: "Synthesis Lab",  blurb: "Draft writing from your input",    icon: <PenLine size={22} /> },
    { id: "review",   label: "Paper Review",   blurb: "Multi-agent feedback on a draft",  icon: <ClipboardList size={22} /> },
    { id: "profile",  label: "Profile",        blurb: "Account, theme, sign out",         icon: <UserIcon size={22} /> },
  ];
  const activeSection = sections.find(s => s.id === tab) ?? sections[0];

  return (
    <div
      className="min-h-[100dvh] flex flex-col"
      style={{ backgroundColor: "var(--ats-bg-base)", color: "var(--ats-fg-primary)" }}
    >
      <Header
        themeMode={themeMode}
        onToggleTheme={() => setThemeMode(m => m === "day" ? "night" : "day")}
        sectionLabel={activeSection.label}
      />

      {/* Bottom-padded so the last screen content can scroll above the
          fixed-position TabBar without hiding behind it. 5.5 rem = bar
          height (~3.5 rem) + safe-area-inset breathing room. */}
      <main className="flex-1 min-h-0 overflow-y-auto pb-[5.5rem]">
        {tab === "home" && (
          <HomeScreen
            query={query}
            setQuery={setQuery}
            fastMode={fastMode}
            setFastMode={setFastMode}
            paperCount={paperCount}
            setPaperCount={setPaperCount}
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
            papers={sortedPapers}
            brief={brief}
            query={query}
            fastMode={fastMode}
            onStop={stopSearch}
          />
        )}
        {tab === "lab" && (
          <LabScreen
            outputType={labOutputType}
            setOutputType={setLabOutputType}
            coreArg={labCoreArg}
            setCoreArg={setLabCoreArg}
            generating={labGenerating}
            status={labStatus}
            result={labResult}
            errorMsg={labError}
            onRun={() => void runLab()}
            onStop={stopLab}
          />
        )}
        {tab === "review" && (
          <ReviewScreen
            text={reviewText}
            setText={setReviewText}
            draftLevel={reviewDraftLevel}
            setDraftLevel={setReviewDraftLevel}
            generating={reviewGenerating}
            status={reviewStatus}
            result={reviewResult}
            errorMsg={reviewError}
            onRun={() => void runReview()}
            onStop={stopReview}
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
        sections={sections}
        active={tab}
        hasResults={hasResults}
        onPick={setTab}
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
  sectionLabel,
}: {
  themeMode: "day" | "night";
  onToggleTheme: () => void;
  sectionLabel: string;
}) {
  // Header is now anchor-only — no hamburger because the bottom TabBar owns
  // section nav. Layout: [logo + wordmark + current section] [theme toggle].
  // The theme toggle stays h-11 to clear the WCAG / Apple HIG 44 px tap
  // floor; the rest of the header is informational, no tap target needed.
  return (
    <header
      className="shrink-0 flex items-center justify-between gap-2 px-4 py-2.5 border-b"
      style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}
    >
      <div className="flex flex-1 min-w-0 items-center gap-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/Cats_01.png" alt="" className="h-9 w-9 shrink-0" draggable={false} />
        <div className="min-w-0 leading-tight">
          <div className="text-[17px] font-bold truncate">
            <span style={{ color: "var(--ats-fg-primary)" }}>Academi</span>
            <span style={{ color: "var(--ats-fg-accent)" }}>Cats</span>
          </div>
          <div
            className="text-[11px] font-semibold truncate"
            style={{ color: "var(--ats-fg-muted)" }}
          >
            {sectionLabel}
          </div>
        </div>
      </div>

      <button
        onClick={onToggleTheme}
        aria-label={themeMode === "night" ? "Switch to day theme" : "Switch to night theme"}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-colors active:scale-95"
        style={{
          borderColor:     "var(--ats-border-subtle)",
          backgroundColor: "var(--ats-bg-accent-soft)",
          color:           "var(--ats-fg-accent)",
        }}
      >
        {themeMode === "night" ? <Sun size={20} /> : <Moon size={20} />}
      </button>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TabBar — fixed bottom navigation
//
// Six section entries (Search / Results / Lab / Review / History / Profile)
// rendered as equal-flex columns. Results is hidden until the user has run
// at least one search, so the bar shows 5 tabs in the first session and
// grows to 6 afterwards. We render icon + tiny label per tab so users can
// scan the bar without memorising icon meanings; the active tab gets the
// accent colour plus a slim top accent line for redundancy.
//
// Why a bottom bar instead of the previous left drawer: the drawer was a
// fine fit for many sections, but added a click of friction to switch
// surfaces. The user's workflow on mobile bounces between Search,
// Results, and Profile constantly — a permanent bar at the thumb zone
// matches that better. Six tabs fits comfortably on phones ≥ 360 px wide
// (each tab gets ~60 px, room for icon + 9-px label).
// ─────────────────────────────────────────────────────────────────────────────

function TabBar({
  sections,
  active,
  hasResults,
  onPick,
}: {
  sections: SectionMeta[];
  active: Tab;
  hasResults: boolean;
  onPick: (id: Tab) => void;
}) {
  // Results is suppressed pre-search — no point showing a tab the user
  // can't tap. Keeping the section catalogue intact and filtering at
  // render time means we don't have to special-case the metadata when
  // the search runs.
  const visible = sections.filter(s => !(s.hideUntilResults && !hasResults));
  return (
    <nav
      role="navigation"
      aria-label="Section navigation"
      className="fixed bottom-0 inset-x-0 z-30 flex items-stretch border-t"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-panel)",
        paddingBottom:   "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {visible.map(sec => {
        const isActive = sec.id === active;
        return (
          <button
            key={sec.id}
            onClick={() => onPick(sec.id)}
            aria-current={isActive ? "page" : undefined}
            aria-label={sec.label}
            className="relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors active:scale-[0.97]"
            style={{
              color: isActive ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
              minHeight: "60px",
            }}
          >
            {/* Active-state accent line — 2 px high, 28 px wide, anchored
                to the top edge so it reads as a "currently here" stripe
                without crowding the icon below. */}
            {isActive && (
              <span
                className="absolute top-0 h-0.5 w-7 rounded-b-full"
                style={{ backgroundColor: "var(--ats-fg-accent)" }}
                aria-hidden
              />
            )}
            {sec.icon}
            <span className="text-[10px] font-semibold tracking-wide leading-none">
              {sec.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HomeScreen — landing surface, modeled on the desktop hero.
//
// The desktop landing centres a "AcademiCats" wordmark + cat mascot, an
// italic rotating sprite line from WORKSPACE_PLACEHOLDERS, the search
// textarea, Quick / Curated mode bubbles, and a chip strip of recommended
// terms (pulled daily from /api/workspace/recommended-terms). The mobile
// version preserves the same elements and reading rhythm, but vertically
// stacked and tuned for thumb interaction.
//
// Layout (top → bottom):
//   1. Mascot (h-20) + "AcademiCats" wordmark, centered
//   2. Italic rotating placeholder — same WORKSPACE_PLACEHOLDERS strings
//      desktop uses, cycling on a 7-second interval. Acts as the sprite
//      voice line.
//   3. Search textarea — translucent panel-style, big text, tap target ≥ 64
//      px
//   4. Mode picker (Quick / Curated) — pill bubbles in the desktop sprite
//      style
//   5. Run button — full-width, accent-coloured CTA
//   6. Recommended terms — horizontal scrolling chip strip pulling from the
//      same /api/workspace/recommended-terms feed as desktop. Tap fills the
//      textarea.
//   7. Guest quota / error banners (only when relevant)
//
// Why this redesign vs the previous one: the original mobile home was a
// vanilla "label + textarea + mode picker + button" stack. It worked but
// didn't carry the brand. Mirroring the desktop hero on mobile makes the
// surface feel like the same product, just resized for one hand.

function HomeScreen({
  query, setQuery, fastMode, setFastMode, paperCount, setPaperCount,
  onSearch, errorMsg,
  isGuest, quickRemaining, curatedRemaining,
}: {
  query: string;
  setQuery: (s: string) => void;
  fastMode: boolean;
  setFastMode: (b: boolean) => void;
  paperCount: number;
  setPaperCount: (n: number) => void;
  onSearch: () => void;
  errorMsg: string;
  isGuest: boolean;
  quickRemaining: number;
  curatedRemaining: number;
}) {
  const remaining = fastMode ? quickRemaining : curatedRemaining;
  const blockedByQuota = isGuest && remaining <= 0;

  // Daily-rotating chip strip — same hook the desktop uses.
  const { terms: recommendedTerms } = useRecommendedTerms();

  // Rotating italic placeholder — picks a stable starting index per mount
  // (so the user doesn't see it always start at the same line) and
  // advances every 7 seconds. Pauses while the user has typed anything,
  // since changing the line beneath their input would feel restless.
  const [voiceIdx, setVoiceIdx] = useState(() =>
    Math.floor(Math.random() * WORKSPACE_PLACEHOLDERS.length),
  );
  useEffect(() => {
    if (query.trim().length > 0) return; // pause while user is composing
    const id = setInterval(() => {
      setVoiceIdx(i => (i + 1) % WORKSPACE_PLACEHOLDERS.length);
    }, 7000);
    return () => clearInterval(id);
  }, [query]);
  const voiceLine = WORKSPACE_PLACEHOLDERS[voiceIdx] ?? WORKSPACE_PLACEHOLDERS[0];

  // Show the chip strip only when the user hasn't typed anything yet — once
  // they're composing, the chips are noise.
  const showChips = query.trim().length === 0 && recommendedTerms.length > 0;

  return (
    <div className="px-4 pt-6 pb-10 space-y-5">
      {/* ── Hero: mascot + wordmark, centered ────────────────────────────── */}
      <header className="flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/Cats_01.png"
          alt="AcademiCats mascot"
          className="h-20 w-20 select-none pointer-events-none drop-shadow-md"
          draggable={false}
        />
        <div className="text-3xl font-black tracking-tight leading-none">
          <span style={{ color: "var(--ats-fg-primary)" }}>Academi</span>
          <span style={{ color: "var(--ats-fg-accent)" }}>Cats</span>
        </div>

        {/* Italic rotating sprite voice. Keyed on `voiceLine` so React
            reissues the element every rotation, retriggering the fade-in
            keyframe (.voice-fade is defined in globals.css alongside the
            desktop sprite).

            FIXED-HEIGHT slot — the placeholder pool ranges from short
            (~30 chars, 1 line on most phones) to long (~92 chars, 2–3
            lines on narrow devices). If we let the slot shrink/grow with
            the line, every rotation jolts everything below — textarea,
            mode picker, Run button — by 20+ px. We pin the height to
            5 rem (≈ 80 px ≈ 3 lines at 15-px italic / leading 1.45)
            and clamp the text to 3 lines so anything longer truncates
            instead of overflowing. Single-line slogans get vertically
            centred via `items-center` so the slot doesn't look empty. */}
        <div className="flex h-[5rem] w-full items-center justify-center px-2">
          <p
            key={voiceLine}
            className="voice-fade max-w-[28rem] text-center text-[15px] italic"
            style={{
              color:           "var(--ats-fg-accent)",
              display:         "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow:        "hidden",
              lineHeight:      1.45,
            }}
          >
            {voiceLine}
          </p>
        </div>
      </header>

      {/* ── Search input ────────────────────────────────────────────────── */}
      <section className="space-y-1.5">
        <textarea
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Type a research question, theme, or paper title…"
          rows={4}
          className="w-full rounded-2xl border px-4 py-3.5 text-[16px] leading-relaxed resize-y outline-none focus:ring-2 transition-shadow"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-primary)",
            minHeight:       "8rem",
          }}
        />
        {query.trim().length > 0 && (
          <div className="text-right text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            {query.trim().length} chars
          </div>
        )}
      </section>

      {/* ── Mode picker: Quick / Curated ────────────────────────────────── */}
      <section
        className="grid grid-cols-2 gap-1 rounded-2xl p-1 border"
        style={{
          borderColor:     "var(--ats-border-subtle)",
          backgroundColor: "var(--ats-bg-panel)",
        }}
      >
        <ModeChip
          active={fastMode}
          onClick={() => setFastMode(true)}
          icon={<Zap size={18} />}
          label="Quick"
          tagline="Scan at scale"
        />
        <ModeChip
          active={!fastMode}
          onClick={() => setFastMode(false)}
          icon={<FlaskConical size={18} />}
          label="Curated"
          tagline="High quality"
        />
      </section>

      {/* ── Paper-count picker ──────────────────────────────────────────── */}
      <PaperCountPicker count={paperCount} setCount={setPaperCount} />

      {/* ── Run button — primary CTA ─────────────────────────────────────── */}
      <button
        onClick={onSearch}
        disabled={!query.trim() || blockedByQuota}
        className="w-full flex items-center justify-center gap-2 rounded-2xl text-[17px] font-bold shadow-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.99]"
        style={{
          backgroundColor: "var(--ats-fg-accent)",
          color:           "#ffffff",
          minHeight:       "60px",
        }}
      >
        {fastMode ? <Zap size={20} /> : <FlaskConical size={20} />}
        <span>{blockedByQuota ? "Sign in for unlimited search" : (fastMode ? "Quick Search" : "Curated Analysis")}</span>
      </button>

      {/* ── Recommended chips — wrap to multiple rows ───────────────────
          Mirrors the desktop landing's chip strip. Tapping fills the
          textarea verbatim. Earlier this was a single-row horizontal
          scroller; users complained that off-screen chips were
          discoverable only by experimentation. Now we use flex-wrap
          so any chip that doesn't fit on the current line drops to the
          next — every term is visible at first paint. The home screen
          can grow taller as a result, but that's the natural cost of
          full discoverability and the layout below the chips
          (textarea + mode + Run) is already pinned to the page above. */}
      {showChips && (
        <section className="space-y-2">
          <div
            className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{ color: "var(--ats-fg-muted)" }}
          >
            <span
              className="sprite-dot-idle inline-block h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: "var(--ats-fg-accent)" }}
              aria-hidden
            />
            <span>Trending today</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {recommendedTerms.slice(0, 12).map(term => (
              <button
                key={term}
                onClick={() => setQuery(term)}
                className="rounded-full border px-4 py-2.5 text-[13px] font-medium transition-colors active:scale-[0.97]"
                style={{
                  borderColor:     "var(--ats-border-subtle)",
                  backgroundColor: "var(--ats-bg-panel)",
                  color:           "var(--ats-fg-primary)",
                  minHeight:       "44px",
                }}
              >
                {term}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Guest quota indicator ────────────────────────────────────────── */}
      {isGuest && (
        <div
          className="flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-xs"
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

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {errorMsg && (
        <div
          className="rounded-xl border px-3 py-2 text-xs"
          style={{ borderColor: "#ef444455", backgroundColor: "#ef44441a", color: "#ef4444" }}
        >
          {errorMsg}
        </div>
      )}

      {/* (Removed the menu hint — the bottom TabBar now makes Lab /
          Paper Review / History / Profile visible from any screen.) */}
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
      aria-pressed={active}
      className="flex flex-col items-center justify-center gap-1 rounded-xl transition-colors active:scale-[0.97]"
      style={{
        backgroundColor: active ? "var(--ats-fg-accent)" : "transparent",
        color:           active ? "#ffffff" : "var(--ats-fg-secondary)",
        minHeight:       "56px",
      }}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[15px] font-bold">{label}</span>
      </div>
      <span className="text-[11px] opacity-80">{tagline}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PaperCountPicker — choose how many papers the search returns.
//
// Four chips (20 / 50 / 100 / 200) cover the common cases with one tap;
// users who want a different number type into the "Custom" field, which
// accepts 3–500 (the same range the desktop allows). The custom input is
// only committed to state on blur or Enter so partial typing (e.g. "1"
// while heading toward "150") doesn't fire the search at the wrong size.
// ─────────────────────────────────────────────────────────────────────────────

const PAPER_COUNT_PRESETS = [20, 50, 100, 200] as const;
const PAPER_COUNT_MIN = 3;
const PAPER_COUNT_MAX = 500;

function clampPaperCount(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.max(PAPER_COUNT_MIN, Math.min(PAPER_COUNT_MAX, Math.round(n)));
}

function PaperCountPicker({
  count, setCount,
}: {
  count: number;
  setCount: (n: number) => void;
}) {
  // The custom-input is uncontrolled (`defaultValue`) and remounts via
  // `key={count}` whenever the parent value changes — that way tapping a
  // preset chip clears the custom field without us having to mirror state
  // through a useEffect. Commit happens on blur / Enter.
  const isPreset = (PAPER_COUNT_PRESETS as readonly number[]).includes(count);

  const commitCustom = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") return; // nothing typed — leave count as-is
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    setCount(clampPaperCount(n));
  };

  return (
    <section className="space-y-2">
      <div
        className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.14em]"
        style={{ color: "var(--ats-fg-muted)" }}
      >
        <span>Number of papers</span>
        <span className="tabular-nums" style={{ color: "var(--ats-fg-accent)" }}>
          {count}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {PAPER_COUNT_PRESETS.map(n => {
          const active = count === n;
          return (
            <button
              key={n}
              onClick={() => setCount(n)}
              aria-pressed={active}
              className="rounded-xl border text-[15px] font-bold transition-colors active:scale-[0.97]"
              style={{
                borderColor:     active ? "var(--ats-border-accent)"  : "var(--ats-border-subtle)",
                backgroundColor: active ? "var(--ats-bg-accent-soft)" : "var(--ats-bg-panel)",
                color:           active ? "var(--ats-fg-accent)"      : "var(--ats-fg-primary)",
                minHeight:       "48px",
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
      {/* Custom entry — accepts 3–500 */}
      <div
        className="flex items-center gap-2 rounded-xl border px-3"
        style={{
          borderColor:     !isPreset ? "var(--ats-border-accent)"  : "var(--ats-border-subtle)",
          backgroundColor: !isPreset ? "var(--ats-bg-accent-soft)" : "var(--ats-bg-input)",
          minHeight:       "48px",
        }}
      >
        <span className="text-[12px] font-semibold" style={{ color: "var(--ats-fg-muted)" }}>
          Custom
        </span>
        <input
          // Remount whenever the parent count changes (e.g. preset tap) so
          // the field reflects external value changes without controlled
          // state. Custom counts persist as the input's defaultValue.
          key={count}
          type="number"
          inputMode="numeric"
          min={PAPER_COUNT_MIN}
          max={PAPER_COUNT_MAX}
          defaultValue={isPreset ? "" : String(count)}
          onBlur={e => commitCustom(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } }}
          placeholder={`${PAPER_COUNT_MIN}–${PAPER_COUNT_MAX}`}
          className="flex-1 bg-transparent text-right text-[15px] font-bold outline-none tabular-nums"
          style={{ color: !isPreset ? "var(--ats-fg-accent)" : "var(--ats-fg-primary)" }}
        />
      </div>
    </section>
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
  const [view, setView] = useState<"papers" | "brief" | "charts">("papers");

  // Note: we used to auto-flip the active tab when papers arrived, but that
  // ripped the user out of the Brief view if they switched to it during
  // streaming. The initial state already defaults to "papers"; respect any
  // manual switch from there.

  // Charts only need a stable papers reference; the chart sub-trees are
  // already memoised. We coerce `year` (Paper allows string | number; the
  // chart's ChartPaper expects only string) and pass everything else
  // through — extras are ignored by the chart components. Charts render in
  // stacked mode on mobile (wide=false) so each chart gets the full
  // viewport width.
  const chartPapers = useMemo(
    () => papers.map(p => ({ ...p, year: p.year != null ? String(p.year) : undefined })),
    [papers],
  );

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

      {/* View switch — three tabs (Papers / Brief / Charts). Brief is the
          curated-analysis narrative; Charts is the desktop's analytics
          panel rendered in stacked mode for mobile. We show all three
          tabs the moment any view has content so the user can hop
          between them mid-stream without waiting. */}
      {(papers.length > 0 || brief) && (
        <div
          className="grid grid-cols-3 gap-1 rounded-xl p-1 border"
          style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}
        >
          <button
            onClick={() => setView("papers")}
            className="rounded-lg py-2.5 text-[13px] font-semibold transition-colors"
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
            className="rounded-lg py-2.5 text-[13px] font-semibold transition-colors disabled:opacity-40"
            style={{
              backgroundColor: view === "brief" ? "var(--ats-fg-accent)" : "transparent",
              color:           view === "brief" ? "#ffffff" : "var(--ats-fg-secondary)",
            }}
          >
            Brief
          </button>
          <button
            onClick={() => setView("charts")}
            disabled={papers.length === 0}
            className="rounded-lg py-2.5 text-[13px] font-semibold transition-colors disabled:opacity-40"
            style={{
              backgroundColor: view === "charts" ? "var(--ats-fg-accent)" : "transparent",
              color:           view === "charts" ? "#ffffff" : "var(--ats-fg-secondary)",
            }}
          >
            Charts
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

      {/* Charts view — three stacked SVG charts (Year / Bullseye / Source).
          Reuses the desktop PaperCharts component with wide=false so each
          chart spans the full mobile viewport width. The wrapper carries
          the same card styling as the Brief view so the surface feels
          coherent across tabs. */}
      {view === "charts" && (
        <div
          className="rounded-xl border p-3"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
          }}
        >
          {papers.length > 0 ? (
            <PaperCharts papers={chartPapers} wide={false} />
          ) : (
            <div className="px-2 py-8 text-center text-sm" style={{ color: "var(--ats-fg-muted)" }}>
              {status === "running" ? "Charts populate as papers arrive…" : "No papers to chart yet."}
            </div>
          )}
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
// LabScreen — Synthesis Lab, mobile-streamlined
//
// Desktop Lab has ~12 controls (output type, citation, language, points list,
// extras, writing model, target pages, etc.). On a phone that's a wall of
// fields nobody fills out. This trim keeps the three controls that materially
// change the output:
//   1. Output type — picks the prompt template
//   2. Topic / argument — the core context the writer expands from
//   3. Run / Stop
// Everything else falls back to sensible defaults on the backend (APA / English
// / 2 pages / gpt-5.3). Power users can still hit the desktop site for the
// full editor.
// ─────────────────────────────────────────────────────────────────────────────

const LAB_OUTPUT_TYPES: Array<{ id: string; label: string; blurb: string }> = [
  { id: "synthesis",            label: "Synthesis",          blurb: "General academic writing"             },
  { id: "literature_review",    label: "Literature Review",  blurb: "Themed map of existing research"     },
  { id: "personal_statement",   label: "Personal Statement", blurb: "For grad-school applications"         },
  { id: "sop",                  label: "Statement of Purpose", blurb: "Goals + research fit"               },
  { id: "resume",               label: "Resume / CV",        blurb: "Student academic CV"                  },
  { id: "abstract",             label: "Abstract",           blurb: "150–250 word summary"                 },
  { id: "theoretical_framework", label: "Theoretical Frame", blurb: "Model that explains a phenomenon"     },
];

function LabScreen({
  outputType, setOutputType,
  coreArg, setCoreArg,
  generating, status, result, errorMsg,
  onRun, onStop,
}: {
  outputType: string;
  setOutputType: (s: string) => void;
  coreArg: string;
  setCoreArg: (s: string) => void;
  generating: boolean;
  status: string;
  result: string;
  errorMsg: string;
  onRun: () => void;
  onStop: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const selected = LAB_OUTPUT_TYPES.find(t => t.id === outputType) ?? LAB_OUTPUT_TYPES[0];
  // Pull the core-field placeholder + label from the shared lab-fields spec
  // so the mobile copy stays in sync with desktop instead of drifting.
  const spec = useMemo(() => labFieldSpec(outputType), [outputType]);

  return (
    <div className="px-4 py-4 pb-24 space-y-5">
      {/* Output-type picker — large tap area, opens chip-grid below on tap */}
      <section className="space-y-2">
        <label className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--ats-fg-muted)" }}>
          Output type
        </label>
        <button
          onClick={() => setPickerOpen(o => !o)}
          className="flex w-full items-center justify-between rounded-xl border px-4 py-3.5 text-left transition-colors active:scale-[0.99]"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-input)",
            color:           "var(--ats-fg-primary)",
            minHeight:       "56px",
          }}
        >
          <span className="min-w-0 flex-1 pr-2">
            <span className="block text-[15px] font-semibold">{selected.label}</span>
            <span className="block truncate text-[11px] mt-0.5" style={{ color: "var(--ats-fg-muted)" }}>
              {selected.blurb}
            </span>
          </span>
          <ChevronDown
            size={20}
            style={{
              color: "var(--ats-fg-muted)",
              transform: pickerOpen ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.15s",
            }}
          />
        </button>
        {pickerOpen && (
          <div className="grid grid-cols-1 gap-2 pt-1">
            {LAB_OUTPUT_TYPES.map(t => {
              const active = t.id === outputType;
              return (
                <button
                  key={t.id}
                  onClick={() => { setOutputType(t.id); setPickerOpen(false); }}
                  className="flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors active:scale-[0.99]"
                  style={{
                    borderColor:     active ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                    backgroundColor: active ? "var(--ats-bg-accent-soft)" : "var(--ats-bg-panel)",
                    color:           active ? "var(--ats-fg-accent)"      : "var(--ats-fg-primary)",
                    minHeight:       "52px",
                  }}
                >
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold">{t.label}</span>
                    <span className="block truncate text-[11px] mt-0.5" style={{ color: active ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)" }}>
                      {t.blurb}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Core argument / topic */}
      <section className="space-y-2">
        <label className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--ats-fg-muted)" }}>
          {spec.coreLabel}
        </label>
        <p className="text-[12px]" style={{ color: "var(--ats-fg-muted)" }}>{spec.coreDescription}</p>
        <textarea
          value={coreArg}
          onChange={e => setCoreArg(e.target.value)}
          placeholder={spec.corePlaceholder}
          rows={6}
          className="w-full resize-none rounded-xl border px-4 py-3 text-[15px] leading-relaxed focus:outline-none"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-input)",
            color:           "var(--ats-fg-primary)",
          }}
        />
      </section>

      {/* Run / Stop button — full-width, 56-px tall */}
      <button
        onClick={generating ? onStop : onRun}
        disabled={!generating && !coreArg.trim()}
        className="flex w-full items-center justify-center gap-2 rounded-xl text-[16px] font-semibold transition-all disabled:opacity-40 active:scale-[0.99]"
        style={{
          backgroundColor: generating ? "var(--ats-bg-input)" : "var(--ats-fg-accent)",
          color:           generating ? "var(--ats-fg-primary)" : "var(--ats-bg-base)",
          minHeight:       "56px",
          border:          "1px solid var(--ats-border-subtle)",
        }}
      >
        {generating ? (
          <>
            <RefreshCw size={18} className="animate-spin" />
            <span>Stop</span>
          </>
        ) : (
          <>
            <PenLine size={18} />
            <span>Run synthesis</span>
          </>
        )}
      </button>

      {/* Status / error / result */}
      {(status || errorMsg) && (
        <div className="space-y-1 text-[12px]">
          {status && <div style={{ color: "var(--ats-fg-muted)" }}>{status}</div>}
          {errorMsg && <div style={{ color: "var(--ats-fg-error, #d33)" }}>{errorMsg}</div>}
        </div>
      )}
      {result && (
        <article
          className="rounded-xl border px-4 py-4 prose prose-sm max-w-none"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-primary)",
          }}
        >
          <ReactMarkdown>{result}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ReviewScreen — Paper Review, mobile-streamlined
//
// Mirrors the same prune as Lab: paste text, pick draft level, run. Status +
// streamed result come back as plain prose. Desktop has the rich agent log
// + structured issue cards; on mobile we render the streamed Markdown inline.
// ─────────────────────────────────────────────────────────────────────────────

const DRAFT_LEVELS: Array<{ id: "final" | "working" | "sketch"; label: string; blurb: string }> = [
  { id: "final",   label: "Final",   blurb: "Polished — strict review" },
  { id: "working", label: "Working", blurb: "Mid-stage — balanced"      },
  { id: "sketch",  label: "Sketch",  blurb: "Early draft — gentle"       },
];

function ReviewScreen({
  text, setText,
  draftLevel, setDraftLevel,
  generating, status, result, errorMsg,
  onRun, onStop,
}: {
  text: string;
  setText: (s: string) => void;
  draftLevel: "final" | "working" | "sketch";
  setDraftLevel: (s: "final" | "working" | "sketch") => void;
  generating: boolean;
  status: string;
  result: string;
  errorMsg: string;
  onRun: () => void;
  onStop: () => void;
}) {
  const charCount = text.length;
  return (
    <div className="px-4 py-4 pb-24 space-y-5">
      {/* Draft level chips — three big targets */}
      <section className="space-y-2">
        <label className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--ats-fg-muted)" }}>
          Draft stage
        </label>
        <p className="text-[12px]" style={{ color: "var(--ats-fg-muted)" }}>
          Calibrates how strict the reviewers are.
        </p>
        <div className="grid grid-cols-3 gap-2">
          {DRAFT_LEVELS.map(d => {
            const active = d.id === draftLevel;
            return (
              <button
                key={d.id}
                onClick={() => setDraftLevel(d.id)}
                className="flex flex-col items-center justify-center rounded-xl border px-2 py-3 transition-colors active:scale-[0.97]"
                style={{
                  borderColor:     active ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                  backgroundColor: active ? "var(--ats-bg-accent-soft)" : "var(--ats-bg-panel)",
                  color:           active ? "var(--ats-fg-accent)"      : "var(--ats-fg-primary)",
                  minHeight:       "64px",
                }}
                aria-pressed={active}
              >
                <span className="text-[14px] font-bold">{d.label}</span>
                <span
                  className="mt-0.5 text-[10px] leading-tight text-center"
                  style={{ color: active ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)" }}
                >
                  {d.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Paste text */}
      <section className="space-y-2">
        <div className="flex items-end justify-between">
          <label className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--ats-fg-muted)" }}>
            Paper text
          </label>
          <span className="text-[10px]" style={{ color: charCount < 200 ? "var(--ats-fg-error, #d33)" : "var(--ats-fg-muted)" }}>
            {charCount.toLocaleString()} chars
          </span>
        </div>
        <p className="text-[12px]" style={{ color: "var(--ats-fg-muted)" }}>
          Paste your draft. Minimum 200 characters.
        </p>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Paste the full text of your paper / draft here…"
          rows={12}
          className="w-full resize-none rounded-xl border px-4 py-3 text-[14px] leading-relaxed focus:outline-none"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-input)",
            color:           "var(--ats-fg-primary)",
          }}
        />
      </section>

      {/* Run / Stop */}
      <button
        onClick={generating ? onStop : onRun}
        disabled={!generating && charCount < 200}
        className="flex w-full items-center justify-center gap-2 rounded-xl text-[16px] font-semibold transition-all disabled:opacity-40 active:scale-[0.99]"
        style={{
          backgroundColor: generating ? "var(--ats-bg-input)" : "var(--ats-fg-accent)",
          color:           generating ? "var(--ats-fg-primary)" : "var(--ats-bg-base)",
          minHeight:       "56px",
          border:          "1px solid var(--ats-border-subtle)",
        }}
      >
        {generating ? (
          <>
            <RefreshCw size={18} className="animate-spin" />
            <span>Stop review</span>
          </>
        ) : (
          <>
            <ClipboardList size={18} />
            <span>Run review</span>
          </>
        )}
      </button>

      {(status || errorMsg) && (
        <div className="space-y-1 text-[12px]">
          {status && <div style={{ color: "var(--ats-fg-muted)" }}>{status}</div>}
          {errorMsg && <div style={{ color: "var(--ats-fg-error, #d33)" }}>{errorMsg}</div>}
        </div>
      )}
      {result && (
        <article
          className="rounded-xl border px-4 py-4 prose prose-sm max-w-none"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-primary)",
          }}
        >
          <ReactMarkdown>{result}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}

// (HistoryScreen removed — mobile no longer surfaces history per product
// decision. The desktop view still provides full history access.)

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
