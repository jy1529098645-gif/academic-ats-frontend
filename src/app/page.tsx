"use client";

import ReactMarkdown from "react-markdown";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PaperCharts } from "./charts";
import { supabase } from "@/lib/supabase/client";
import { WORKSPACE_PLACEHOLDERS } from "@/lib/workspace-placeholders";
import { Sprite, type SpriteHandle } from "@/components/sprite/Sprite";
import { labFieldSpec, labPointsPlaceholder } from "@/lib/lab-fields";
import { THEME_REGISTRY, themesByMode, type ThemeMode } from "@/lib/themes";
import { useThemeStore, hydrateThemeStore } from "@/lib/stores/theme-store";
import {
  usePrefsStore, hydratePrefsStore, applyServerWorkspaceCharLimit,
  ROTATOR_INTERVAL_MIN, ROTATOR_INTERVAL_MAX,
  THEME_TRANSITION_MIN, THEME_TRANSITION_MAX,
} from "@/lib/stores/prefs-store";
import {
  useUsagePromptStore, hydrateUsagePromptStore, shouldPromptFeedback,
} from "@/lib/stores/usage-prompt-store";
import TermsOfServiceGate from "@/components/TermsOfServiceGate";
import ErrorBoundary from "@/components/ErrorBoundary";
import UserNotificationPopup from "@/components/UserNotificationPopup";
import { useUserNotifications } from "@/lib/hooks/use-user-notifications";
import {
  useUsage,
  USAGE_FEATURE_LABELS,
  formatUsage,
  usageRatio,
  type UsageSnapshot,
} from "@/lib/hooks/use-usage";
import {
  buildApiUrl,
  fetchWithApiFallback,
  fetchWithAuth,
  getAuthToken,
  explainFetchError,
} from "@/lib/api";
import {
  AnnouncementBanner,
} from "@/components/header/AnnouncementBanner";
import { useAnnouncements } from "@/lib/hooks/use-announcements";
import { useRecommendedTerms } from "@/lib/hooks/use-recommended-terms";
import { PaperReviewPanel } from "@/components/lab/PaperReviewPanel";
import { TOS_SECTIONS, TOS_VERSION, APP_VERSION } from "@/lib/tos-content";
import {
  FileText, BarChart2, LayoutGrid, Brain, Compass, Search, Rocket,
  Zap, FlaskConical, SlidersHorizontal, BookOpen, Upload, FolderOpen,
  PenLine, ListChecks, Ruler, Quote, Globe, Sparkles, Square, Play, Star,
  ChevronRight, ChevronLeft, ChevronDown, Trash2, Download, ClipboardList,
  X, Gem, Check, Mail, Moon, Sun, User, Settings, CreditCard, HelpCircle, Users,
  Plus, Minus, ArrowRight, Lightbulb, ExternalLink, MessageCircle,
  Microscope, Bot, Pin, Target, BarChart as BarChartIcon,
  Link as LinkIcon, ShieldCheck,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, GripVertical,
  Megaphone, CornerDownLeft, RotateCcw,
} from "lucide-react";

// Transport / auth / error-copy helpers live in src/lib/api.ts. They used to
// be duplicated in this file; keeping them in one place means the retry /
// backoff behaviour is consistent across every future page and testable in
// isolation. The imports at the top of this file pull them in; we re-declare
// a thin `explainFetchError` alias only so the dev-time API_BASE mention in
// error copy stays accurate when NEXT_PUBLIC_API_BASE_URL is missing.

// ── Lab writing-model catalogue ─────────────────────────────────────────────
// The backend expects one of a small allow-list of provider model ids (see
// _ALLOWED_WRITING_MODELS in academic-ats-backend/main.py). Users don't need
// to see which vendor we're calling — instead we show descriptive aliases
// and map to the real id only in the request payload. Keeping the mapping
// here (not in a separate file) so the pair stays in one place and the
// backend allow-list check still works without any translation step.
type LabModelOption = {
  id:      string;   // backend-visible model id (sent in writing_model)
  label:   string;   // user-visible alias (never vendor-specific)
  tagline: string;   // short one-line description shown in the picker
};
const LAB_MODEL_OPTIONS: LabModelOption[] = [
  { id: "gpt-4o-mini",        label: "Swift Writer",   tagline: "Fastest · default" },
  { id: "gpt-4o",             label: "Deep Writer",    tagline: "Broader reasoning · slower" },
  { id: "claude-sonnet-4-6",  label: "Scholar Writer", tagline: "Citation-careful long form" },
];
const labModelLabel = (id: string): string =>
  LAB_MODEL_OPTIONS.find(m => m.id === id)?.label ?? "Swift Writer";

const DEFAULT_SOURCES = [
  "Semantic Scholar",
  "OpenAlex",
  "Crossref",
  "Google Scholar",
  "arXiv",
  "PubMed",
  "ERIC",
  "DOAJ",
  "DiGRA",
];

const SORT_MODES = [
  "Relevance score",
  "Evidence strength",
  "Research fit",
  "Newest first",
  "Open access first",
  "Balanced",
];

// Recommended-term chips for the Sprite landing UI now come from the
// admin-managed `recommended_terms` table via useRecommendedTerms (see
// src/lib/hooks/use-recommended-terms.ts). The hook does a daily-seeded
// shuffle so the deck rotates at midnight UTC and every user sees the
// same picks on the same day. Clicking a chip replaces the textarea
// contents wholesale; admin CRUD lives in /admin → Recommended Terms.

// WORKSPACE_PLACEHOLDERS lives in src/lib/workspace-placeholders.ts — edit there to add phrases.

type QueryOption = {
  label?: string;
  search_query?: string;
  reason?: string;
  confidence?: number;
  intent_profile?: Record<string, unknown>;
};

type QueryOptionsResponse = {
  original_query?: string;
  options?: QueryOption[];
  recommended_index?: number;
  error?: string;
};

type WorkflowItem = {
  agent?: string;
  action?: string;
  details?: string;
};

type Paper = {
  title: string;
  authors?: string;
  year?: string;
  source?: string;
  score?: number | string;
  summary?: string;
  url?: string;
  is_oa?: boolean;
  oa_url?: string;
  pdf_url?: string;
  doi?: string;
  evidence_strength?: string;
  evidence_score?: number | string;
  recommendation_reason?: string;
  research_fit_score?: number;
  domain_fit_label?: string;
  paper_type_label?: string;
  off_target_risk_score?: number;
  ranking_reason?: string;
  citation_count?: number | string;
  evidence_breakdown?: Record<string, number>;
  word_count?: number;
  raw?: Record<string, any>;
};

type AgentPayload = Record<string, unknown>;

type SearchResponse = {
  query?: string;
  brief?: string;
  papers?: Paper[];
  error?: string;
  debug_has_editor?: boolean;
  debug_paper_count?: number;
  query_planner?: AgentPayload;
  query_planner_review?: AgentPayload;
  strategy_summary?: AgentPayload;
  collaboration_trace?: WorkflowItem[];
  collaboration_metrics?: Record<string, unknown>;
  evidence_mapper?: AgentPayload;
  researcher?: AgentPayload;
  scholar?: AgentPayload;
  theorist?: AgentPayload;
  methodologist?: AgentPayload;
  critic?: AgentPayload;
  gap_analyst?: AgentPayload;
  verifier?: AgentPayload;
  editor_error?: string;
  final_search_query?: string;
  original_query?: string;
  settings?: Record<string, unknown>;
  // Retrieval funnel — shows the sample pool size at each stage so the UI
  // can render "X of Y retrieved" instead of just the final paper count.
  // retrieved_total is the biggest number (raw hits from Semantic Scholar /
  // OpenAlex / Crossref / etc. before dedup + filters + LLM re-ranking).
  diagnostics?: {
    retrieval_funnel?: {
      retrieved_total?: number;
      after_filters?: number;
      stage2_pool?: number;
      final_count?: number;
    };
    [key: string]: unknown;
  };
};

type JobResponse = {
  job_id?: string;
  query?: string;
  status?: string;
  progress?: number;
  message?: string;
  result?: SearchResponse | null;
  error?: string | null;
  workflow?: WorkflowItem[];
  started_at?: number | null;
  finished_at?: number | null;
};

type DeepReadResult = Record<string, any>;

// ── Feature flag: Evidence Chain (temporarily disabled) ──────────────────
// Evidence Chain is still under iteration — claim quality + source-trail
// coverage need more work before we put it in front of users. Setting
// this to `false` hides the button (greyed out + tooltip), removes the
// marketing bullets from the subscription modal, and drops the
// onboarding card. The backend endpoint also returns 503 when disabled,
// so any cached client that still has an enabled button fails with a
// clean "temporarily disabled" message rather than the LLM pipeline.
// Flip to `true` to turn everything back on — no other code changes
// required. Quota counters + admin panel keep tracking the key so
// historical data stays intact across the disable window.
const EVIDENCE_CHAIN_ENABLED = false;
const EVIDENCE_CHAIN_DISABLED_NOTE = "Evidence Chain is temporarily offline while we refine claim quality — back soon.";

type DragTarget = "left" | "center" | null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read the current `zoom` factor on <html>. The responsive zoom media
 * queries in globals.css set `html { zoom: 0.XX }` below 2200 px so the
 * whole page shrinks proportionally on smaller screens.
 *
 * `window.innerHeight` / `innerWidth` return PHYSICAL viewport pixels (they
 * ignore zoom), but `getBoundingClientRect()` and `event.clientX/Y` return
 * values in the ZOOMED (logical) coordinate system. Mixing the two breaks
 * scroll / drag math at smaller viewports. Use `getVisualVH()` / `getVisualVW()`
 * whenever the math has to interop with rect or client coords under zoom.
 */
function getDocumentZoom(): number {
  if (typeof document === "undefined") return 1;
  const raw = getComputedStyle(document.documentElement).zoom;
  const n = parseFloat(raw || "1");
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function getVisualVH(): number {
  if (typeof window === "undefined") return 0;
  return window.innerHeight / getDocumentZoom();
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function getPaperKey(paper: Paper, index: number) {
  if (paper.doi) return paper.doi.toLowerCase();
  if (paper.title) return paper.title.toLowerCase().replace(/\s+/g, "-");
  return `paper-${index}`;
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.detail || data?.error || fallback;
  } catch {
    return fallback;
  }
}

const KW_STOPWORDS = new Set([
  "the","a","an","and","or","of","in","on","at","to","for","with","by","from",
  "is","are","was","were","be","been","its","this","that","these","those","their",
  "which","about","into","through","between","after","before","using","based",
  "study","research","paper","analysis","approach","framework","model","review",
  "toward","towards","across","within","beyond","among","during","over","under",
  // generic/low-signal words from titles
  "same","different","difference","differences","comparative","comparison","comparisons",
  "effect","effects","impact","impacts","influence","influences","role","roles",
  "use","uses","used","using","user","users","new","novel","high","low","large","small",
  "results","result","finding","findings","method","methods","data","factor","factors",
  "level","levels","type","types","case","cases","based","related","various","multiple",
  "potential","possible","current","recent","further","first","second","third",
  "also","well","both","such","more","less","most","many","much","some","other","others",
  "does","have","has","had","will","would","could","should","may","might","can",
  "two","three","four","five","one","all","each","every","any","than","then","when",
  "how","what","why","where","who","whom","whether","while","since","after","because",
]);

function extractKeywords(paper: Paper): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const k = raw.trim();
    if (!k || k.length < 2 || seen.has(k.toLowerCase())) return;
    seen.add(k.toLowerCase());
    out.push(k);
  };
  // Domain label (e.g. "Educational Technology / Game Studies") — split on separators
  if (paper.domain_fit_label) paper.domain_fit_label.split(/[,;\/]/).forEach(s => add(s.trim()));
  // Paper type label (e.g. "Empirical Study")
  if (paper.paper_type_label) add(paper.paper_type_label);
  // Evidence strength tier (e.g. "Strong evidence")
  if (paper.evidence_strength) add(paper.evidence_strength);
  // NOTE: title-word extraction deliberately omitted — title words are low-signal tags
  return out.slice(0, 6);
}

type QuerySubOption = {
  label: string;
  search_query: string;
  reason?: string;
  intent_profile?: Record<string, unknown>;
};
type QueryDirection = {
  label: string;
  description?: string;
  sub_options: QuerySubOption[];
  search_query?: string;
  keywords?: string[];
};
type QueryDirectionsResponse = {
  original_query?: string;
  directions: QueryDirection[];
  recommended_direction?: number;
  recommended_sub?: number;
  error?: string;
};

function mergeParentSubQuery(subQuery: string, parentAnchor: string): string {
  // Keep the sub-option's search_query as the base (it's the specific angle)
  // and append any word tokens from the parent direction that aren't already
  // present, so the final query stays grounded in the larger direction even
  // when the sub's phrasing is terse.
  const sub = (subQuery || "").trim();
  const parent = (parentAnchor || "").trim();
  if (!sub) return parent;
  if (!parent) return sub;
  const normalize = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Set<string>();
  for (const w of sub.split(/\s+/)) { const k = normalize(w); if (k) seen.add(k); }
  const extras: string[] = [];
  for (const w of parent.split(/\s+/)) {
    const k = normalize(w);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    extras.push(w);
  }
  return extras.length ? `${sub} ${extras.join(" ")}` : sub;
}

function mergeIntentProfiles(
  subIntent: Record<string, unknown> | undefined,
  parentKeywords: string[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(subIntent || {}) };
  if (!parentKeywords?.length) return out;
  const existingInclude = Array.isArray(out.include) ? (out.include as unknown[]).map(String) : [];
  const seen = new Set(existingInclude.map(s => s.toLowerCase().trim()).filter(Boolean));
  const merged = [...existingInclude];
  for (const kw of parentKeywords) {
    const k = (kw || "").toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push(kw);
  }
  out.include = merged;
  return out;
}

function scoreChip(score: number | undefined | null): { label: string; cls: string } {
  const s = score ?? 0;
  // Palette tuned to read clearly in BOTH themes: uses 400/500 shades
  // that have explicit light-mode overrides in globals.css (see `score-chip-*`).
  if (s >= 75) return { label: "Strong match", cls: "score-chip-strong border-emerald-500/40 bg-emerald-500/15 text-emerald-400"  };
  if (s >= 65) return { label: "Good match",   cls: "score-chip-good border-blue-400/50   bg-blue-400/10   text-blue-400"       };
  if (s >= 40) return { label: "Moderate",     cls: "score-chip-moderate border-amber-500/50  bg-amber-500/15  text-amber-500"      };
  return             { label: "Weak match",    cls: "score-chip-weak border-rose-500/40   bg-rose-500/15   text-rose-400"       };
}

// Announcement banner (ticker + danmu + message input) now lives in
// components/header/AnnouncementBanner.tsx. See the `AnnouncementBanner`
// import at the top of this file — the component itself is fully extracted.

// ── Developer controls panel ────────────────────────────────────────────────
// Rendered inside the user modal only when the caller's tier is "dev".
// Exposes bulk cleanup + a per-row editor for the seed ("system")
// announcements so the dev can rewrite / add opening messages without
// touching the DDL. Add new privileged operations here as they come up
// instead of sprinkling `isDeveloper` conditionals across the page.
type AnnouncementLike = { id: string; author_email: string; text: string; created_at: string };

const DEV_SEED_EMAIL = "dev@academicats.com";

// Small indeterminate progress strip used across action buttons to show
// "something is happening" while an async operation is in flight. Pair
// with a spinning icon on the same button for a consistent running-state
// visual.
//
// Defaults to currentColor so the strip inherits the button's own text
// colour — which is already either a Tailwind text-* class (violet-300,
// emerald-300, etc) OR a var(--ats-fg-*) token. Callers shouldn't pass
// an explicit `color` unless they deliberately want to break that
// inheritance; doing so reintroduces off-palette colours the user was
// complaining about in the alpha UI review.
function ProgressStrip({ active, color }: { active: boolean; color?: string }) {
  if (!active) return null;
  return (
    <span
      className="pointer-events-none absolute left-0 bottom-0 h-[2px] w-full overflow-hidden"
      aria-hidden
    >
      <span
        className="block h-full w-1/3 rounded-full"
        style={{
          backgroundColor: color ?? "currentColor",
          animation: "progress-slide 1.2s ease-in-out infinite",
        }}
      />
    </span>
  );
}

function DevControlsPanel({
  onError,
  onCleared,
  announcements,
  onRefresh,
}: {
  onError:    (msg: string) => void;
  /** Fired after a successful bulk delete so the parent can re-fetch the
   *  announcements feed as a belt-and-suspenders against Realtime DELETE
   *  events not being enabled in the current Supabase publication. */
  onCleared?: () => void;
  /** Live announcements feed — used to render the editor list for the
   *  three seed system messages. Passed from the parent so we share the
   *  same Realtime subscription. */
  announcements: AnnouncementLike[];
  /** Re-fetch callback; called after edits / inserts so the editor
   *  list refreshes immediately without waiting for Realtime echo. */
  onRefresh: () => void;
}) {
  const [busy, setBusy]     = useState<"" | "user" | "all" | `row:${string}` | "new">("");
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Drafts keyed by row id — lets the dev edit inline without losing
  // local text between re-renders from Realtime echoes.
  const [drafts, setDrafts]     = useState<Record<string, string>>({});
  const [newDraft, setNewDraft] = useState("");

  const systemMessages = announcements.filter(a => a.author_email === DEV_SEED_EMAIL);

  async function runCleanup(kind: "user" | "all") {
    const path = kind === "user" ? "/api/announcements/user" : "/api/announcements/all";
    const confirmText = kind === "user"
      ? "Delete every user-posted announcement? Seeded dev messages will remain."
      : "NUKE every announcement in the feed — including the seeded dev welcome messages. Continue?";
    if (!window.confirm(confirmText)) return;
    setBusy(kind);
    setStatus(null);
    try {
      const res = await fetchWithAuth(buildApiUrl(path), { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { deleted: number };
      setStatus({ kind: "ok", text: `Deleted ${json.deleted ?? 0} row(s).` });
      onCleared?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "err", text: msg });
      onError(msg);
    } finally {
      setBusy("");
    }
  }

  async function saveRow(row: AnnouncementLike) {
    const text = (drafts[row.id] ?? row.text).trim();
    if (!text || text === row.text) return;
    setBusy(`row:${row.id}`);
    setStatus(null);
    try {
      const res = await fetchWithAuth(buildApiUrl(`/api/announcements/${row.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      setStatus({ kind: "ok", text: "Saved." });
      setDrafts(d => { const next = { ...d }; delete next[row.id]; return next; });
      onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "err", text: msg });
      onError(msg);
    } finally {
      setBusy("");
    }
  }

  async function deleteRow(row: AnnouncementLike) {
    if (!window.confirm(`Delete this system message?\n\n"${row.text.slice(0, 80)}${row.text.length > 80 ? "…" : ""}"`)) return;
    setBusy(`row:${row.id}`);
    setStatus(null);
    try {
      const res = await fetchWithAuth(buildApiUrl(`/api/announcements/${row.id}`), { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      setStatus({ kind: "ok", text: "Deleted." });
      setDrafts(d => { const next = { ...d }; delete next[row.id]; return next; });
      onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "err", text: msg });
      onError(msg);
    } finally {
      setBusy("");
    }
  }

  async function addNew() {
    const text = newDraft.trim();
    if (!text) return;
    setBusy("new");
    setStatus(null);
    try {
      const res = await fetchWithAuth(buildApiUrl("/api/announcements/system"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      setStatus({ kind: "ok", text: "Added system message." });
      setNewDraft("");
      onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "err", text: msg });
      onError(msg);
    } finally {
      setBusy("");
    }
  }

  return (
    // Horizontal layout: a 3-column grid on md+ screens. Left column is the
    // amber "this is powerful" preamble + admin console shortcut, middle is
    // the system-message editor (flex-growing because it's the tallest
    // content), right column holds the bulk-cleanup destructive actions +
    // the status banner. On narrow screens the columns stack vertically
    // because a single-column read-order makes more sense than scrolling
    // sideways through dev chrome.
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* Col 1 — warning + admin console link ───────────────────── */}
        <div className="space-y-3">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <p className="text-xs font-bold text-amber-300">Developer-only controls</p>
            <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
              These actions affect every user. Use sparingly — the Realtime
              channel pushes the changes to every open session immediately.
            </p>
          </div>
          <a
            href="/admin"
            target="_blank"
            rel="noreferrer"
            className="block rounded-xl border border-[var(--ats-border-accent)] bg-[var(--ats-bg-accent-soft)] px-4 py-3 hover:brightness-110 transition-all"
          >
            <p className="text-xs font-bold flex items-center gap-1.5" style={{ color: "var(--ats-fg-accent)" }}>
              <BarChartIcon size={12} />
              Admin monitoring →
            </p>
            <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
              Opens the full commercial dashboard in a new tab — live KPIs,
              usage time-series, per-tier breakdowns, and recent activity.
            </p>
          </a>
        </div>

        {/* Col 2 — system announcements editor ─────────────────────── */}
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 px-4 py-3 space-y-2.5">
          <div>
            <p className="text-sm font-semibold text-slate-200">System announcements</p>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              Seed-email messages (<code className="text-slate-400">{DEV_SEED_EMAIL}</code>)
              render without a byline. Edit, delete, or add more inline.
            </p>
          </div>
          {systemMessages.length === 0 && (
            <p className="text-[11px] rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-slate-500 italic">
              No system announcements yet — add the first one below.
            </p>
          )}
          {systemMessages.map(row => {
            const draft = drafts[row.id] ?? row.text;
            const dirty = draft !== row.text;
            const rowBusy = busy === `row:${row.id}`;
            return (
              <div key={row.id} className="rounded-lg border border-slate-700/60 bg-slate-900/60 p-2 space-y-1.5">
                <textarea
                  value={draft}
                  onChange={(e) => setDrafts(d => ({ ...d, [row.id]: e.target.value }))}
                  rows={2}
                  maxLength={280}
                  className="w-full rounded-md border border-slate-700/60 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-[var(--ats-border-accent)] resize-y leading-relaxed"
                />
                <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
                  <span className="tabular-nums">{draft.length} / 280</span>
                  <div className="flex items-center gap-1.5">
                    {dirty && (
                      <button
                        onClick={() => setDrafts(d => { const n = { ...d }; delete n[row.id]; return n; })}
                        className="text-slate-400 hover:text-slate-200 transition-colors"
                      >Cancel</button>
                    )}
                    <button
                      onClick={() => void saveRow(row)}
                      disabled={!dirty || rowBusy}
                      className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-40"
                    >
                      {rowBusy && dirty ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => void deleteRow(row)}
                      disabled={rowBusy}
                      className="inline-flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-semibold text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-40"
                    >
                      <Trash2 size={10} />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add new system message */}
          <div className="rounded-lg border border-dashed border-slate-700/60 bg-slate-900/40 p-2 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Add new</p>
            <textarea
              value={newDraft}
              onChange={(e) => setNewDraft(e.target.value)}
              rows={2}
              maxLength={280}
              placeholder="Text for a new system announcement…"
              className="w-full rounded-md border border-slate-700/60 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-[var(--ats-border-accent)] resize-y leading-relaxed placeholder:text-slate-700"
            />
            <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
              <span className="tabular-nums">{newDraft.length} / 280</span>
              <button
                onClick={() => void addNew()}
                disabled={!newDraft.trim() || busy === "new"}
                className="inline-flex items-center gap-1 rounded border border-[var(--ats-border-accent)] bg-[var(--ats-bg-accent-soft)] px-2 py-0.5 font-semibold hover:brightness-110 transition-all disabled:opacity-40"
                style={{ color: "var(--ats-fg-accent)" }}
              >
                <Plus size={10} />
                {busy === "new" ? "Adding…" : "Add message"}
              </button>
            </div>
          </div>
        </div>

        {/* Col 3 — bulk cleanup ─────────────────────────────────────── */}
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 px-4 py-3 space-y-2.5">
          <div>
            <p className="text-sm font-semibold text-slate-200">Bulk cleanup</p>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              &ldquo;User-posted&rdquo; keeps the seeded welcome messages;
              &ldquo;all&rdquo; wipes the table clean.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => void runCleanup("user")}
              disabled={busy !== ""}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
            >
              <Trash2 size={12} />
              {busy === "user" ? "Clearing…" : "Clear user-posted"}
            </button>
            <button
              onClick={() => void runCleanup("all")}
              disabled={busy !== ""}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-50"
            >
              <Trash2 size={12} />
              {busy === "all" ? "Nuking…" : "Clear ALL (incl. seeds)"}
            </button>
          </div>
        </div>
      </div>

      {/* Status banner — full width beneath the grid */}
      {status && (
        <p className={`text-[11px] rounded-lg px-3 py-1.5 ${
          status.kind === "ok"
            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
            : "bg-red-500/10 text-red-400 border border-red-500/30"
        }`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

function AgentSection({ title, payload, running = false }: { title: string; payload?: AgentPayload; running?: boolean }) {
  const hasData = payload && Object.keys(payload).filter(k => {
    const v = payload[k];
    return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
  }).length > 0;

  // Hide completely if not running and no meaningful output
  if (!running && !hasData) return null;

  return (
    <details
      className={`rounded-2xl border px-4 py-3 transition-colors duration-300 ${
        running && !hasData
          ? "border-blue-500/30 bg-blue-500/5"
          : "border-slate-700 bg-slate-950/40"
      }`}
      open={hasData || running}
    >
      <summary className="flex cursor-pointer items-center gap-2 font-semibold text-slate-200 select-none">
        {title}
        {running && !hasData && (
          <span className="flex items-center gap-1 text-xs font-normal text-blue-400 ml-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            running…
          </span>
        )}
        {hasData && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-emerald-400"><Check size={11} strokeWidth={3} />done</span>
        )}
      </summary>

      {/* Per-agent progress bar */}
      <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-slate-800">
        {hasData ? (
          <div className="h-full w-full rounded-full bg-emerald-500 transition-all duration-500" />
        ) : running ? (
          <div className="h-full rounded-full bg-blue-500/70 animate-[progress-slide_1.8s_ease-in-out_infinite]"
               style={{ width: "40%" }} />
        ) : null}
      </div>

      {running && !hasData ? (
        <div className="mt-2 text-xs text-blue-400/70 animate-pulse">Working…</div>
      ) : (
        <div className="mt-4 space-y-3 text-xs text-slate-300 fade-in">
          {Object.entries(payload!).map(([key, value]) => {
            if (value === null || value === undefined || value === "") return null;
            if (Array.isArray(value) && value.length === 0) return null;
            return (
              <div key={key} className="rounded-xl bg-slate-900/30 p-3">
                <div className="mb-1.5 text-xs font-semibold capitalize text-slate-100">{key.replace(/_/g, " ")}</div>
                {Array.isArray(value) ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {value.map((item, idx) => (
                      <li key={idx} className="break-words">{String(item)}</li>
                    ))}
                  </ul>
                ) : typeof value === "object" ? (
                  <pre className="overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">
                    {JSON.stringify(value, null, 2)}
                  </pre>
                ) : (
                  <div className="whitespace-pre-wrap break-words leading-relaxed">{String(value)}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </details>
  );
}

// Combined resize-divider + scrollbar component.
// Dragging the thumb vertically scrolls the adjacent section;
// dragging the track background horizontally resizes the columns.
function DividerScrollbar({
  onResizeStart,
  onSnap,
  sectionRef,
}: {
  onResizeStart: () => void;
  onSnap?: () => void;
  sectionRef: { current: HTMLElement | null };
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumbTop, setThumbTop] = useState(0);
  const [thumbHeight, setThumbHeight] = useState(100);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = section;
      if (scrollHeight <= clientHeight) { setThumbHeight(100); setThumbTop(0); return; }
      const h = Math.max((clientHeight / scrollHeight) * 100, 6);
      const t = (scrollTop / (scrollHeight - clientHeight)) * (100 - h);
      setThumbHeight(h);
      setThumbTop(t);
    };

    update();
    section.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(section);
    return () => { section.removeEventListener("scroll", update); ro.disconnect(); };
  }, [sectionRef]);

  const handleThumbMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // prevent resize drag from starting
    const section = sectionRef.current;
    if (!section) return;
    const startY = e.clientY;
    const startScrollTop = section.scrollTop;
    const { scrollHeight, clientHeight } = section;
    const scrollRange = scrollHeight - clientHeight;
    const trackH = trackRef.current?.clientHeight ?? clientHeight;
    const thumbPx = (thumbHeight / 100) * trackH;
    const scrollablePx = Math.max(trackH - thumbPx, 1);

    const onMove = (me: MouseEvent) => {
      const dy = me.clientY - startY;
      section.scrollTop = Math.max(0, Math.min(scrollRange, startScrollTop + (dy / scrollablePx) * scrollRange));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Scroll thumb intentionally suppressed — the only scrollbar in the app lives
  // INSIDE each panel (`.thin-scrollbar`). This divider keeps just its resize affordance.
  void thumbTop; void thumbHeight; void handleThumbMouseDown;
  return (
    <div
      ref={trackRef}
      onMouseDown={(e) => {
        // Track mousedown start so we can tell a click apart from a drag. Anything that
        // moves less than 4 px before mouseup counts as a click → snap to the default ratio.
        const startX = e.clientX;
        const startY = e.clientY;
        let moved = false;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - startX) > 3 || Math.abs(me.clientY - startY) > 3) moved = true;
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (!moved) onSnap?.();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        onResizeStart();
      }}
      className="group relative self-stretch cursor-col-resize flex-none select-none flex items-stretch justify-center"
      style={{ width: "12px" }}
    >
      {/* Highlighted line — invisible by default, fades in when the cursor
          approaches the background gap between panels. Colour tracks
          --ats-border-accent so dark / light themes stay coherent. */}
      <div className="w-[2px] h-full rounded-full bg-[var(--ats-border-accent)] opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      {/* Always-visible drag affordance at the vertical centre. Faint enough
          to not compete with content, clearer on hover. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-400/40 group-hover:text-[var(--ats-fg-accent)] transition-colors"
      >
        <GripVertical size={12} />
      </span>
    </div>
  );
}

export default function HomePage() {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragTarget>(null);
  const leftSectionRef = useRef<HTMLElement>(null);
  const centerSectionRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const labAbortRef = useRef<AbortController | null>(null);

  // Theme state is owned by the Zustand store (see src/lib/stores/theme-store).
  // This slice used to live as three local useStates in this component; moving
  // it to a store means every future screen (Settings modal, Login, error
  // boundary) can read/mutate the same palette without prop drilling, and
  // unrelated renders in this giant file no longer churn on theme changes.
  //
  // First-time visitors (no `ats-theme-customized` flag) still see the default
  // blue pair — Daylight Blue (day) / Midnight Blue (night) — because the
  // store's initial state is the registry defaults and hydration below only
  // runs when the flag is set.
  const themeMode    = useThemeStore((s) => s.mode);
  const dayThemeId   = useThemeStore((s) => s.dayThemeId);
  const nightThemeId = useThemeStore((s) => s.nightThemeId);
  const setThemeMode    = useThemeStore((s) => s.setMode);
  const setDayThemeId   = useThemeStore((s) => s.setDayThemeId);
  const setNightThemeId = useThemeStore((s) => s.setNightThemeId);
  const setTheme        = useThemeStore((s) => s.setTheme);
  const theme = themeMode === "day" ? dayThemeId : nightThemeId;

  useEffect(() => {
    // One-shot hydration from localStorage on mount. The stores' default
    // initial state matches SSR output, so React never sees a hydration
    // mismatch; the real persisted values land after first paint.
    hydrateThemeStore();
    hydratePrefsStore();
    hydrateUsagePromptStore();
    // Fetch the admin-controlled client config (currently: workspace char limit).
    // The server value wins over the local one when it's tighter — see
    // applyServerWorkspaceCharLimit for rationale.
    void (async () => {
      try {
        const res = await fetchWithApiFallback("/api/config/client");
        if (!res.ok) return;
        const data = await res.json() as { workspace_char_limit?: number };
        if (typeof data.workspace_char_limit === "number") {
          applyServerWorkspaceCharLimit(data.workspace_char_limit);
        }
      } catch { /* best-effort — local default is fine if backend offline */ }
    })();
  }, []);

  // User-tunable behaviour preferences (Settings → Behaviour).
  const rotatorIntervalMs    = usePrefsStore(s => s.rotatorIntervalMs);
  const themeTransitionMs    = usePrefsStore(s => s.themeTransitionMs);
  // `workspaceCharLimit` is ADMIN-controlled via /admin's ClientConfigEditor;
  // we only READ the effective cap here and apply it as the textarea
  // maxLength. There's no user-facing slider for it — see prefs-store.ts.
  const workspaceCharLimit   = usePrefsStore(s => s.workspaceCharLimit);
  const setRotatorIntervalMs = usePrefsStore(s => s.setRotatorIntervalMs);
  const setThemeTransitionMs = usePrefsStore(s => s.setThemeTransitionMs);

  // Theme-change unifier: whenever mode / day-theme / night-theme flips,
  // tag <html> with `theme-transitioning` for the full configured
  // duration. The globals.css rule keyed on `html.theme-transitioning *`
  // forces every element — including Tailwind `.transition-colors`
  // buttons that would otherwise finish in 150ms — to the user's
  // configured theme-transition duration, so the whole page crossfades
  // in lockstep. Class is removed after the animation finishes so
  // normal hover/focus interactions stay snappy.
  //
  // Skips the very first mount (nothing to animate yet) so page load
  // doesn't briefly slow down its entry transitions.
  const _themeMountedRef = useRef(false);
  useEffect(() => {
    if (typeof document === "undefined") return;
    // Mirror the active theme + tone onto <html> so the theme CSS vars
    // resolve at the root level too. Needed for globals.css to paint the
    // `html` element with `var(--ats-bg-base)` — otherwise `zoom` <100 %
    // leaves an uncovered canvas strip rendering as browser-default white.
    // Kept in sync every theme change so a day→night switch also updates
    // the canvas colour seamlessly.
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-tone", themeMode);
    if (!_themeMountedRef.current) {
      _themeMountedRef.current = true;
      return;
    }
    document.documentElement.classList.add("theme-transitioning");
    // +60 ms buffer past the configured duration so the class is still
    // present when the final frame paints.
    const hold = themeTransitionMs + 60;
    const t = window.setTimeout(() => {
      document.documentElement.classList.remove("theme-transitioning");
    }, hold);
    return () => window.clearTimeout(t);
  }, [theme, themeMode, dayThemeId, nightThemeId, themeTransitionMs]);

  // Per-panel translucency (0.4–1.0). Applied to the three main panel backgrounds
  // via `rgb(from <token> r g b / <alpha>)` — lets the page gradient bleed through
  // without dimming the panel's text/content.
  // Defaults: synthesis/lab panels at 0.85 so the page canvas tint peeks through,
  // workspace at 0.40 so the main surface feels like a frosted window over the canvas.
  const [panelAlpha, setPanelAlpha] = useState({ workspace: 0.4, synthesis: 0.85, lab: 0.85 });
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ats-panel-alpha");
      if (raw) {
        const parsed = JSON.parse(raw);
        setPanelAlpha(prev => ({
          workspace: Number.isFinite(parsed.workspace) ? Math.max(0.4, Math.min(1, parsed.workspace)) : prev.workspace,
          synthesis: Number.isFinite(parsed.synthesis) ? Math.max(0.4, Math.min(1, parsed.synthesis)) : prev.synthesis,
          lab:       Number.isFinite(parsed.lab)       ? Math.max(0.4, Math.min(1, parsed.lab))       : prev.lab,
        }));
      }
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("ats-panel-alpha", JSON.stringify(panelAlpha)); } catch {}
  }, [panelAlpha]);
  const [query, setQuery] = useState("");
  // Whether the main workspace textarea is currently focused — used to hide the
  // decorative placeholder overlay and reveal the native caret the moment the user clicks in.
  const [taFocused, setTaFocused] = useState(false);
  // Rotating placeholder — start with index 0 so SSR and client render match,
  // then shuffle to a real random on mount (and again whenever the query empties).
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  // Refs + adaptive sizing for the Workspace textarea:
  // - taRef: used to imperatively set height so user's manual resize isn't overridden.
  // - placeholderWrapperRef: observed to compute an ideal placeholder font size.
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Imperative handle into Sprite — lets the textarea's onKeyDown drive
  // bubble focus (ArrowLeft / ArrowRight) and trigger the focused bubble
  // (Enter) without page.tsx having to mirror Sprite's bubble shape.
  const spriteRef = useRef<SpriteHandle>(null);
  // Hover-help overlay text — when set, the sprite voice line shows
  // this string in priority, so the user gets an instant explanation
  // of whatever UI element they're aiming at. Cleared on mouse-leave.
  const [hoverHelpText, setHoverHelpText] = useState<string>("");
  const helpProps = useCallback((msg: string) => ({
    onMouseEnter: () => setHoverHelpText(msg),
    onMouseLeave: () => setHoverHelpText(prev => prev === msg ? "" : prev),
    onFocus:      () => setHoverHelpText(msg),
    onBlur:       () => setHoverHelpText(prev => prev === msg ? "" : prev),
  }), []);
  const placeholderWrapperRef = useRef<HTMLDivElement>(null);
  const [placeholderFontSize, setPlaceholderFontSize] = useState(48);
  // IME composition guard. Without this, Chinese / Japanese / Korean input
  // loses half-typed characters when React re-renders mid-composition — the
  // user types a pinyin like "ni" but React's controlled-value update resets
  // the composition buffer before they pick "你". Solution: track composing
  // state, and when composition ends write the final value via onChange.
  // (The browser fires onChange AFTER compositionend with the committed text,
  // so this is mostly a safety net + prevents layout reflows during composition.)
  const _composingRef = useRef(false);
  useEffect(() => {
    // Persist the picked slogan across reloads via sessionStorage so
    // a quick refresh (e.g. user accidentally hits F5) doesn't shuffle
    // to a different greeting and feel jarring. Randomise on first
    // session-mount only; subsequent mounts re-use the same index.
    try {
      const stored = window.sessionStorage.getItem("ats:workspace_placeholder_idx");
      const parsed = stored != null ? Number(stored) : NaN;
      if (Number.isFinite(parsed) && parsed >= 0 && parsed < WORKSPACE_PLACEHOLDERS.length) {
        setPlaceholderIdx(parsed);
        return;
      }
    } catch { /* sessionStorage may be unavailable in private mode — fall through */ }
    const next = Math.floor(Math.random() * WORKSPACE_PLACEHOLDERS.length);
    setPlaceholderIdx(next);
    try { window.sessionStorage.setItem("ats:workspace_placeholder_idx", String(next)); } catch {}
  }, []);
  // NOTE: previously this effect ran on every `[query]` change (every
  // keystroke) which added one extra render cycle per character. We now
  // re-shuffle the placeholder only on the non-empty → empty transition
  // inline inside the onChange handler, which keeps the per-keystroke
  // path lean and avoids any effect-driven work during rapid typing.

  // The placeholder overlay is hidden the moment the user focuses or starts
  // typing (it's purely decorative).
  const _showPlaceholder = query.length === 0 && !taFocused;
  // `hasRunSearch` flips true on the first submit and stays true for the
  // rest of the session. The textarea HEIGHT effect below depends on it +
  // `isSubmitting` — but `isSubmitting` is declared further down the
  // component body. Both state declarations live here; the useLayoutEffect
  // that writes ta.style.height is deferred to just after isSubmitting so
  // the effect's dep array doesn't hit a TDZ error.
  const [hasRunSearch, setHasRunSearch] = useState(false);
  // ── Staged entry ───────────────────────────────────────────────────────────
  // "blank"   — landing: only the textarea + placeholder + an Enter-to-continue
  //             hint are visible. No action buttons, no announcement banner.
  // "explore" — AI judged the input too brief to search directly. Only Search
  //             Controls + Explore Angles are shown.
  // "full"    — AI judged the input detailed enough (or balanced). Full action
  //             bar with Quick / Curated + Start is unlocked alongside Explore
  //             Angles; either route can be taken. Also the state after
  //             Explore Angles returns directions.
  const [introStage, setIntroStage] = useState<"blank" | "explore" | "full">("blank");
  // `committedQuery` snapshots the textarea value at the moment the user
  // advanced past blank. Used downstream to detect "user is typing something
  // totally new now" and prompt a confirm before collapsing everything back
  // to the blank stage.
  const [committedQuery, setCommittedQuery] = useState<string>("");

  // The sprite voice line is now a simple state setter; the debounced
  // AI-assessment + instant-reaction flow that previously fed it was
  // removed alongside the angles UI. We still drive it from a few
  // discrete events (Quick / Curated press, recommended-term pick) so
  // the sprite stays in conversation with the user.
  const [assessmentMessage, setAssessmentMessage] = useState<string>("");

  // Adaptive placeholder font size is handled via CSS container-query units
  // (`cqh` / `cqw`) on the wrapper below — no JS observer needed. The wrapper
  // declares `container-type: size` so the overlay's `font-size: clamp(...)`
  // scales with the user-resizable textarea height/width.
  void placeholderFontSize; void setPlaceholderFontSize; void placeholderWrapperRef;

  const [queryOptionsData, setQueryOptionsData] = useState<QueryOptionsResponse | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | null>(null);
  const [customQueryEnabled, setCustomQueryEnabled] = useState(false);
  const [customQueryValue, setCustomQueryValue] = useState("");
  const [directionData, setDirectionData] = useState<QueryDirectionsResponse | null>(null);
  const [understandOpen, setUnderstandOpen] = useState(true);
  const [selectedDirIndex, setSelectedDirIndex] = useState<number | null>(null);
  const [selectedSubIndex, setSelectedSubIndex] = useState<number | null>(null);


  // Quick / Curated bubble in the sprite chat IS the search trigger now —
  // replaces the old in-action-bar mode toggle + Start button. Picks the
  // mode and immediately fires handleSearch.
  function handleStartSearchFromSprite(mode: "quick" | "curated") {
    const trimmed = query.trim();
    if (!trimmed || isSubmitting) return;
    setFastMode(mode === "quick");
    setIntroStage("full");
    setCommittedQuery(trimmed);
    setAssessmentMessage(mode === "quick"
      ? "going quick, fast smart ranking (◕‿◕)"
      : "curated mode — deep dive, sit tight (˙ᵕ˙)"
    );
    // Defer one tick so the introStage / fastMode state settles into the
    // closure handleSearch reads.
    setTimeout(() => { void handleSearch(); }, 50);
  }

  // Recommended-term chip click — wholesale replace whatever the user
  // had typed with the chip's text. We refocus the textarea + move the
  // caret to the end so the user can keep typing if they want to refine.
  function handlePickRecommendedTerm(term: string) {
    setQuery(term);
    setAssessmentMessage(`picked “${term}” — Enter when you're ready (◕‿◕)`);
    // Defer the focus / caret move one frame so React has committed the
    // controlled-value update; otherwise setSelectionRange writes to the
    // pre-update value and ends up in the wrong place.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(term.length, term.length); } catch {}
    });
  }

  // The sprite typing-reaction + step-aware voice useEffects live AFTER
  // `buttonStep` and `isSubmitting` are declared further down — they
  // reference both, and React 19 + Turbopack TDZ-rejects the closure
  // when those bindings are read before their declaration. See the
  // matching effects right under the `buttonStep` state at the bottom
  // of this section.

  const [fastMode, setFastMode] = useState(true);
  const [paperCount, setPaperCount] = useState(15);
  const [sortMode, setSortMode] = useState("Relevance score");
  const [preferAbstracts, setPreferAbstracts] = useState(true);
  const [strictCoreOnly, setStrictCoreOnly] = useState(false);
  const [openAccessOnly, setOpenAccessOnly] = useState(true);
  const [sourceFilters, setSourceFilters] = useState<string[]>(DEFAULT_SOURCES);
  const [useYearRange, setUseYearRange] = useState(false);
  const [yearStart, setYearStart] = useState(2018);
  const [yearEnd, setYearEnd] = useState(new Date().getFullYear());

  // Persist every search-control preference to localStorage. Single consolidated
  // key (`ats-search-prefs`) — on mount we hydrate, and any change below writes
  // a debounced-by-rerender snapshot. Cloud sync can be layered on top by
  // replacing the storage adapter later; semantics stay identical either way.
  const _prefsHydratedRef = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ats-search-prefs");
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.fastMode === "boolean")          setFastMode(p.fastMode);
        if (Number.isFinite(p.paperCount))            setPaperCount(Math.max(3, Math.min(500, Math.round(p.paperCount))));
        if (typeof p.sortMode === "string")           setSortMode(p.sortMode);
        if (typeof p.preferAbstracts === "boolean")   setPreferAbstracts(p.preferAbstracts);
        if (typeof p.strictCoreOnly === "boolean")    setStrictCoreOnly(p.strictCoreOnly);
        if (typeof p.openAccessOnly === "boolean")    setOpenAccessOnly(p.openAccessOnly);
        if (Array.isArray(p.sourceFilters))           setSourceFilters(p.sourceFilters.filter((s: unknown) => typeof s === "string"));
        if (typeof p.useYearRange === "boolean")      setUseYearRange(p.useYearRange);
        if (Number.isFinite(p.yearStart))             setYearStart(p.yearStart);
        if (Number.isFinite(p.yearEnd))               setYearEnd(p.yearEnd);
      }
    } catch {}
    _prefsHydratedRef.current = true;
  }, []);
  useEffect(() => {
    if (!_prefsHydratedRef.current) return;           // don't overwrite before hydration runs
    try {
      localStorage.setItem("ats-search-prefs", JSON.stringify({
        fastMode, paperCount, sortMode, preferAbstracts, strictCoreOnly,
        openAccessOnly, sourceFilters, useYearRange, yearStart, yearEnd,
      }));
    } catch {}
  }, [fastMode, paperCount, sortMode, preferAbstracts, strictCoreOnly, openAccessOnly, sourceFilters, useYearRange, yearStart, yearEnd]);

  const [isSubmitting, setIsSubmitting] = useState(false);

  // Legacy auto-refire-find-angles useEffect was removed alongside the
  // angles flow itself. The sprite no longer fetches research directions
  // on its own — the user picks Quick / Curated explicitly (or clicks a
  // recommended-term chip) so there's nothing to debounce-refire here.

  // Textarea geometry + type scale. Before a search has run the textarea
  // is a tall "greeting" box; once a search runs (hasRunSearch) or a
  // search is in-flight (isSubmitting) it snaps down to a compact 2-line
  // box to give the results area room.
  //
  // Centering: a native <textarea> always anchors content to the top of
  // the content box — there's no `align-content: center` equivalent. We
  // fake vertical centering by writing a large `padding-top` when the
  // box is tall (empty + pre-search), so a short 1-2 line question sits
  // in the middle of the frame. Users typing multiple lines push the
  // padding proportion down naturally as the text grows. Once the box
  // goes compact the padding-top shrinks to a normal 1.25rem.
  //
  // Font scale: tied to the computed height. The big greeting box uses
  // ~3rem font so a short question feels spacious; the compact box
  // shrinks back to 1.125rem (text-lg) for a normal editing feel. Steps
  // interpolate so the transition is smooth if the box is ever something
  // between those two states.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (hasRunSearch || isSubmitting) {
      // Compact box — normal editing mode, no centering dance. Font
      // weight drops back to normal + regular size so editing a long
      // query doesn't feel shouty.
      ta.style.height       = "4.5rem";
      ta.style.paddingTop   = "1.25rem";
      ta.style.paddingBottom = "1.25rem";
      ta.style.fontSize     = "1.125rem";
      ta.style.fontWeight   = "400";
    } else {
      // Expanded greeting box — compute height, then derive a padding
      // that pushes the caret + typed text into the vertical centre.
      // We CAP the box at 420 px so the chrome below it (action bar +
      // sprite voice + Quick / Curated buttons + recommended-term
      // chips + optional Settings panel) always fits on a single
      // 1080–1440 px viewport without forcing the user to scroll. The
      // earlier 2/3-of-viewport math grew unbounded on 2K monitors and
      // pushed the action surfaces below the fold.
      const top = ta.getBoundingClientRect().top;
      const headroom = Math.max(getVisualVH() - top - 380, 200);
      const target = Math.min(headroom, 420);
      ta.style.height = `${target}px`;
      // 38% top padding visually centres a 1-3 line question. Minimum
      // 28px so a short viewport (rare) never collapses it entirely.
      ta.style.paddingTop    = `${Math.max(28, Math.round(target * 0.38))}px`;
      ta.style.paddingBottom = "28px";
      // Font sizing MIRRORS the placeholder overlay exactly — same
      // clamp formula, same font-weight, same line-height — so the
      // moment the user starts typing, the text slots into the same
      // visual rhythm as the slogan was occupying. No typographic
      // jump between the decorative state and the editing state.
      // Capped at 3rem (down from 4.25rem) so the placeholder text
      // doesn't overflow the shorter container on wide panels.
      ta.style.fontSize   = "clamp(1.25rem, 9cqw, 3rem)";
      ta.style.fontWeight = "700";
    }
  }, [hasRunSearch, isSubmitting]);
  const [retrievalCount, setRetrievalCount] = useState<number | null>(null);
  const [candidateLimit, setCandidateLimit] = useState<number | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [briefStreamText, setBriefStreamText] = useState("");
  const [briefStatus, setBriefStatus] = useState<"draft" | "final" | null>(null);
  const [streamPapers, setStreamPapers] = useState<Paper[]>([]);
  const [streamAgents, setStreamAgents] = useState<Record<string, AgentPayload>>({});
  const [startedAgents, setStartedAgents] = useState<Set<string>>(new Set());
  const [plannerThinking, setPlannerThinking] = useState<{planner_summary?: string; search_focus?: string; query_type?: string; agents_planned?: string[]} | null>(null);
  const [rawProgressMsg, setRawProgressMsg] = useState("");
  const [uiError, setUiError] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());

  // Initial layout is 1 : 5 : 1 (≈ 14.3 / 71.4 / 14.3) to give the Workspace the most breathing room on mount.
  // A single click on either divider snaps to the classic 1 : 3 : 1 (20 / 60 / 20) working layout.
  // After that, the user can drag freely from whichever ratio they just landed on.
  const [leftPct, setLeftPct] = useState(14.3);
  const [centerPct, setCenterPct] = useState(71.4);
  // Layout mode preset — the user picks one of four templates from the
  // header bar, and `applyLayoutMode` writes the matching visibility +
  // column ratios. handleSearch reads `layoutMode` instead of always
  // snapping to 1:3:1 so a mode the user picked sticks across runs.
  type LayoutMode = "default" | "scholar" | "student" | "writing";
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("default");
  // Snapshot of the layout the moment a search kicks off — captured so
  // Stop can restore the user back to whatever they had open (collapsed
  // side panels, custom column ratios) instead of leaving the auto-
  // expanded "working layout" up after they explicitly aborted.
  // Cleared on natural completion so a normal-finish search doesn't
  // ghost-revert when the user hits Stop on the NEXT one.
  const prePuttingSearchLayoutRef = useRef<null | {
    leftVisible: boolean;
    analyticsVisible: boolean;
    leftPct: number;
    centerPct: number;
  }>(null);
  const rightPct = Math.max(100 - leftPct - centerPct, 12);
  const snapDividerToDefault = useCallback(() => {
    setLeftPct(20);
    setCenterPct(60);
  }, []);
  // Default collapsed — first click anywhere expands both panels to the initial
  // 1:5:1 layout (see firstInteractionDone below). Retrieved Papers stays
  // hidden until the same first interaction, then slides up from the bottom.
  const [analyticsVisible, setAnalyticsVisible] = useState(false);
  const [leftVisible, setLeftVisible] = useState(false);
  const [gridLeftCollapsed, setGridLeftCollapsed] = useState(true);
  // Kept as a compatibility shim: one downstream component (the retrieved-
  // papers section) gates its rise animation on this flag. Now that there
  // is no "click anywhere to begin" step, we just land in the "done" state.
  const [firstInteractionDone] = useState(true);

  // ── Left panel tabs: Research Brief | Analytics ────────────────────────────
  const [leftTab, setLeftTab] = useState<"brief" | "analytics">("brief");

  // ── Announcement / messaging state ─────────────────────────────────────────
  // The shared public ticker feed comes from useAnnouncements (REST seed +
  // Supabase Realtime INSERT subscription). Local `publicMsgs` / danmu state
  // was removed when the per-tab localStorage scheme was replaced by the
  // server-backed feed — every open tab now sees the same list.
  const announcementsFeed = useAnnouncements();
  // Daily-rotated recommended-term chips from the admin pool. See
  // src/lib/hooks/use-recommended-terms.ts for the fetch + fallback.
  const recommendedTerms = useRecommendedTerms();

  // Three-step Quick / Curated reveal flow (driven by Enter on the textarea):
  //   0 → user has typed but the action buttons are still hidden
  //   1 → buttons are visible (no focus ring on either)
  //   2 → buttons are visible AND the active mode shows a focus ring;
  //       the next Enter actually fires the search.
  // Resets to 0 whenever the textarea empties or after a search runs so
  // the next session starts clean.
  const [buttonStep, setButtonStep] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    if (!query.trim() || hasRunSearch) {
      // Empty input → drop the buttons back into the hidden state so the
      // next typed query starts the 3-Enter ritual fresh. Mid-search we
      // also collapse since the buttons are out of scope while the search
      // is running.
      setButtonStep(0);
    }
  }, [query, hasRunSearch]);

  // Sprite typing-reaction loop — gives the sprite a voice while the
  // user is composing a query, so the surface never feels dead. Tiers:
  //   · empty input → blank message, the "Type any key words…" default
  //                   invite owns the slot.
  //   · short input (< 4 chars) → "thinking…" — feels like the sprite
  //                               is reading along.
  //   · medium input (4–25 chars) → encouraging mid-typing line.
  //   · longer input (≥ 25 chars) → "got plenty to work with — Enter"
  //                                 nudge so the user knows to commit.
  // Only fires when buttonStep === 0 (the user hasn't started the
  // 3-Enter ritual yet); the step-aware effect below owns the slot
  // once they have. Debounced 350 ms so steady typing doesn't churn.
  useEffect(() => {
    if (hasRunSearch || isSubmitting) return;
    if (buttonStep !== 0) return;
    const trimmed = query.trim();
    const id = window.setTimeout(() => {
      if (trimmed.length === 0)        setAssessmentMessage("");
      else if (trimmed.length < 4)     setAssessmentMessage("hmm, keep going…");
      else if (trimmed.length < 25)    setAssessmentMessage("nice — add a bit more or hit Enter (˙ᵕ˙)");
      else                             setAssessmentMessage("got plenty to work with — Enter when ready (◕‿◕)");
    }, 350);
    return () => window.clearTimeout(id);
  }, [query, buttonStep, hasRunSearch, isSubmitting]);

  // Step-aware sprite voice — fires the moment buttonStep changes so
  // the user always knows what the next Enter does. Putting it here
  // (instead of inside the textarea Enter handler) keeps the line in
  // sync if the step flips via any other path.
  useEffect(() => {
    if (hasRunSearch || isSubmitting) return;
    if (buttonStep === 1) setAssessmentMessage("Quick or Curated? Enter again to pick (◕‿◕)");
    if (buttonStep === 2) setAssessmentMessage("Enter to fire · ← → to switch · Esc to back out");
  }, [buttonStep, hasRunSearch, isSubmitting]);

  const [announcementCollapsed, setAnnouncementCollapsed] = useState(false);
  // Announcement banner is OFF by default now — a megaphone button next to
  // the mascot toggles it. Users who never need the banner get a cleaner
  // header; users who want it are one click away. Toggling the state
  // mounts / unmounts the banner wrapper so our stage-reveal fade fires
  // on every reveal rather than just the first one.
  const [announcementsVisible, setAnnouncementsVisible] = useState(false);
  const [msgInput, setMsgInput] = useState("");
  // Two send modes, both post to the public ticker. SIGNED includes the
  // user's email local-part next to the message; ANONYMOUS hides the
  // identity on the display side (server still stores author_id for
  // moderation — the display is what's anonymised).
  // Public ticker messages are always anonymous now — the SIGNED /
  // ANONYMOUS toggle was removed so the composer can't surface email
  // local-parts on the ticker. The state is kept (always true) so the
  // post call still has a value to send.
  const [msgAnonymous, setMsgAnonymous] = useState(true);
  const [msgSending, setMsgSending] = useState(false);
  const [msgSentOk, setMsgSentOk] = useState(false);

  // ── Workspace collapsible panel state ─────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Delay grid expansion until the aside slide-out finishes → eliminates the
  // fr→px interpolation artefact that wobbled the workspace left edge.
  // Start collapsed to match the "first click expands" default.
  const [gridRightCollapsed, setGridRightCollapsed] = useState(true);

  // ── Synthesis Lab (✍️) state ───────────────────────────────────────────────
  const [labRefs,       setLabRefs]       = useState<{ key: string; paper: Paper }[]>([]);
  const [labCoreArg,    setLabCoreArg]    = useState("");
  const [labPoints,     setLabPoints]     = useState<string[]>([""]);
  // Per-output-type extras — keys match LabExtraField.key from lib/lab-fields.ts.
  // Single-value fields live in labExtras; multi-entry fields live in labExtrasMulti
  // as arrays. Both get folded into the `extras` payload when Generate is clicked.
  const [labExtras, setLabExtras] = useState<Record<string, string>>({});
  const [labExtrasMulti, setLabExtrasMulti] = useState<Record<string, string[]>>({});
  const [labOutputType,     setLabOutputType]     = useState("literature_review");
  const [labCitationFormat, setLabCitationFormat] = useState("APA 7th Edition");
  const [labLanguage,       setLabLanguage]       = useState("English");
  const [labTargetPages,    setLabTargetPages]    = useState(2);
  const [labGenerating, setLabGenerating] = useState(false);
  const [labResult,     setLabResult]     = useState("");
  // Which module is active inside the right-panel Lab. The original
  // Synthesis Lab (paper-writer) and the newer Paper Review (multi-agent
  // peer review of a user-submitted draft) both live in the same panel
  // and swap via the header tab bar.
  // Default to Paper Review — it's the more common starting point and sits
  // first in the tab bar now.
  const [labModule, setLabModule] = useState<"synthesis" | "review">("review");

  // ── Lab multi-generation: tabbed result history ──────────────────────────
  // Each completed Generate run is archived in `labRuns` (newest first
  // order maintained on append at the END so "Run 1" = first-ever).
  // The user can tab-switch between past runs to compare outputs; the
  // viewed-run's full context (article text + agent log + reviewer
  // notes) is preserved so switching feels like a time-machine rather
  // than a partial revert.
  //
  // `labViewingId` points to the run currently being displayed; null
  // means "look at the live working buffer" (labResult / labAgentLog /
  // labReviewerNotes), which is what streaming writes into.
  //
  // Auto-snapshot runs when labGenerating transitions from true → false
  // AND labResult is non-empty, keyed on `labLastSavedRef` so the same
  // run doesn't get archived twice.
  type LabRun = {
    id: string;
    text: string;
    agentLog: typeof labAgentLog;
    reviewerNotes: null | {
      missing_inputs?: string[];
      citation_gaps?: string[];
      data_suggestions?: string[];
      argument_suggestions?: string[];
      supporting_points?: string[];
      completeness?: { missing?: string[]; thin?: string[] };
      paper_usage?: {
        used?:       Array<{ index: number; note?: string }>;
        unused?:     Array<{ index: number; reason?: string }>;
        unreadable?: Array<{ index: number; reason?: string }>;
        total?:      number;
      };
    };
    outputType: string;
    createdAt: number;
  };
  const [labRuns,       setLabRuns]       = useState<LabRun[]>([]);
  const [labViewingId,  setLabViewingId]  = useState<string | null>(null);
  const labLastSavedRef = useRef<string>("");
  // Ephemeral "Copied" flag — flips true on successful Copy-to-clipboard and
  // auto-resets after 1.5 s; used only by the Generated Text header button.
  const [labCopied,     setLabCopied]     = useState(false);
  // Translate-and-download selection for the generated text. Kept separate from
  // the normal download-format selector above so the user can pick both a
  // target language AND a file extension without confusing the two flows.
  const [labTranslateLang,   setLabTranslateLang]   = useState("Chinese (Simplified)");
  const [labTranslateFormat, setLabTranslateFormat] = useState<"pdf"|"md"|"txt">("pdf");
  const [labTranslating,     setLabTranslating]     = useState(false);
  // Primary (non-translated) article download state. Mirrors labTranslating
  // so a second click on the footer "Download" button cancels the in-flight
  // request — matches the pause/cancel UX the user asked for.
  const [labDownloading,     setLabDownloading]     = useState(false);
  const labDownloadAbortRef = useRef<AbortController | null>(null);
  // AbortController held across renders so a second click on the button can
  // cancel the in-flight translation request.
  const labTranslateAbortRef = useRef<AbortController | null>(null);
  const [labStatus,     setLabStatus]     = useState("");
  const [labError,      setLabError]      = useState("");
  const [labAgentLog,   setLabAgentLog]   = useState<{name: string; msg: string; done: boolean; error: boolean; revision: boolean}[]>([]);
  const [labDownloadFormat, setLabDownloadFormat] = useState<"pdf"|"html"|"txt"|"md">("pdf");
  const [briefDownloadFmt, setBriefDownloadFmt]   = useState<"pdf"|"html"|"txt"|"md">("pdf");

  // ── Brief translation (SSE) ──────────────────────────────────────────────
  // Google Translate can't safely translate the streaming brief (DOM
  // rewrite collides with React's streaming commits). This state backs
  // an in-app translate button that asks the backend to stream a
  // translation via /api/brief/translate — the user sees tokens appear
  // progressively, and can toggle back to the original at any time.
  //
  // The `requestBriefTranslation` callback itself is defined further
  // down in the component, after `result` has been derived from `job`
  // (order of declarations matters — a useCallback closing over `result`
  // that's mounted above its declaration would error under TS).
  const [briefTranslated,  setBriefTranslated]  = useState("");
  const [briefTranslating, setBriefTranslating] = useState(false);
  const [briefShowTrans,   setBriefShowTrans]   = useState(false);
  const [briefTransError,  setBriefTransError]  = useState("");
  const briefTransAbortRef = useRef<AbortController | null>(null);
  // Target language for the Translate button. Hydrated from
  // navigator.language on first render (see effect below); user can
  // override via the dropdown next to the button. Cached translations
  // are keyed by (brief_text, target_language) via briefTranslatedLang
  // so switching language triggers a fresh request rather than showing
  // a stale result in the wrong language.
  const [briefTargetLang,  setBriefTargetLang]  = useState("Chinese (Simplified)");
  const [briefTranslatedLang, setBriefTranslatedLang] = useState("");

  // The languages offered in the picker — curated common set. Add more
  // here and the LLM will happily translate; the backend prompt just
  // interpolates the string.
  const BRIEF_LANG_OPTIONS: { value: string; label: string }[] = [
    { value: "Chinese (Simplified)",  label: "简体中文" },
    { value: "Chinese (Traditional)", label: "繁體中文" },
    { value: "English",               label: "English"  },
    { value: "Japanese",              label: "日本語"    },
    { value: "Korean",                label: "한국어"    },
    { value: "Spanish",               label: "Español"  },
    { value: "French",                label: "Français" },
    { value: "German",                label: "Deutsch"  },
    { value: "Portuguese",            label: "Português"},
    { value: "Russian",               label: "Русский"  },
    { value: "Arabic",                label: "العربية"   },
  ];
  const [labAgentLogOpen,   setLabAgentLogOpen]   = useState(true);
  const [labReviewerNotes,  setLabReviewerNotes]  = useState<{
    missing_inputs?: string[];
    citation_gaps?: string[];
    data_suggestions?: string[];
    argument_suggestions?: string[];
    supporting_points?: string[];
    completeness?: { missing?: string[]; thin?: string[] };
    paper_usage?: {
      used?:       Array<{ index: number; note?: string }>;
      unused?:     Array<{ index: number; reason?: string }>;
      unreadable?: Array<{ index: number; reason?: string }>;
      total?:      number;
    };
  } | null>(null);
  const [labNotesOpen,      setLabNotesOpen]      = useState(true);
  const [labUserFiles,      setLabUserFiles]      = useState<File[]>([]);
  // Stored as the real backend model id so the payload always carries a
  // whitelisted value; the UI maps these ids to user-facing descriptive
  // labels via LAB_MODEL_OPTIONS below so the vendor is never exposed.
  const [labWritingModel,   setLabWritingModel]   = useState("gpt-4o-mini");
  const [labModelOpen,      setLabModelOpen]      = useState(false);

  const [deepReadResults, setDeepReadResults] = useState<Record<string, DeepReadResult>>({});
  const [deepReadLoading, setDeepReadLoading] = useState<Record<string, boolean>>({});
  const [deepReadErrors, setDeepReadErrors] = useState<Record<string, string>>({});
  const [originalLoading, setOriginalLoading] = useState<Record<string, boolean>>({});
  const [originalErrors, setOriginalErrors] = useState<Record<string, string>>({});
  const [translateLoading, setTranslateLoading] = useState<Record<string, boolean>>({});
  const [translateErrors, setTranslateErrors] = useState<Record<string, string>>({});
  const [translationLanguages, setTranslationLanguages] = useState<Record<string, string[]>>({});

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [authUser, setAuthUser] = useState<{ email?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userPanel, setUserPanel] = useState<"profile" | "settings" | "subscription" | "help" | "accounts" | "legal" | "usage" | "dev" | null>(null);

  // Live quota snapshot — tier + current-month counters. Refreshes on mount,
  // window focus, and whenever a metered action completes (see usage.refresh()
  // calls after search / synthesize / deep-read success).
  const usage = useUsage(!!authUser?.email);

  // Dev-composed notification popups (tier bump / quota grant / free-form).
  // The hook polls every 60s and on focus; the popup component auto-pops
  // the top of the queue when present and acks on dismiss.
  const userNotifications = useUserNotifications(!!authUser?.email);

  /**
   * Pre-flight quota check. Call BEFORE any metered action (search /
   * deep-read / synthesize). Returns true if the action is allowed; when it
   * returns false, the Usage modal is already open so the user sees why
   * they were blocked — no need for a separate toast. Unlimited tiers
   * (scholar / dev) always allow. If usage data hasn't arrived yet we
   * optimistically allow and rely on the server's HTTP 429 as the backstop.
   */
  const ensureQuota = useCallback((feature: keyof UsageSnapshot["limits"]): boolean => {
    if (!usage.data) return true;
    const limit = usage.data.limits[feature];
    if (limit === null || limit === undefined) return true;
    const used = (usage.data.used as any)[`${feature}_count`] ?? 0;
    if (used < limit) return true;
    // Exhausted — open the Usage modal and deny. Copy is INTENTIONALLY
    // gentle: reaching a quota cap isn't an error, it's a routine part
    // of using a free tier. The prefix "__quota__" is a sentinel the
    // error-banner renderer uses to switch to amber styling + softer
    // tone; the user never sees the prefix (it's stripped on render).
    setUserPanel("usage");
    setUiError(`__quota__You've used your ${USAGE_FEATURE_LABELS[feature]} allowance for today (${used}/${limit}). It refreshes at 00:00 UTC — or upgrade anytime for more headroom.`);
    return false;
  }, [usage.data]);

  /**
   * Server-side quota backstop. If an HTTP 429 lands with the X-Quota-Tier
   * header set (our backend's quota response signature, distinct from a
   * plain rate-limiter 429), open the Usage modal so the user sees their
   * counters and knows what to do. Returns `true` when the response was
   * handled as a quota error (caller should stop), `false` otherwise.
   */
  const handleQuotaResponse = useCallback((res: Response): boolean => {
    if (res.status !== 429) return false;
    const tier = res.headers.get("X-Quota-Tier");
    if (!tier) return false;
    void usage.refresh();
    setUserPanel("usage");
    const limit = res.headers.get("X-Quota-Limit");
    const used  = res.headers.get("X-Quota-Used");
    // `__quota__` sentinel → amber + gentle styling in the banner (see
    // the error-banner render site). Copy is reassuring, not alarming:
    // hitting a daily/monthly cap is an expected outcome on free tiers.
    setUiError(
      limit && used
        ? `__quota__You've reached today's allowance (${used}/${limit}). It refreshes at 00:00 UTC — or upgrade anytime for more headroom.`
        : "__quota__You've used your allowance for today. It refreshes at 00:00 UTC, or upgrade anytime for more headroom."
    );
    return true;
  }, [usage]);

  // ── Role & multi-account management ───────────────────────────────────────
  // Single source of truth for developer emails — used for role checks everywhere.
  const DEV_ACCTS = ["dev01@academicats.com", "dev02@academicats.com", "dev03@academicats.com"];
  const DEV_PWD   = process.env.NEXT_PUBLIC_DEV_PASSWORD ?? "";
  // userRole: "guest" | "user" | "dev"
  const userRole = !authUser ? "guest" : DEV_ACCTS.includes(authUser.email ?? "") ? "dev" : "user";
  const isDeveloper = userRole === "dev";
  type SavedAccount = { email: string; type: "dev" | "otp" | "oauth" };
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>(() => {
    try { return JSON.parse(localStorage.getItem("ats-saved-accounts") || "[]"); } catch { return []; }
  });
  const [addAcctInput, setAddAcctInput]       = useState("");
  const [acctSwitchMsg, setAcctSwitchMsg]     = useState<{ text: string; error?: boolean } | null>(null);
  const [acctSwitching, setAcctSwitching]     = useState<string | null>(null);

  const persistAccounts = (list: SavedAccount[]) => {
    localStorage.setItem("ats-saved-accounts", JSON.stringify(list));
    setSavedAccounts(list);
  };
  // Add a dev account manually via the Accounts input. Restricted to
  // the seeded DEV_ACCTS emails — regular / Google accounts auto-
  // register on login (see cacheAndRegister) and don't need manual
  // entry. Triggers a password sign-in so the refresh token lands in
  // the per-email cache immediately; the dev then shows up under
  // "Mounted accounts" with admin-access enabled.
  const addSavedAccount = async () => {
    const email = addAcctInput.trim().toLowerCase();
    if (!email) return;
    if (!DEV_ACCTS.includes(email)) {
      setAcctSwitchMsg({
        text: `Only dev accounts can be added here (dev01 / dev02 / dev03 @academicats.com). Regular accounts auto-mount on login.`,
        error: true,
      });
      return;
    }
    if (savedAccounts.some(a => a.email === email)) {
      setAddAcctInput("");
      setAcctSwitchMsg({ text: `${email} is already mounted.` });
      return;
    }
    setAddAcctInput("");
    setAcctSwitchMsg(null);
    setAcctSwitching(email);
    try {
      // Persist into the list first so the pill appears even if login
      // is slow; the status pill will update to "Mounted" once the
      // session lands via cacheAndRegister.
      persistAccounts([...savedAccounts, { email, type: "dev" }]);
      const { error } = await supabase.auth.signInWithPassword({ email, password: DEV_PWD });
      if (error) {
        // Roll back the list entry — login failed, don't keep a ghost.
        persistAccounts(savedAccounts.filter(a => a.email !== email));
        setAcctSwitchMsg({ text: error.message, error: true });
      } else {
        setAcctSwitchMsg({ text: `${email} mounted. Admin access is now available.` });
      }
    } catch (e) {
      persistAccounts(savedAccounts.filter(a => a.email !== email));
      setAcctSwitchMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setAcctSwitching(null);
    }
  };
  const removeSavedAccount = (email: string) => {
    // Dropping the account also drops its cached session — no point
    // keeping auth tokens around for an account the user has forgotten.
    try { localStorage.removeItem(_sessionKey(email)); } catch { /* ignore */ }
    persistAccounts(savedAccounts.filter(a => a.email !== email));
  };

  const handleGoogleLogin = async () => {
    const redirectTo = typeof window !== 'undefined' ? `${window.location.origin}/` : 'https://academic-ats-frontend.vercel.app/';
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  };

  // ── Multi-session session-cache ─────────────────────────────────────────
  // Supabase only keeps ONE active session at a time — signing into
  // account B replaces the tokens for account A in the shared
  // `sb-<ref>-auth-token` slot. To support "switch between accounts
  // without re-authenticating each time", we shadow-cache the refresh
  // token for every session we see under a per-email key. When the
  // user clicks Switch, we pull the stored refresh token for the
  // target account and call auth.setSession() to restore it instantly.
  // Fallback to the full password / magic-link flow if no cached
  // session exists or the refresh token has expired.

  type CachedSession = { access_token: string; refresh_token: string };

  // Defined at the top of the hook scope so handlers can reference it
  // without worrying about JS hoisting / closure capture.
  function _sessionKey(email: string): string {
    return `ats-session::${email.toLowerCase()}`;
  }

  function _cacheSession(email: string, s: CachedSession) {
    try { localStorage.setItem(_sessionKey(email), JSON.stringify(s)); } catch { /* quota — ignore */ }
  }

  function _loadCachedSession(email: string): CachedSession | null {
    try {
      const raw = localStorage.getItem(_sessionKey(email));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.refresh_token) return null;
      return parsed as CachedSession;
    } catch {
      return null;
    }
  }

  // When an account-switch target has a cached refresh token, this path
  // calls auth.setSession() which validates the token against Supabase
  // and — if still valid — re-establishes the full session client-side
  // (writes the shared sb-auth-token slot, fires SIGNED_IN). Returns
  // true on success, false if the cached token is expired / invalid so
  // the caller can fall back to a fresh login.
  async function _restoreCachedSession(email: string): Promise<boolean> {
    const cached = _loadCachedSession(email);
    if (!cached) return false;
    try {
      const { error } = await supabase.auth.setSession({
        access_token:  cached.access_token,
        refresh_token: cached.refresh_token,
      });
      if (error) {
        // Token expired or revoked — drop the cache so we don't keep
        // trying this dead session on future switch attempts.
        try { localStorage.removeItem(_sessionKey(email)); } catch { /* ignore */ }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  const switchToAccount = async (acct: SavedAccount) => {
    setAcctSwitchMsg(null);
    setAcctSwitching(acct.email);
    try {
      // Step 1 — save the current session under its own email so the
      // user can flip back to it later without re-auth. Runs even if
      // the switch below ultimately fails; the cached token remains
      // valid until Supabase rotates its refresh family.
      const { data: { session: current } } = await supabase.auth.getSession();
      const currentEmail = current?.user?.email;
      if (currentEmail && current?.refresh_token && current?.access_token) {
        _cacheSession(currentEmail, {
          access_token:  current.access_token,
          refresh_token: current.refresh_token,
        });
      }

      // Step 2 — try the cached-session fast path first. A hit means
      // zero network round-trips visible to the user (setSession's
      // refresh call is sub-second) and no emails / passwords.
      const restored = await _restoreCachedSession(acct.email);
      if (restored) {
        setUserPanel(null);
        setUserMenuOpen(false);
        setAcctSwitchMsg({ text: `Switched to ${acct.email}` });
        return;
      }

      // Step 3 — no cached session (or it expired). Fall back to the
      // appropriate auth method for this account type. OAuth accounts
      // can only come back via their provider redirect, so we surface
      // a hint instead of silently doing nothing.
      if (acct.type === "dev") {
        const { error } = await supabase.auth.signInWithPassword({ email: acct.email, password: DEV_PWD });
        if (error) { setAcctSwitchMsg({ text: error.message, error: true }); }
        else { setUserPanel(null); setUserMenuOpen(false); }
      } else if (acct.type === "oauth") {
        setAcctSwitchMsg({
          text: `Session for ${acct.email} expired — please sign in again via Google.`,
          error: true,
        });
      } else {
        const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/` : "/";
        const { error } = await supabase.auth.signInWithOtp({ email: acct.email, options: { emailRedirectTo: redirectTo } });
        if (error) { setAcctSwitchMsg({ text: error.message, error: true }); }
        else { setAcctSwitchMsg({ text: `Magic link sent to ${acct.email} — check your inbox.` }); }
      }
    } catch (e: any) {
      setAcctSwitchMsg({ text: e?.message ?? "Unknown error", error: true });
    }
    setAcctSwitching(null);
  };
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);

  // ── Feedback modal (bug report button) ─────────────────────────────────
  // Floating feedback button at the bottom-right opens this modal. POSTs to
  // /api/feedback; rows land in the feedback table and surface in the
  // /admin inbox. Replaces an external feedback widget during alpha.
  const [feedbackOpen,     setFeedbackOpen]     = useState(false);
  const [feedbackCategory, setFeedbackCategory] = useState<"bug" | "feature" | "general">("bug");
  const [feedbackText,     setFeedbackText]     = useState("");
  const [feedbackSending,  setFeedbackSending]  = useState(false);
  const [feedbackMsg,      setFeedbackMsg]      = useState<{ text: string; error?: boolean } | null>(null);
  // `autoPromptedFeedback` = the modal was opened by the "5 uses" trigger,
  // not by the floating bug-report button. Used to show a friendlier header
  // ("How's it going?" instead of "Report a bug") and to auto-select the
  // general category. Reset whenever the modal closes.
  const [autoPromptedFeedback, setAutoPromptedFeedback] = useState(false);

  // ── Auto-prompt feedback after N metered actions ────────────────────────
  // Watches the Zustand usage-prompt counter. When it crosses the threshold
  // and we haven't prompted before (shouldPromptFeedback returns true), we
  // open the modal ONCE and immediately mark it as prompted so we don't
  // loop. The modal itself handles dismiss/submit; both paths leave
  // promptedAt set, so this effect never re-fires for this browser.
  const promptUsageCount       = useUsagePromptStore(s => s.usageCount);
  const promptLastPromptedCount = useUsagePromptStore(s => s.lastPromptedCount);
  useEffect(() => {
    if (!shouldPromptFeedback({ usageCount: promptUsageCount, lastPromptedCount: promptLastPromptedCount })) return;
    // Open the feedback modal in "gentle nudge" mode. category=general is
    // the right default for unsolicited feedback (they didn't click "bug").
    setFeedbackCategory("general");
    setAutoPromptedFeedback(true);
    setFeedbackOpen(true);
    // Persist the prompt marker immediately so this effect doesn't re-fire
    // on the same usageCount (e.g. after a reload during the modal session).
    useUsagePromptStore.getState().markPrompted();
  }, [promptUsageCount, promptLastPromptedCount]);

  // ── Dev account sign-in (login-required overlay) ─────────────────────────
  // Lets operators sign in as dev01/02/03 from the main login screen
  // without routing through Google. Keeps the subset of dev tooling
  // usable during local smoke tests and when Google OAuth is blocked
  // (e.g. on a corp laptop). Uses the MAIN supabase client (not the
  // isolated admin client) because we want these creds to grant the
  // normal user session, not the /admin console session.
  const [devLoginOpen,     setDevLoginOpen]     = useState(false);
  const [devLoginEmail,    setDevLoginEmail]    = useState("dev01@academicats.com");
  const [devLoginPassword, setDevLoginPassword] = useState("");
  const [devLoginBusy,     setDevLoginBusy]     = useState(false);
  const [devLoginErr,      setDevLoginErr]      = useState("");

  const handleDevLogin = useCallback(async () => {
    setDevLoginErr("");
    const email = devLoginEmail.trim().toLowerCase();
    if (!email) { setDevLoginErr("Pick a dev account."); return; }
    if (!devLoginPassword) { setDevLoginErr("Password required."); return; }
    setDevLoginBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password: devLoginPassword,
      });
      if (error) setDevLoginErr(error.message);
      // success → onAuthStateChange clears the overlay.
    } catch (e) {
      setDevLoginErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDevLoginBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devLoginEmail, devLoginPassword]);

  const submitFeedback = useCallback(async () => {
    const message = feedbackText.trim();
    if (message.length < 3) {
      setFeedbackMsg({ text: "Please describe the issue in at least 3 characters.", error: true });
      return;
    }
    setFeedbackSending(true);
    setFeedbackMsg(null);
    try {
      const res = await fetchWithAuth(buildApiUrl("/api/feedback"), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          category: feedbackCategory,
          message,
          page_url: typeof window !== "undefined" ? window.location.href : "",
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      setFeedbackMsg({ text: "Thanks! Sent to the developers." });
      setFeedbackText("");
      // Auto-close after 1.2 s so the success message is visible briefly.
      window.setTimeout(() => { setFeedbackOpen(false); setFeedbackMsg(null); setAutoPromptedFeedback(false); }, 1200);
    } catch (e) {
      setFeedbackMsg({
        text: e instanceof Error ? e.message : String(e),
        error: true,
      });
    } finally {
      setFeedbackSending(false);
    }
  }, [feedbackCategory, feedbackText]);

  // ── Global frontend error logger ───────────────────────────────────────
  // Forwards window.onerror + unhandledrejection to the backend's
  // /api/errors endpoint so the /admin error log captures crashes from
  // the browser side (React render errors, async await failures, etc).
  // Non-authenticated endpoint so failures in the login flow still
  // telemeter. Rate-limited via the backend's anonymous bucket.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const post = (payload: { error_name?: string; message?: string; stack?: string }) => {
      try {
        const body = JSON.stringify({
          error_name: (payload.error_name || "Error").slice(0, 200),
          message:    (payload.message    || "").slice(0, 4000),
          stack:      (payload.stack      || "").slice(0, 8000),
          page_url:   window.location.href.slice(0, 500),
        });
        // Use keepalive + fetch so the request survives the crashing
        // tab / unload. No auth header — backend accepts anonymous.
        fetch(buildApiUrl("/api/errors"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => { /* swallow — nothing to do with a logging failure */ });
      } catch { /* ignore — the original error matters more */ }
    };
    const onError = (ev: ErrorEvent) => {
      post({
        error_name: ev.error?.name || "Error",
        message:    ev.message || String(ev.error),
        stack:      ev.error?.stack || "",
      });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason;
      post({
        error_name: (reason?.name as string) || "UnhandledRejection",
        message:    (reason?.message as string) || String(reason),
        stack:      (reason?.stack as string) || "",
      });
    };
    window.addEventListener("error",              onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error",              onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  const [historyPanelHeight, setHistoryPanelHeight] = useState(150);
  type HistoryEntry = { id: string; title: string; updated_at: string; result?: SearchResponse | null; directionData?: QueryDirectionsResponse | null; entryType?: "understand" | "search"; usedUnderstand?: boolean; isFast?: boolean };
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const [favoritedIds, setFavoritedIds] = useState<Set<string>>(new Set());
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const historyPanelRef = useRef<HTMLDivElement | null>(null);
  const authWidgetRef = useRef<HTMLDivElement | null>(null);

  const toggleFavorite = useCallback((id: string) => {
    setFavoritedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try { if (authUser?.email) localStorage.setItem(_fKey(authUser.email), JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const clearAllHistory = useCallback(async () => {
    // Optimistic local clear for instant UI feedback.
    setHistoryList([]);
    setActiveHistoryId(null);
    // Drop legacy per-account localStorage cache so a refresh can't resurrect rows.
    if (authUser?.email) {
      try { localStorage.removeItem(_hKey(authUser.email)); } catch { /* ignore */ }
    }
    // Cloud is source-of-truth — issue the authoritative delete + cache wipe.
    try {
      const token = await getAuthToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      await fetchWithApiFallback("/api/history", { method: "DELETE", headers });
    } catch (e) {
      console.warn("[history] cloud clear failed:", e);
    }
    try { await fetchWithApiFallback("/api/cache/clear", { method: "POST" }); } catch { /* best-effort */ }
  }, [authUser?.email]);

  const deleteHistoryEntry = useCallback((id: string) => {
    // Optimistic local removal; the authoritative delete happens on the server.
    setHistoryList(prev => prev.filter(e => e.id !== id));
    if (authUser?.email) {
      try {
        const raw = localStorage.getItem(_hKey(authUser.email));
        if (raw) localStorage.removeItem(_hKey(authUser.email));  // cloud-only now
      } catch { /* ignore */ }
    }
    (async () => {
      try {
        const token = await getAuthToken();
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        await fetchWithApiFallback(`/api/history/${encodeURIComponent(id)}`, { method: "DELETE", headers });
      } catch (e) {
        console.warn("[history] cloud delete failed:", e);
      }
    })();
  }, [authUser?.email]);

  const restoreHistory = useCallback((item: HistoryEntry) => {
    setQuery(item.title);
    setActiveHistoryId(item.id);
    // Restore understand directions if present
    if (item.directionData) {
      setDirectionData(item.directionData);
      setUnderstandOpen(true);
      setSelectedDirIndex(item.directionData.recommended_direction ?? 0);
      setSelectedSubIndex(item.directionData.recommended_sub ?? 0);
      setCustomQueryEnabled(false);
      setCustomQueryValue("");
    }
    // Restore search result if present
    if (item.result) {
      briefTextRef.current = item.result.brief || "";
      setBriefStreamText(item.result.brief || "");
      setStreamPapers(item.result.papers || []);
      setIsSubmitting(false);
      setJob({ status: "done", progress: 100, result: item.result, finished_at: Date.now() / 1000, message: "Finished.", workflow: [] } as any);
    }
  }, []);
  const authTokenRef = useRef<string | null>(null);
  const briefTextRef = useRef("");          // mirrors briefStreamText for use inside closures
  const briefQueueRef = useRef<string[]>([]); // RAF queue: tokens enqueued here, dequeued 3/frame
  const briefVersionRef = useRef(0);        // current SSE version accepted (0 = none received)
  const briefFlushGenRef = useRef(0);       // increments on version upgrade; RAF uses to discard stale batches
  const router = useRouter();


  // Timer — ticks while search is running AND the progress bar hasn't hit 100 yet.
  // "Bar at 100" mirrors the displayProgress useMemo logic but computed inline here
  // (using only state values declared above) to avoid a TDZ reference error.
  const _timerBarFull = !isSubmitting
    || (job?.status === "done")
    || (!fastMode && (streamPapers.length > 0 || job?.status === "done"))
    || (fastMode && Math.min(100, job?.progress ?? 0) >= 100);
  // Second gate: the Usage dashboard renders a live "Next refresh in …"
  // countdown; it needs the same 1 s tick so the digits actually update.
  // We OR the two conditions into a single `_needsTick` flag — the
  // interval runs whenever EITHER surface needs fresh seconds.
  const _needsTick = !_timerBarFull || userPanel === "usage";
  useEffect(() => {
    if (!_needsTick) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [_needsTick]);

  // ── Auth: load current session + subscribe to changes ─────────────────────
  //
  // Every valid session we observe — whether from the initial getSession,
  // a fresh login, or an OAuth redirect — gets mirrored into the
  // per-email session cache (_cacheSession) AND auto-registered in the
  // saved-accounts list. That makes "switch back to the account I was
  // just on" work without the user ever having to manually add it under
  // Accounts → Add. The cache persists across tabs (shared localStorage)
  // and survives until Supabase rotates or invalidates the refresh
  // family, so a day-later switch is usually still instant.
  useEffect(() => {
    const cacheAndRegister = (session: { access_token?: string; refresh_token?: string; user?: { email?: string | null } } | null) => {
      const email = session?.user?.email?.toLowerCase();
      if (!email || !session?.access_token || !session?.refresh_token) return;
      _cacheSession(email, {
        access_token:  session.access_token,
        refresh_token: session.refresh_token,
      });
      // Auto-register NON-dev accounts so a Google login lands in the
      // mounted list without a manual step. Dev accounts are NOT
      // auto-added here — they must be explicitly added via the dev
      // input in the Accounts panel so the list doesn't accumulate the
      // three seeded dev accounts by default. The token cache above
      // still gets written for ALL accounts (including dev) so /admin
      // impersonation still works once the dev signs in.
      if (DEV_ACCTS.includes(email)) return;
      setSavedAccounts(prev => {
        if (prev.some(a => a.email === email)) return prev;
        const type: SavedAccount["type"] = email.endsWith("@gmail.com") ? "oauth" : "otp";
        const next = [...prev, { email, type }];
        try { localStorage.setItem("ats-saved-accounts", JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      });
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      authTokenRef.current = session?.access_token ?? null;
      setAuthUser(session?.user ?? null);
      cacheAndRegister(session);
      console.log("[auth] getSession →", session?.user?.email ?? "no session", "| token:", session?.access_token ? "✓" : "✗");
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      authTokenRef.current = session?.access_token ?? null;
      setAuthUser(session?.user ?? null);
      cacheAndRegister(session);
      console.log("[auth] onAuthStateChange →", session?.user?.email ?? "signed out", "| token:", session?.access_token ? "✓" : "✗");
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reload on account switch / sign-out ─────────────────────────────────
  // When the live session's email actually CHANGES (not the first load,
  // not a first-time sign-in), the cleanest way to avoid stale data
  // leaking from one account into another is to full-reload the page.
  // Transitions:
  //   undefined → X  = initial mount        → no reload
  //   null      → X  = first-time login     → no reload (no data to clear)
  //   X         → Y  = account switch       → reload
  //   X         → null = sign-out           → reload
  const prevAuthEmailRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev    = prevAuthEmailRef.current;
    const current = authUser?.email ?? null;
    if (prev === undefined) {
      prevAuthEmailRef.current = current;
      return;
    }
    if (prev === current) return;
    prevAuthEmailRef.current = current;
    // Only reload when there WAS a previous non-null user — otherwise
    // we'd reload right after a first-time sign-in, which is annoying
    // and pointless (nothing to clear).
    if (prev !== null) {
      try { window.location.reload(); } catch { /* ignore — test env */ }
    }
  }, [authUser?.email]);

  // ── Per-user localStorage key helpers ────────────────────────────────────
  const _hKey = (email: string) => `ats-search-history::${email}`;
  const _fKey = (email: string) => `ats-history-favorites::${email}`;

  // Mirror historyList into localStorage so a reload shows the timeline instantly
  // and optimistic entries survive until the cloud catches up. Delete / clear
  // actions already overwrite this mirror explicitly.
  useEffect(() => {
    const email = authUser?.email;
    if (!email) return;
    try { localStorage.setItem(_hKey(email), JSON.stringify(historyList.slice(0, 50))); } catch { /* quota — ignore */ }
  }, [historyList, authUser?.email]);

  // Load / reload history whenever the logged-in user changes.
  // Cloud is the authoritative source but we KEEP a small local-storage mirror so
  // new entries are visible even if the backend hasn't finished writing, and so
  // the timeline survives a refresh while the cloud fetch is still in flight.
  // Delete/clear paths explicitly wipe both.
  useEffect(() => {
    const email = authUser?.email;
    if (!email) { setHistoryList([]); setFavoritedIds(new Set()); return; }

    // Hydrate immediately from local mirror so the panel isn't blank for a second.
    try {
      const raw = localStorage.getItem(_hKey(email));
      if (raw) {
        const cached: HistoryEntry[] = JSON.parse(raw);
        if (Array.isArray(cached)) {
          setHistoryList(cached.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()));
        }
      }
    } catch { /* ignore */ }

    // Favorites stay local — they are a UI preference, not content.
    try { setFavoritedIds(new Set(JSON.parse(localStorage.getItem(_fKey(email)) || "[]"))); } catch { setFavoritedIds(new Set()); }

    const API = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
    getAuthToken().then(token => {
      if (!token) return;        // keep whatever we hydrated from local cache
      fetch(`${API}/api/history?limit=50`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then((cloudItems: HistoryEntry[]) => {
          // Merge cloud + any pending local rows (cloud takes precedence on id match).
          let localItems: HistoryEntry[] = [];
          try { localItems = JSON.parse(localStorage.getItem(_hKey(email)) || "[]"); } catch {}
          const cloudIds = new Set(cloudItems.map(c => c.id));
          const pending = localItems.filter(l => !cloudIds.has(l.id) && String(l.id).startsWith("pending-"));
          const sorted = [...cloudItems, ...pending].sort(
            (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          );
          setHistoryList(sorted);
          // Refresh the local mirror with the merged list so the next load is fast AND correct.
          try { localStorage.setItem(_hKey(email), JSON.stringify(sorted)); } catch {}
        })
        .catch((err) => { console.warn("[history] cloud fetch failed:", err); setHistoryList([]); });
    });
  }, [authUser?.email]);

  // Legacy per-tab danmu storage — the announcement feed is now server-
  // backed (see useAnnouncements), so the old localStorage key is stale
  // noise. Clean it up once on mount so we don't leave the key sitting in
  // the browser forever.
  useEffect(() => {
    try { localStorage.removeItem("ats-public-msgs"); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!historyPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        historyPanelRef.current && !historyPanelRef.current.contains(e.target as Node) &&
        authWidgetRef.current && !authWidgetRef.current.contains(e.target as Node)
      ) {
        setHistoryPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [historyPanelOpen]);

  async function handleSendMessage() {
    const text = msgInput.trim();
    if (!text || msgSending) return;
    setMsgSending(true);
    try {
      // Both signed and anonymous modes post to the shared ticker — the
      // only difference is what the server records for author_email.
      // Supabase Realtime pushes the insert to every open tab so everyone
      // sees it within a second.
      const { ok, error } = await announcementsFeed.post(text, { anonymous: msgAnonymous });
      if (!ok) {
        setUiError(error ?? "Could not broadcast announcement.");
        return;
      }
      setMsgInput("");
      setMsgSentOk(true);
      setTimeout(() => setMsgSentOk(false), 2500);
    } finally {
      setMsgSending(false);
    }
  }


  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!gridRef.current || !dragRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const pct = (x / rect.width) * 100;

      // Generous clamps — the floor sits below the 1:5:1 initial layout (leftPct≈14.3)
      // so dragging immediately expands the left panel instead of snapping to a wider
      // minimum. The ceiling gives each panel enough headroom to dominate the screen.
      if (dragRef.current === "left") {
        const newLeft = clamp(pct, 8, 72);
        const remainingForCenterAndRight = 100 - newLeft;
        const adjustedCenter = clamp(centerPct, 14, remainingForCenterAndRight - 8);
        setLeftPct(newLeft);
        setCenterPct(adjustedCenter);
      }

      if (dragRef.current === "center") {
        const minBoundary = leftPct + 14;                  // workspace can shrink to 14%
        const newBoundary = clamp(pct, minBoundary, 92);   // right panel can grow to ~86%
        const newCenter = newBoundary - leftPct;
        setCenterPct(clamp(newCenter, 14, 84));
      }
    };

    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [leftPct, centerPct]);

  // ── Grid animation: grid-template follows the panel toggle IMMEDIATELY ──
  // Previously we delayed the grid-collapse by 920ms to avoid an fr→px
  // interpolation artefact. Now that tracks are all computed in uniform px
  // (see gridWidth below) the delay is counter-productive — it makes the
  // centre Workspace edge snap into place at the END of the side-panel slide
  // instead of sliding alongside it. Update the collapsed flags in sync with
  // leftVisible / analyticsVisible so every boundary eases at the same rate.
  useEffect(() => { setGridRightCollapsed(!analyticsVisible); }, [analyticsVisible]);
  useEffect(() => { setGridLeftCollapsed(!leftVisible);       }, [leftVisible]);

  // While a panel toggle is in flight, animate grid-template-columns so the
  // centre Workspace edge slides into its new position instead of snapping.
  // During mouse-drag the transition is suppressed (see gridIsDragging) so
  // live divider dragging still feels 1:1 with the pointer.
  const [gridTransitioning, setGridTransitioning] = useState(false);
  useEffect(() => {
    setGridTransitioning(true);
    const t = setTimeout(() => setGridTransitioning(false), 950);
    return () => clearTimeout(t);
  }, [leftVisible, analyticsVisible]);

  /** Animate the layout to 1:3:1 (20 / 60 / 20) with the same grid-transition
   *  feel used for panel toggles — the user sees the dividers slide into
   *  their "working" positions exactly like they dragged them there. */
  const snapToWorkingLayout = useCallback(() => {
    setGridTransitioning(true);
    setLeftPct(20);
    setCenterPct(60);
    window.setTimeout(() => setGridTransitioning(false), 950);
  }, []);

  /** Apply one of four layout-mode presets:
   *    default — both side panels open, balanced 1:3:1
   *    scholar — right panel HIDDEN, big left panel for charts / brief
   *    student — both visible, right (Lab) takes more space
   *    writing — left panel HIDDEN, right takes most of the room */
  const applyLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutMode(mode);
    setGridTransitioning(true);
    if (mode === "default") {
      setLeftVisible(true); setAnalyticsVisible(true);
      setLeftPct(20); setCenterPct(60);
    } else if (mode === "scholar") {
      setLeftVisible(true); setAnalyticsVisible(false);
      setLeftPct(32); setCenterPct(68);
    } else if (mode === "student") {
      // Student = focus on data → left big AND default to the Charts /
      // Analytics tab so the user lands in the visualization, not the
      // brief. Right Lab kept at modest size for note-taking.
      setLeftVisible(true); setAnalyticsVisible(true);
      setLeftPct(20); setCenterPct(50);   // → right ≈ 30
      setLeftTab("analytics");
    } else if (mode === "writing") {
      // Writing = focus on output → left collapsed, right big AND
      // default the right tab to Synthesis Lab (the actual writing
      // surface) instead of Paper Review.
      setLeftVisible(false); setAnalyticsVisible(true);
      setLeftPct(0); setCenterPct(48);    // → right ≈ 52
      setLabModule("synthesis");
    }
    window.setTimeout(() => setGridTransitioning(false), 950);
  }, []);

  // Layout-snap guard. The Run button owns the happy path: handleSearch()
  // flips this ref to true BEFORE kicking off the SSE so the grid
  // transition finishes before the panels fill with content (prevents the
  // grid reflow from colliding with streamed-paper/agent renders).
  //
  // The effect below is a fallback for entry points that don't go through
  // handleSearch — e.g. restoring a history item directly sets `job` /
  // `result` without touching isSubmitting. In that case we still want
  // the layout to snap into place when the restored papers render.
  const _autoSnappedRef = useRef(false);
  useEffect(() => {
    const hasPhaseResult =
      streamPapers.length > 0 ||
      job?.status === "done" ||
      !!job?.result;
    if (!hasPhaseResult || _autoSnappedRef.current) return;
    _autoSnappedRef.current = true;
    snapToWorkingLayout();
  }, [streamPapers.length, job?.status, job?.result, snapToWorkingLayout]);

  // Tracked container width for the 5-column grid. All five tracks are computed
  // in px from this value so grid-template-columns interpolates uniformly when
  // panels toggle — mixing fr + px caused the centre-edge to snap faster than
  // the side panels slid in.
  const [gridWidth, setGridWidth] = useState(0);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    setGridWidth(el.clientWidth);
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setGridWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // RAF flush loop: dequeues briefQueueRef 3 tokens per animation frame.
  // Even if all tokens arrive in one TCP packet, they render gradually (~60fps).
  // briefFlushGenRef captures the generation at splice time; if a version upgrade
  // incremented it before the functional update runs, the batch is silently discarded.
  useEffect(() => {
    let rafId: number;
    const flush = () => {
      const q = briefQueueRef.current;
      if (q.length > 0) {
        const capturedGen = briefFlushGenRef.current;
        const batch = q.splice(0, Math.min(q.length, 3));
        setBriefStreamText(prev => {
          if (briefFlushGenRef.current !== capturedGen) return prev;
          return prev + batch.join("");
        });
      }
      rafId = requestAnimationFrame(flush);
    };
    rafId = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Cascade agent "started" state based on which agents have completed.
  // Wave 1 (evidence_mapper + scholar) is triggered from the "papers" SSE event.
  // Wave 2 (gap_analyst/verifier) starts when scholar has results.
  useEffect(() => {
    if (fastMode || !isSubmitting) return;
    setStartedAgents(prev => {
      const s = new Set(prev);
      if ("scholar" in streamAgents) { s.add("gap_analyst"); s.add("verifier"); }
      return s;
    });
  }, [streamAgents, fastMode, isSubmitting]);

  const options = queryOptionsData?.options || [];
  const recommendedIndex = typeof queryOptionsData?.recommended_index === "number" ? queryOptionsData.recommended_index : 0;
  const effectiveSelectedIndex = selectedOptionIndex !== null ? selectedOptionIndex : options.length > 0 ? recommendedIndex : null;

  const selectedOption = useMemo((): QueryOption | null => {
    // User must explicitly choose a direction; no auto-recommend fallback here.
    // If a direction is chosen but no sub, fall back to the direction's label
    // as the search query (broad-mode). If neither, return null so the query
    // resolver uses the raw textarea value.
    //
    // When BOTH a direction and a sub-option are chosen we merge them: the
    // sub-option alone is often too narrow (its short phrasing drops the
    // parent anchor terms), so we append the parent direction's anchor words
    // that aren't already in the sub's query. Preserves sub focus while
    // grounding the query in the larger direction.
    if (directionData?.directions?.length && selectedDirIndex !== null) {
      const dir = directionData.directions[selectedDirIndex];
      if (dir) {
        if (selectedSubIndex !== null && dir.sub_options?.[selectedSubIndex]) {
          const sub = dir.sub_options[selectedSubIndex];
          const parentAnchor = (dir.search_query || dir.label || "").trim();
          const mergedQuery = mergeParentSubQuery(sub.search_query, parentAnchor);
          const mergedIntent = mergeIntentProfiles(sub.intent_profile, dir.keywords);
          return { label: sub.label, search_query: mergedQuery, reason: sub.reason, intent_profile: mergedIntent };
        }
        // Direction chosen, no sub → search the direction's label directly.
        return {
          label: dir.label,
          search_query: dir.search_query || dir.label,
          reason: dir.description ?? "",
          intent_profile: dir.keywords?.length ? { include: dir.keywords } : {},
        };
      }
    }
    if (effectiveSelectedIndex !== null && options[effectiveSelectedIndex]) return options[effectiveSelectedIndex];
    return null;
  }, [directionData, selectedDirIndex, selectedSubIndex, effectiveSelectedIndex, options]);

  const selectedSearchQuery = useMemo(() => {
    if (customQueryEnabled) return customQueryValue.trim();
    return (selectedOption?.search_query || query.trim()).trim();
  }, [customQueryEnabled, customQueryValue, selectedOption, query]);

  const progress = Math.max(0, Math.min(100, job?.progress ?? 0));
  // Deep mode: bar is driven by paper retrieval only — agents + brief do NOT advance it.
  // Fast mode: use raw backend progress as-is.
  const displayProgress = useMemo(() => {
    if (fastMode || !isSubmitting) return progress;
    // Deep mode: jump to 100 as soon as papers are retrieved (agents run in background, don't block progress)
    if (streamPapers.length > 0 || job?.status === "done") return 100;
    if (retrievalCount !== null && candidateLimit && candidateLimit > 0) {
      return Math.min(99, Math.round((retrievalCount / candidateLimit) * 100));
    }
    return Math.min(99, progress);
  }, [fastMode, isSubmitting, progress, streamPapers, job, retrievalCount, candidateLimit]);
  const result = job?.result || null;

  // ── Brief translation logic (continued from the state declarations above) ──
  // Defined here (after `result` is derived from `job`) so the
  // useCallback below can safely close over `result?.brief`.
  // On first mount, infer the user's preferred translation language from
  // navigator.language so the dropdown isn't always sitting on Chinese
  // (Simplified) for English speakers.
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const lang = (navigator.language || "").toLowerCase();
    let inferred = "Chinese (Simplified)";
    if (lang.startsWith("zh-tw") || lang.startsWith("zh-hk")) inferred = "Chinese (Traditional)";
    else if (lang.startsWith("zh"))    inferred = "Chinese (Simplified)";
    else if (lang.startsWith("ja"))    inferred = "Japanese";
    else if (lang.startsWith("ko"))    inferred = "Korean";
    else if (lang.startsWith("es"))    inferred = "Spanish";
    else if (lang.startsWith("fr"))    inferred = "French";
    else if (lang.startsWith("de"))    inferred = "German";
    else if (lang.startsWith("pt"))    inferred = "Portuguese";
    else if (lang.startsWith("ru"))    inferred = "Russian";
    else if (lang.startsWith("ar"))    inferred = "Arabic";
    else if (lang.startsWith("en"))    inferred = "English";
    setBriefTargetLang(inferred);
  }, []);

  // Blocking translation: POST the brief text + target language, wait
  // for the full translated markdown in one JSON response. Button
  // shows "Translating…" until the response arrives, then we swap
  // the rendered markdown block in one atomic update. Aborts cleanly
  // on new requests or unmount. After completion, briefTranslatedLang
  // is set so UI can detect "cached translation for current language".
  const requestBriefTranslation = useCallback(async () => {
    const source = (result?.brief || "").trim();
    if (!source) return;
    briefTransAbortRef.current?.abort();
    const ac = new AbortController();
    briefTransAbortRef.current = ac;
    setBriefTranslated("");
    setBriefTransError("");
    setBriefTranslating(true);
    setBriefShowTrans(true);
    const targetLang = briefTargetLang;
    try {
      const token = await getAuthToken();
      const res = await fetch(buildApiUrl("/api/brief/translate"), {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type":  "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          brief_text:      source,
          target_language: targetLang,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      }
      const data = await res.json() as { translated?: string; target_language?: string };
      if (!data?.translated || !data.translated.trim()) {
        throw new Error("Empty translation — try again or pick another language.");
      }
      setBriefTranslated(data.translated);
      setBriefTranslatedLang(targetLang);
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        setBriefTransError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBriefTranslating(false);
    }
  }, [result?.brief, briefTargetLang]);

  // Reset translation state whenever a new brief arrives (new search).
  // Prevents a stale translation from leaking under the toggle for the
  // next query's brief.
  useEffect(() => {
    setBriefTranslated("");
    setBriefShowTrans(false);
    setBriefTransError("");
    setBriefTranslatedLang("");
    briefTransAbortRef.current?.abort();
  }, [result?.brief]);

  // Run-time label: ticks while isSubmitting, freezes when job finishes
  const runTimeLabel = (() => {
    const startedAt = job?.started_at;
    if (!startedAt) return null;
    const end = job?.finished_at ?? nowMs / 1000;
    return formatDuration(end - startedAt);
  })();

  // Convert plain-text section headers to markdown ## headings for proper rendering
  const BRIEF_HEADERS: Record<string, boolean> = {
    // Standard set
    "Bottom Line": true, "What This Literature Actually Covers": true,
    "Strongest Signals": true, "Conceptual Framing": true,
    "Methodological Reading": true, "Where the Evidence Is Thin": true,
    "Research Gaps": true, "What This Means for Your Question": true,
    "Best Next Directions": true, "Confidence & Scope Note": true,
    "Key Papers & Themes": true, "Methodological Profile": true,
    "Gaps & What's Missing": true, "Confidence Note": true,
    // Common LLM-generated names
    "Field Overview": true, "Core Findings": true, "Core Themes": true,
    "Field Coverage": true, "Overview": true, "Summary": true,
    "Key Findings": true, "Key Themes": true, "Main Findings": true,
    "Research Gaps & Open Questions": true, "Open Questions": true,
    "Gaps and Open Questions": true, "Gaps & Open Questions": true,
    "Methodology": true, "Methodological Notes": true, "Methods": true,
    "Theoretical Framing": true, "Theoretical Framework": true,
    "Evidence Quality": true, "Evidence Summary": true,
    "Practical Implications": true, "Implications": true,
    "Future Directions": true, "Recommendations": true,
    "Conclusion": true, "Limitations": true, "Discussion": true,
  };
  function formatBriefAsMarkdown(text: string): string {
    if (!text) return text;
    // Already has markdown headers — strip top-level title only
    if (/^#{1,3} /m.test(text)) {
      return text.replace(/^#\s+Research Brief[^\n]*\n?/m, "").trimStart();
    }
    // Convert **bold-only lines** (LLM sometimes uses **Header** instead of ##)
    // and known section names to ## headings
    return text.split("\n").map((line) => {
      const t = line.trim();
      if (!t) return line;
      // Bold-only line: **Some Header** → ## Some Header
      const boldMatch = t.match(/^\*\*([^*]{2,60})\*\*\s*:?\s*$/);
      if (boldMatch) return `## ${boldMatch[1]}`;
      // Known header lookup
      if (BRIEF_HEADERS[t]) return `## ${t}`;
      // Heuristic: short (2-7 words), no sentence-ending punctuation, not starting with bullet
      const words = t.split(/\s+/);
      if (
        words.length >= 2 && words.length <= 7 &&
        !/[.,:;!?]$/.test(t) &&
        !/^[-*•]/.test(t) &&
        /^[A-Z]/.test(t)
      ) return `## ${t}`;
      return line;
    }).join("\n");
  }

  const isStreamingBrief = isSubmitting && briefStreamText.length > 0;
  // Once SSE brief chunks arrive (version > 0), trust only the streamed text.
  // result?.brief is only a valid fallback for history restores (briefVersionRef stays 0).
  const researchBriefMarkdown = formatBriefAsMarkdown(
    briefStreamText || (briefVersionRef.current === 0 ? result?.brief : "") || ""
  );

  // Stable ReactMarkdown component map — empty deps array means this object is created ONCE
  // and never replaced, so ReactMarkdown never unmounts/remounts its subtree when other state
  // changes (that was the root cause of the post-SSE "twitch").
  // New DOM nodes added during streaming still play fade-in on first mount. ✓
  const mdComponents = useMemo(() => ({
    h1: ({ children }: { children?: React.ReactNode }) => (
      <h1 className="fade-in mt-6 mb-3 pb-1.5 text-[1.15rem] font-black tracking-tight text-blue-300 border-b-2 border-blue-500/40 not-italic">{children}</h1>
    ),
    h2: ({ children }: { children?: React.ReactNode }) => (
      <h2 className="fade-in mt-5 mb-2 pb-1 text-[1rem] font-extrabold tracking-wide uppercase text-blue-400 border-b border-blue-500/30 not-italic">{children}</h2>
    ),
    h3: ({ children }: { children?: React.ReactNode }) => (
      <h3 className="fade-in mt-4 mb-1.5 text-[0.88rem] font-bold text-sky-300 not-italic">{children}</h3>
    ),
    h4: ({ children }: { children?: React.ReactNode }) => (
      <h4 className="fade-in mt-3 mb-1 text-[0.78rem] font-semibold text-cyan-300 not-italic">{children}</h4>
    ),
    h5: ({ children }: { children?: React.ReactNode }) => (
      <h5 className="fade-in mt-2 mb-1 text-[0.72rem] font-semibold uppercase tracking-wider text-teal-300 not-italic">{children}</h5>
    ),
    h6: ({ children }: { children?: React.ReactNode }) => (
      <h6 className="fade-in mt-2 mb-1 text-[0.7rem] font-semibold text-slate-300 not-italic">{children}</h6>
    ),
    p:  ({ children }: { children?: React.ReactNode }) => <p  className="fade-in">{children}</p>,
    li: ({ children }: { children?: React.ReactNode }) => <li className="fade-in">{children}</li>,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // Papers: once the final result arrives, prefer result.papers (properly LLM-scored).
  // While waiting (phase 1 streaming), fall back to streamPapers (rule-scored candidates).
  const displayedPapers: Paper[] = useMemo(() => {
    const base: Paper[] = (result?.papers?.length ? result.papers : null) ?? (streamPapers.length > 0 ? streamPapers : []);
    const toNum = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : -1; };
    const copy = [...base];
    if (sortMode === "Relevance score")   copy.sort((a, b) => toNum(b.evidence_score ?? b.score) - toNum(a.evidence_score ?? a.score));
    else if (sortMode === "Evidence strength") copy.sort((a, b) => toNum(b.evidence_score) - toNum(a.evidence_score));
    else if (sortMode === "Research fit") copy.sort((a, b) => toNum(b.research_fit_score) - toNum(a.research_fit_score));
    else if (sortMode === "Newest first") copy.sort((a, b) => toNum(b.year) - toNum(a.year));
    else if (sortMode === "Open access first") copy.sort((a, b) => (b.is_oa ? 1 : 0) - (a.is_oa ? 1 : 0));
    // "Balanced" keeps backend order
    return copy;
  }, [streamPapers, result, sortMode]);
  // Phase-1 streaming only applies in deep mode (fast mode shows final card immediately)
  const papersAreStreaming = !fastMode && isSubmitting && streamPapers.length > 0 && !result;

  // Retrieved sample-pool size for the header counter ("X of Y retrieved").
  // We take the MAX across the whole retrieval funnel so the label always
  // reflects the biggest candidate pool we ever saw — typically
  // retrieved_total (raw hits from Semantic Scholar / OpenAlex / Crossref /
  // arXiv / etc. before dedup, filters, and LLM re-ranking). This makes the
  // selection provenance visible: the user sees we surfaced N strong papers
  // out of hundreds of candidates, not just "here are N papers".
  const retrievedPoolSize: number = useMemo(() => {
    const f = result?.diagnostics?.retrieval_funnel;
    if (!f) return 0;
    return Math.max(
      Number(f.retrieved_total) || 0,
      Number(f.after_filters)   || 0,
      Number(f.stage2_pool)     || 0,
      Number(f.final_count)     || 0,
    );
  }, [result]);

  // Agents: merge streamed results with final result (stream takes live priority)
  const agentData = {
    evidence_mapper: (streamAgents.evidence_mapper ?? result?.evidence_mapper) as AgentPayload | undefined,
    scholar:         (streamAgents.scholar         ?? result?.scholar)         as AgentPayload | undefined,
    gap_analyst:     (streamAgents.gap_analyst     ?? result?.gap_analyst)     as AgentPayload | undefined,
    verifier:        (streamAgents.verifier        ?? result?.verifier)        as AgentPayload | undefined,
  };

  // Analytical Trace / Retrieval Strategy — each section is now rendered
  // inline below the Research Brief (no shared collapsible wrapper). Each
  // is gated on the presence of its own data so neither shows until the
  // pipeline has actually produced the corresponding artefact. During
  // `isSubmitting` they stay hidden; they appear ONLY when results arrive.
  // In Fast mode the backend skips the multi-agent pipeline entirely, so
  // there's nothing meaningful under "Analytical Trace". Hide the section
  // even if some stray agent field leaked in. Deep-mode still shows it
  // as soon as any agent produces output.
  const hasAgentOutput =
    !fastMode && (
      !!agentData.evidence_mapper ||
      !!agentData.scholar ||
      !!agentData.gap_analyst ||
      !!agentData.verifier
    );
  const hasStrategy = !!result?.strategy_summary;

  const toBackendPaper = (paper: Paper) => (paper.raw && typeof paper.raw === "object" ? paper.raw : paper);
  const hasDownloadSource = (paper: Paper) => {
    const backendPaper = toBackendPaper(paper);
    return Boolean(backendPaper.pdf_url || backendPaper.oa_url || backendPaper.url);
  };

  // ── Paywall / anti-bot awareness ────────────────────────────────────────
  // Some publishers reliably block our Deep Read / Download / Translate
  // pipeline — either their DRM / anti-bot layer blocks non-browser clients
  // (Elsevier, Wiley, Springer, T&F, SAGE) or their articles are paywalled
  // with no green-OA mirror (the common case for their closed content).
  // When Unpaywall / OpenAlex explicitly says a paper is NOT open access
  // AND the landing URL points at one of these domains, the three PDF-
  // dependent actions are going to fail 95%+ of the time. Pre-gating them
  // saves the user a click → wait → red error cycle.
  //
  // "Open Paper" always stays enabled because it just opens the
  // publisher's landing page in a new tab — that always works, it's the
  // PDF pipeline that doesn't.
  //
  // We keep the buttons ENABLED (not gated) whenever Unpaywall has found
  // any OA signal (is_oa=true OR an oa_url is present), because there
  // might still be a green-OA mirror (institutional repo, arXiv, PMC) we
  // can fall back to.
  const PAYWALLED_HOST_RE = /(?:sciencedirect\.com|onlinelibrary\.wiley\.com|link\.springer\.com|tandfonline\.com|journals\.sagepub\.com|ieeexplore\.ieee\.org|dl\.acm\.org|nature\.com|science\.org|pnas\.org|cambridge\.org|oup\.com|jstor\.org)/i;
  const PAYWALLED_DOI_PREFIX = ["10.1016/", "10.1002/", "10.1111/", "10.1007/", "10.1057/", "10.1080/", "10.1177/", "10.1109/", "10.1145/", "10.1038/", "10.1126/", "10.1073/", "10.1017/", "10.1093/"];

  const classifyPaperAccess = (paper: Paper): { accessible: boolean; reason: string } => {
    const backendPaper = toBackendPaper(paper);
    // No source URL at all → backend has nothing to try.
    if (!backendPaper.pdf_url && !backendPaper.oa_url && !backendPaper.url) {
      return { accessible: false, reason: "No download source linked for this paper." };
    }
    // Trust any OA signal — don't over-gate green OA that lives on a
    // paywalled publisher's domain (some arXiv-mirrored papers still
    // have a Nature landing page as their primary URL).
    if (backendPaper.pdf_url || backendPaper.oa_url || backendPaper.is_oa === true) {
      return { accessible: true, reason: "" };
    }
    // Known-paywalled publisher + no OA signal anywhere → likely blocked.
    const landingUrl = String(backendPaper.url || "");
    const doi = String(backendPaper.doi || "").toLowerCase();
    const hostHit = PAYWALLED_HOST_RE.test(landingUrl);
    const doiHit = PAYWALLED_DOI_PREFIX.some(p => doi.startsWith(p));
    if ((hostHit || doiHit) && backendPaper.is_oa !== true) {
      return {
        accessible: false,
        reason: "This publisher doesn't expose a public PDF to automated tools (paywall / anti-bot). Try the publisher's page directly via Open Paper.",
      };
    }
    return { accessible: true, reason: "" };
  };

  // Soft-classify an error message returned by the deep-read / download /
  // translate endpoints. When the failure is "publisher didn't give us a
  // PDF" (paywall, anti-bot, stale OA, no direct download) we want to
  // show a MUTED / neutral message, not a scary red error — the user
  // didn't do anything wrong, we just can't reach the content.
  // Keywords cover the backend's _NO_PDF_ERROR_MESSAGE template in
  // deep_read_service.py plus common upstream error fragments we've
  // observed in production logs.
  const isSoftAccessError = (message: string): boolean => {
    const s = (message || "").toLowerCase();
    return (
      s.includes("couldn't fetch") ||
      s.includes("couldn’t fetch") ||
      s.includes("no direct download") ||
      s.includes("paywall") ||
      s.includes("anti-bot") ||
      s.includes("publisher") ||
      s.includes("institutional access") ||
      s.includes("open-access link") ||
      s.includes("open access link") ||
      s.includes("no pdf") ||
      s.includes("not publicly accessible") ||
      s.includes("javascript-rendered") ||
      s.includes("403") ||
      s.includes("forbidden") ||
      // Truncated / corrupt PDF transport errors — pypdf throws
      // PdfStreamError("Stream has ended unexpectedly") when the
      // publisher's server sends an incomplete response. Same UX
      // category as a paywall (not our bug, nothing the user can
      // debug) so render gray. The backend now wraps these in a
      // user-friendly message that also contains "publisher"
      // (already matched above), but the extra keywords here
      // belt-and-suspenders the detection.
      s.includes("truncated") ||
      s.includes("corrupt") ||
      s.includes("incomplete pdf") ||
      s.includes("stream has ended") ||
      s.includes("pdfstreamerror") ||
      s.includes("pdfreaderror") ||
      s.includes("could not parse pdf") ||
      s.includes("partial response")
    );
  };

  const triggerDownload = async (
    url: string,
    body: Record<string, any>,
    fallbackFilename: string,
    key: string,
    signal?: AbortSignal,
  ) => {
    try {
      setOriginalErrors((prev) => ({ ...prev, [key]: "" }));
      setTranslateErrors((prev) => ({ ...prev, [key]: "" }));
      setOriginalLoading((prev) => ({ ...prev, [key]: key.includes("-original") || key === "brief-download" }));
      setTranslateLoading((prev) => ({ ...prev, [key]: key.includes("-translate") }));
      const pathOrUrl = url.startsWith("http://") || url.startsWith("https://") ? url : url;
      const res = pathOrUrl.startsWith("/")
        ? await fetchWithApiFallback(pathOrUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
          }, true)
        : await fetch(pathOrUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
          });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, `Download failed: ${res.status}`));
      }
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
      const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
      const filename = utf8Match ? decodeURIComponent(utf8Match[1]) : (plainMatch?.[1] || fallbackFilename);
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (error) {
      const message = explainFetchError(error);
      if (key.includes("-translate")) {
        setTranslateErrors((prev) => ({ ...prev, [key.replace("-translate","")]: message }));
      } else if (key.includes("-original")) {
        setOriginalErrors((prev) => ({ ...prev, [key.replace("-original","")]: message }));
      } else {
        setUiError(message);
      }
    } finally {
      setOriginalLoading((prev) => ({ ...prev, [key]: false }));
      setTranslateLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  /** Download text content as styled HTML, TXT, or Markdown — always a direct file download. */
  function downloadTextAs(content: string, baseFilename: string, format: "html" | "txt" | "md") {
    if (format === "html") {
      // Convert markdown to basic HTML for a clean, printable document
      const escape = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const lines = content.split("\n");
      let html = "";
      for (const raw of lines) {
        const line = raw;
        if (/^## (.+)$/.test(line)) {
          html += `<h2>${escape(line.slice(3))}</h2>\n`;
        } else if (/^# (.+)$/.test(line)) {
          html += `<h1>${escape(line.slice(2))}</h1>\n`;
        } else if (/^---+$/.test(line.trim())) {
          html += `<hr>\n`;
        } else if (line.trim() === "") {
          html += `<p class="gap"></p>\n`;
        } else {
          const formatted = escape(line)
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.+?)\*/g, "<em>$1</em>");
          html += `<p>${formatted}</p>\n`;
        }
      }
      const full = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(baseFilename)}</title>
<style>
  body{font-family:Georgia,"Times New Roman",serif;max-width:820px;margin:48px auto;padding:0 40px;line-height:1.85;color:#111;font-size:12.5pt}
  h1{font-size:18pt;margin:1.5em 0 .5em}
  h2{font-size:14pt;margin:2em 0 .4em;border-bottom:1px solid #ccc;padding-bottom:.25em}
  p{margin:.5em 0;text-align:justify}
  p.gap{margin:0;height:.4em}
  hr{border:none;border-top:1px solid #bbb;margin:2em 0}
  @page{margin:2.5cm}
  @media print{body{margin:0;padding:1cm}}
</style>
</head>
<body>
${html}
</body>
</html>`;
      const blob = new Blob([full], { type: "text/html;charset=utf-8" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url;
      a.download = `${baseFilename}.html`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const mime = format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
    const ext  = format === "md" ? ".md" : ".txt";
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `${baseFilename}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }


  async function handleSearch() {
    if (!authUser) { router.push("/login"); return; }
    const trimmed = query.trim();
    if (!trimmed || isSubmitting) return;
    if (!sourceFilters.length) {
      setUiError("Please select at least one source.");
      return;
    }
    // Client-side quota preflight. Server is still the source of truth
    // (HTTP 429 backstop) but a local short-circuit gives the user an
    // immediate, in-modal explanation instead of a network round-trip.
    if (!ensureQuota(fastMode ? "quick_search" : "deep_search")) return;

    // Snapshot the current layout BEFORE we auto-expand panels + snap
    // the column ratios — Stop uses this to revert the user back to
    // whatever they had on screen (e.g. both side panels collapsed,
    // textarea-only landing) instead of stranding them in the running-
    // search layout after an explicit abort.
    prePuttingSearchLayoutRef.current = { leftVisible, analyticsVisible, leftPct, centerPct };

    // Apply the user's chosen layout mode (default / scholar / student /
    // writing). The mode dictates which side panels open and how the
    // column ratios divide — replaces the old hardcoded 1:3:1 snap so a
    // user who picked, say, Scholar mode keeps the right panel collapsed
    // when they hit Run instead of seeing it pop open against their will.
    _autoSnappedRef.current = false;
    applyLayoutMode(layoutMode);
    _autoSnappedRef.current = true;

    const _usedUnderstand = directionData !== null;
    abortRef.current = new AbortController();
    setIsSubmitting(true);
    // First search of this session flips the textarea into its compact
    // layout. Before this point, focusing / typing leaves the textarea at
    // its tall "greeting" height so users have room to draft a long
    // question. See useLayoutEffect on [hasRunSearch, isSubmitting] above.
    setHasRunSearch(true);
    setUiError("");
    setJob(null);
    briefVersionRef.current = 0;       // reset: no SSE version received yet for this search
    briefFlushGenRef.current += 1;     // invalidate any stale RAF batches from previous search
    briefTextRef.current = "";
    briefQueueRef.current = [];
    setBriefStatus(null);
    setStreamPapers([]);
    setStreamAgents({});
    setStartedAgents(new Set());
    setPlannerThinking(null);
    setDeepReadResults({});
    setDeepReadErrors({});
    setOriginalErrors({});
    setTranslateErrors({});
    setRetrievalCount(null);
    setCandidateLimit(null);
    setRawProgressMsg("");
    // Show the actual search query that will be used (refined/selected, not raw input)
    const effectiveQuery = selectedSearchQuery || trimmed;
    if (effectiveQuery !== trimmed) setQuery(effectiveQuery);
    // Collapse workspace panels so the run-status block is immediately visible
    setSettingsOpen(false);
    setUnderstandOpen(false);
    setQueryOptionsData(null);

    const payload = {
      query: trimmed,
      final_search_query: selectedSearchQuery || trimmed,
      selected_option: customQueryEnabled
        ? {
            label: "Custom query",
            search_query: selectedSearchQuery || trimmed,
            reason: "User-entered custom search query.",
            confidence: 1.0,
            intent_profile: selectedOption?.intent_profile || {},
          }
        : selectedOption || null,
      fast_mode: fastMode,
      paper_count: paperCount,
      sort_mode: sortMode,
      prefer_abstracts: preferAbstracts,
      strict_core_only: strictCoreOnly,
      open_access_only: openAccessOnly,
      source_filters: sourceFilters,
      year_range: useYearRange ? [yearStart, yearEnd] : null,
      // Carry the Query Understanding context so it is persisted with the search history
      direction_data: directionData || null,
      selected_direction_index: selectedDirIndex ?? null,
      selected_sub_index: customQueryEnabled ? null : (selectedSubIndex ?? null),
    };

    try {
      const authToken = await getAuthToken();
      const authHeaders: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      const res = await fetchWithApiFallback("/api/search/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(payload),
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, `Search failed: ${res.status}`));
      }

      // Seed a running job state immediately so progress renders
      setJob({ status: "running", progress: 0, message: "Initializing...", workflow: [], started_at: Date.now() / 1000, finished_at: null });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sseEvent = "";
      let sseData = "";

      const flush = () => {
        if (!sseEvent || !sseData) { sseEvent = ""; sseData = ""; return; }
        try {
          const data = JSON.parse(sseData);
          if (sseEvent === "progress") {
            if (typeof data.retrieval_count === "number") {
              setRetrievalCount(data.retrieval_count);
            }
            if (typeof data.candidate_limit === "number" && data.candidate_limit > 0) {
              setCandidateLimit(data.candidate_limit);
            }
            if (typeof data.raw_message === "string" && data.raw_message) {
              setRawProgressMsg(data.raw_message);
            }
            setJob((prev) => ({
              ...prev,
              status: "running",
              progress: Math.max(prev?.progress ?? 0, data.progress ?? 0),
              message: data.message ?? prev?.message ?? "",
              workflow: data.workflow_item
                ? [...(prev?.workflow ?? []), data.workflow_item]
                : (prev?.workflow ?? []),
            }));
          } else if (sseEvent === "brief_chunk") {
            const incomingVersion = (data.version as number) ?? 1;
            const incomingStatus = (data.status as "draft" | "final") ?? "final";
            const chunk = (data.chunk as string) ?? "";

            if (incomingVersion < briefVersionRef.current) {
              // Stale chunk from a superseded phase — discard silently
            } else if (incomingVersion === briefVersionRef.current) {
              // Same version: append to RAF queue
              briefTextRef.current += chunk;
              briefQueueRef.current.push(chunk);
            } else {
              // Higher version: upgrade — clear display and start fresh
              const isFirstEver = briefVersionRef.current === 0;
              briefFlushGenRef.current += 1;     // invalidate any in-flight RAF batches
              briefVersionRef.current = incomingVersion;
              briefTextRef.current = chunk;
              briefQueueRef.current.length = 0;  // truncate in-place so RAF's captured ref also sees empty
              briefQueueRef.current.push(chunk);
              setBriefStatus(incomingStatus);
              setBriefStreamText("");            // clear display; RAF will fill from fresh queue
              if (isFirstEver) setLeftTab("brief");
            }
          } else if (sseEvent === "thinking") {
            setPlannerThinking(data as {planner_summary?: string; search_focus?: string; query_type?: string; agents_planned?: string[]});
          } else if (sseEvent === "papers") {
            if (Array.isArray(data.papers)) {
              setStreamPapers(data.papers);
              // Sync counter to actual paper count so label matches the full bar
              setRetrievalCount(data.papers.length);
              setCandidateLimit(data.papers.length);
              // All analysis agents start as soon as papers are retrieved
              if (!fastMode) {
                setStartedAgents(prev => {
                  const s = new Set(prev);
                  s.add("evidence_mapper"); s.add("scholar");
                  s.add("gap_analyst"); s.add("verifier");
                  return s;
                });
              }
            }
          } else if (sseEvent === "agent_result") {
            if (data.agent && data.data) {
              setStreamAgents((prev) => ({ ...prev, [data.agent]: data.data }));
            }
          } else if (sseEvent === "result") {
            // Belt-and-suspenders: capture brief if it wasn't streamed via brief_chunk
            const briefFallback = data.result?.brief || data.brief;
            if (briefFallback) {
              setBriefStreamText((prev) => prev || String(briefFallback));
            }
            setPlannerThinking(null);
            setJob((prev) => ({
              ...prev,
              status: "done",
              progress: 100,
              result: data.result ?? null,
              finished_at: Date.now() / 1000,
            }));
            // Metered action finished server-side; refresh the quota snapshot
            // so subscription + user-menu counters update without a reload.
            void usage.refresh();
            // Bump the local "feedback-prompt counter" so we can nudge the
            // user for feedback after FEEDBACK_PROMPT_THRESHOLD metered
            // actions (see effect below that watches usageCount).
            useUsagePromptStore.getState().increment();
            // ── Optimistic timeline insert; cloud is authoritative ─────────
            // The search endpoint writes its own history row server-side via
            // _write_history(); we just show immediate UI feedback and then refetch
            // to swap the optimistic entry for the authoritative cloud row.
            const _slim = data.result ? {
              ...data.result,
              brief: data.result.brief || briefTextRef.current || undefined,
              papers: (data.result.papers || []).map((p: Paper) => { const { raw: _r, ...rest } = p as any; return rest; }),
            } : null;
            const _histTitle = _slim?.final_search_query || _slim?.original_query || query.trim();
            const _histId = `pending-${Date.now()}`;
            const _histEntry: HistoryEntry = { id: _histId, title: _histTitle, updated_at: new Date().toISOString(), entryType: "search", usedUnderstand: _usedUnderstand, isFast: fastMode, result: _slim, directionData: directionData || undefined };
            setHistoryList(prev => [_histEntry, ...prev.filter(e => !String(e.id).startsWith("pending-"))].slice(0, 50));
            setActiveHistoryId(_histId);
            // Authoritative refetch — backend writes history via `_write_history()`
            // just after this SSE "result" event, which means the row is not
            // guaranteed to exist on the very next request. Retry with a gentle
            // back-off until we see a cloud entry matching our title, then swap
            // the pending row out. If nothing matches after a few seconds we
            // keep the pending entry so the user still sees their search.
            (async () => {
              const token = await getAuthToken();
              if (!token) return;
              const API = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
              const delays = [500, 1200, 2500, 4000];
              for (const d of delays) {
                await new Promise(r => setTimeout(r, d));
                try {
                  const r = await fetch(`${API}/api/history?limit=50`, { headers: { Authorization: `Bearer ${token}` } });
                  if (!r.ok) continue;
                  const cloudItems: HistoryEntry[] = await r.json();
                  const matched = cloudItems.some(ci => {
                    const t = (ci.title ?? "").trim();
                    const u = new Date(ci.updated_at).getTime();
                    return t === _histTitle.trim() && Date.now() - u < 120_000;
                  });
                  if (matched) {
                    const sorted = cloudItems.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
                    setHistoryList(sorted);
                    // Point the active-history indicator at the real row so re-clicks hit the server copy.
                    const cur = sorted.find(ci => (ci.title ?? "").trim() === _histTitle.trim());
                    if (cur?.id) setActiveHistoryId(cur.id);
                    return;
                  }
                } catch { /* keep retrying */ }
              }
            })();
          } else if (sseEvent === "error") {
            setJob((prev) => ({
              ...prev,
              status: "error",
              progress: 100,
              error: data.error ?? "Unknown error",
              finished_at: Date.now() / 1000,
            }));
          }
        } catch { /* ignore malformed SSE data */ }
        sseEvent = "";
        sseData = "";
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            sseEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            sseData = line.slice(6).trim();
          } else if (line === "") {
            flush();
          }
        }
      }
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        const baseMsg = explainFetchError(error);
        // Deep mode runs for 3-5 min; connection drops are common on proxies with short idle
        // timeouts.  Surface a helpful message so the user knows to retry rather than reload.
        const deepHint = !fastMode
          ? " Deep analysis can take 3-5 min. If the connection was cut by a proxy, please run the search again."
          : "";
        setUiError(baseMsg + deepHint);
      }
    } finally {
      setIsSubmitting(false);
      abortRef.current = null;
      // Drop the pre-search layout snapshot — a search that ran to
      // completion shouldn't auto-revert if the user hits Stop on a
      // FUTURE search; only the abort-immediately-after-start case
      // should restore.
      prePuttingSearchLayoutRef.current = null;
    }
  }

  function toggleSource(source: string) {
    setSourceFilters((prev) =>
      prev.includes(source) ? prev.filter((item) => item !== source) : [...prev, source]
    );
  }

  function startDrag(target: DragTarget) {
    dragRef.current = target;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // Full pristine reset — drops the user back at the landing exactly
  // as they first saw it. Aborts any in-flight search, clears the query
  // + sprite results, restores the default 14.3/71.4/14.3 layout and
  // re-collapses both side panels. Different from handleStop, which
  // PRESERVES the query + directions so the user can resume.
  // Defined as `const` (not `function`) because Turbopack's HMR
  // wrapper occasionally tree-shakes/re-orders top-of-component
  // function-declaration hoisting in dev — using a `const` fixes the
  // declaration order so the JSX renderer always sees the binding.
  const handleStartOver = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsSubmitting(false);
    setQuery("");
    setCommittedQuery("");
    setDirectionData(null);
    setSelectedDirIndex(null);
    setSelectedSubIndex(null);
    setCustomQueryEnabled(false);
    setCustomQueryValue("");
    setAssessmentMessage("");
    setButtonStep(0);
    setIntroStage("blank");
    setHasRunSearch(false);
    setJob(null);
    setStreamPapers([]);
    setStreamAgents({});
    setStartedAgents(new Set());
    setRetrievalCount(null);
    setCandidateLimit(null);
    setBriefStreamText("");
    setBriefStatus(null);
    // Layout snap back to the freshly-opened landing.
    setGridTransitioning(true);
    setLeftVisible(false);
    setAnalyticsVisible(false);
    setLeftPct(14.3);
    setCenterPct(71.4);
    window.setTimeout(() => setGridTransitioning(false), 950);
    prePuttingSearchLayoutRef.current = null;
    _autoSnappedRef.current = false;
  };

  function handleStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsSubmitting(false);
    // Restore the workspace to the "just opened" landing layout — both
    // side panels collapsed, default column ratios, textarea back to its
    // tall greeting mode, intro stage = blank — but PRESERVE the user's
    // query + sprite thinking results (directionData / decompose /
    // expand) so they can pick up exactly where they left off without
    // re-typing or re-running Find Angles.
    setGridTransitioning(true);
    setLeftVisible(false);
    setAnalyticsVisible(false);
    setLeftPct(14.3);
    setCenterPct(71.4);
    window.setTimeout(() => setGridTransitioning(false), 950);
    setIntroStage("blank");
    setHasRunSearch(false);
    setSelectedDirIndex(null);
    setSelectedSubIndex(null);
    setCommittedQuery("");
    // Wipe in-flight result state so the workspace doesn't display a
    // partial / stale search beneath the sprite. The query + directions
    // (sprite results) intentionally STAY.
    setJob(null);
    setStreamPapers([]);
    setStreamAgents({});
    setStartedAgents(new Set());
    setRetrievalCount(null);
    setCandidateLimit(null);
    setBriefStreamText("");
    setBriefStatus(null);
    prePuttingSearchLayoutRef.current = null;
    _autoSnappedRef.current = false;
  }

  // ── Synthesis Lab helpers ─────────────────────────────────────────────────
  const addToLab = useCallback((paper: Paper, key: string) => {
    setLabRefs(prev => prev.some(r => r.key === key) ? prev : [...prev, { key, paper }]);
    setAnalyticsVisible(true);
  }, []);

  const removeFromLab = useCallback((key: string) => {
    setLabRefs(prev => prev.filter(r => r.key !== key));
  }, []);

  function handleLabStop() {
    labAbortRef.current?.abort();
    labAbortRef.current = null;
  }

  async function handleSynthesize() {
    if (labRefs.length === 0) return;
    if (!ensureQuota("synthesis")) return;
    const ac = new AbortController();
    labAbortRef.current = ac;
    setLabGenerating(true);
    setLabResult("");
    setLabStatus("Starting synthesis…");
    setLabError("");
    setLabAgentLog([]);
    setLabReviewerNotes(null);
    // Reset the "already snapshotted" ref so the effect-driven archiver
    // fires again when this new run completes — even if the new output
    // text happens to equal a previous run's text verbatim.
    labLastSavedRef.current = "";
    // Any active "viewing past run" mode is cleared so the user sees
    // the new run streaming into the live buffer.
    setLabViewingId(null);
    try {
      const res = await fetchWithApiFallback("/api/forge/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: (() => {
          // Only send extras declared by the current spec — avoid leaking stale keys
          // from a previous output-type selection. Multi-entry fields are emitted as arrays.
          const _spec = labFieldSpec(labOutputType);
          const _extras: Record<string, string | string[]> = {};
          for (const f of (_spec.extras ?? [])) {
            if (f.multi) {
              const arr = (labExtrasMulti[f.key] ?? []).map(s => s.trim()).filter(Boolean);
              if (arr.length) _extras[f.key] = arr;
            } else {
              const v = (labExtras[f.key] ?? "").trim();
              if (v) _extras[f.key] = v;
            }
          }
          return JSON.stringify({
          papers:            labRefs.map(r => toBackendPaper(r.paper)),
          core_argument:     labCoreArg,
          supporting_points: labPoints.filter(p => p.trim()),
          extras:            _extras,
          output_type:       labOutputType,
          citation_format:   labCitationFormat,
          language:          labLanguage,
          target_pages:      labTargetPages,
          writing_model:     labWritingModel,
        });
        })(),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, `Synthesis failed: ${res.status}`));
      const reader  = res.body!.getReader();
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
            if (obj.chunk)  setLabResult(prev => prev + obj.chunk);
            if (obj.error)  setLabError(obj.error);
            if (obj.status) {
              setLabStatus(obj.status);
              // Parse agent log entries from format: "[AgentName] message text"
              const m = obj.status.match(/^\[([^\]]+)\]\s*(.*)/);
              if (m) {
                const agentName = m[1];
                const agentMsg  = m[2];
                // Special: FinalReview carries JSON suggestions
                if (agentName === "FinalReview") {
                  try {
                    setLabReviewerNotes(JSON.parse(agentMsg));
                  } catch { /* ignore */ }
                } else {
                  const isDone     = agentMsg.startsWith("✓");
                  const isError    = agentMsg.startsWith("✗");
                  const isRevision = agentMsg.startsWith("↩") || agentMsg.startsWith("↺");
                  setLabAgentLog(prev => {
                    const idx = prev.findIndex(e => e.name === agentName);
                    const entry = { name: agentName, msg: agentMsg, done: isDone, error: isError, revision: isRevision };
                    return idx >= 0
                      ? prev.map((e, i) => i === idx ? entry : e)
                      : [...prev, entry];
                  });
                }
              }
            }
          } catch { /* ignore malformed SSE */ }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setLabStatus("Stopped.");
      } else {
        setLabError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      labAbortRef.current = null;
      setLabGenerating(false);
      setLabStatus("");
      // Synthesis run just wrapped up (success or error). Refresh quota so
      // the counter in the user menu / subscription modal stays current.
      void usage.refresh();
      useUsagePromptStore.getState().increment();
    }
  }

  // ── Lab auto-snapshot: archive completed runs into labRuns ──────────────
  // Fires when generation transitions from in-flight (labGenerating=true)
  // to idle (labGenerating=false) AND the run produced non-empty output.
  // `labLastSavedRef` guards against double-archiving on re-renders.
  useEffect(() => {
    if (labGenerating) return;               // still streaming — wait
    const text = labResult.trim();
    if (!text) return;                       // empty output (stopped before any text)
    if (text === labLastSavedRef.current) return;  // already archived
    labLastSavedRef.current = text;
    const run: LabRun = {
      id:            `lab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text:          labResult,
      agentLog:      labAgentLog,
      reviewerNotes: labReviewerNotes,
      outputType:    labOutputType,
      createdAt:     Date.now(),
    };
    setLabRuns(prev => [...prev, run]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labGenerating, labResult, labAgentLog, labReviewerNotes, labOutputType]);

  // When the user tabs to a past run, we DON'T overwrite the live
  // labResult/labAgentLog/labReviewerNotes — we just display the past
  // run's snapshotted copies in the UI instead. The rest of the lab
  // panel reads from `displayedLab*` which alias to either the past
  // snapshot or the live state depending on labViewingId.
  const _viewedLabRun: LabRun | null = useMemo(
    () => labViewingId ? (labRuns.find(r => r.id === labViewingId) ?? null) : null,
    [labViewingId, labRuns],
  );
  const displayedLabResult        = _viewedLabRun ? _viewedLabRun.text          : labResult;
  const displayedLabAgentLog      = _viewedLabRun ? _viewedLabRun.agentLog      : labAgentLog;
  const displayedLabReviewerNotes = _viewedLabRun ? _viewedLabRun.reviewerNotes : labReviewerNotes;

  async function runDeepRead(paper: Paper, paperKey: string) {
    if (!ensureQuota("deep_read")) return;
    setDeepReadLoading((prev) => ({ ...prev, [paperKey]: true }));
    setDeepReadErrors((prev) => ({ ...prev, [paperKey]: "" }));
    try {
      const res = await fetchWithApiFallback("/api/papers/deep-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper: toBackendPaper(paper), user_query: selectedSearchQuery || query }),
      });
      // Backend enforcement backstop — if it returned 429 with the quota
      // header, the Usage modal has already been opened by the handler.
      if (handleQuotaResponse(res)) return;
      if (!res.ok) throw new Error(await readErrorMessage(res, `Deep read failed: ${res.status}`));
      const data = await res.json();
      setDeepReadResults((prev) => ({ ...prev, [paperKey]: data || {} }));
      void usage.refresh();
      useUsagePromptStore.getState().increment();
    } catch (error) {
      setDeepReadErrors((prev) => ({
        ...prev,
        [paperKey]: explainFetchError(error),
      }));
    } finally {
      setDeepReadLoading((prev) => ({ ...prev, [paperKey]: false }));
    }
  }

  // `completeFirstInteraction` / `setFirstInteractionDone` were retired
  // alongside the "click anywhere to begin" overlay — users land directly
  // on the workspace now. The `firstInteractionDone` constant stays so the
  // downstream rise animation doesn't need its own gate rewrite.

  return (
    <TermsOfServiceGate>
    <main
      data-theme={theme}
      data-tone={themeMode}
      className="workspace-main h-screen overflow-hidden flex flex-col bg-[var(--ats-bg-base)] text-slate-100"
      style={{
        // Per-panel alpha exposed as CSS vars — the panel rules in globals.css
        // read them via `rgb(from var(--ats-bg-panel) r g b / var(--ats-alpha-*))`.
        ["--ats-alpha-workspace" as any]: panelAlpha.workspace,
        ["--ats-alpha-synthesis" as any]: panelAlpha.synthesis,
        ["--ats-alpha-lab" as any]:       panelAlpha.lab,
        // Theme cross-fade duration — read in globals.css `*,::before,::after`
        // rule as `transition-duration: var(--ats-theme-transition-ms, 400ms)`.
        // User-tunable via Settings → Behaviour → Theme transition.
        ["--ats-theme-transition-ms" as any]: `${themeTransitionMs}ms`,
      }}
    >
      {/* "Click anywhere to begin" overlay was removed — users now land
          directly on an active workspace with the textarea focused and
          intro-stage reveal logic (see `introStage` state) driving which
          chrome appears when. No artificial click wall before first use. */}

      {/* ── Login-required gate ────────────────────────────────────────────
          Once auth is checked and the user is NOT signed in, a blocking
          overlay covers the whole app. Pointer events on the backdrop
          prevent any feature from being clicked while unauthenticated;
          the only interactive element is the "Continue with Google"
          button in the card. Disappears immediately when authUser
          becomes non-null (via onAuthStateChange). */}
      {!authLoading && !authUser && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-6 backdrop-blur-sm"
          style={{ backgroundColor: "rgba(0,0,0,0.35)" }}
        >
          <div
            className="w-full max-w-sm rounded-2xl border shadow-2xl p-6 text-center"
            style={{
              borderColor:     "var(--ats-border-subtle)",
              backgroundColor: "var(--ats-bg-panel)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/Cats_01.png" alt="AcademiCats" className="h-16 w-16 mx-auto mb-3 select-none pointer-events-none" draggable={false} />
            <h2 className="text-lg font-bold mb-1" style={{ color: "var(--ats-fg-primary)" }}>
              Sign in to continue
            </h2>
            <p className="text-xs mb-4 leading-relaxed" style={{ color: "var(--ats-fg-secondary)" }}>
              AcademiCats requires a free account to keep your search history,
              Lab outputs, and subscription in sync across devices.
            </p>
            <button
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold hover:brightness-105 transition-all"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-base)",
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

            {/* Developer-account sign-in — hidden by default so regular
                users aren't confused, revealed by a small "Developer
                sign-in" link. Uses the MAIN supabase client so the
                resulting session behaves like any other user login
                (feature gating, quota, history). */}
            <div className="mt-4 pt-4 border-t" style={{ borderColor: "var(--ats-border-subtle)" }}>
              {!devLoginOpen ? (
                <button
                  onClick={() => setDevLoginOpen(true)}
                  className="text-[11px] underline hover:opacity-80 transition-opacity"
                  style={{ color: "var(--ats-fg-muted)" }}
                >
                  Developer sign-in
                </button>
              ) : (
                <form
                  onSubmit={(e) => { e.preventDefault(); void handleDevLogin(); }}
                  className="space-y-2 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[10px] uppercase tracking-wider" style={{ color: "var(--ats-fg-muted)" }}>
                      Dev account
                    </label>
                    <button
                      type="button"
                      onClick={() => { setDevLoginOpen(false); setDevLoginErr(""); setDevLoginPassword(""); }}
                      className="text-[10px] underline"
                      style={{ color: "var(--ats-fg-muted)" }}
                    >Cancel</button>
                  </div>
                  <select
                    value={devLoginEmail}
                    onChange={(e) => setDevLoginEmail(e.target.value)}
                    disabled={devLoginBusy}
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--ats-border-accent)]"
                    style={{
                      borderColor:     "var(--ats-border-subtle)",
                      backgroundColor: "var(--ats-bg-base)",
                      color:           "var(--ats-fg-primary)",
                    }}
                  >
                    {DEV_ACCTS.map(acct => (
                      <option key={acct} value={acct}>{acct}</option>
                    ))}
                  </select>
                  <input
                    type="password"
                    value={devLoginPassword}
                    onChange={(e) => setDevLoginPassword(e.target.value)}
                    placeholder="Password"
                    autoComplete="current-password"
                    disabled={devLoginBusy}
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--ats-border-accent)]"
                    style={{
                      borderColor:     "var(--ats-border-subtle)",
                      backgroundColor: "var(--ats-bg-base)",
                      color:           "var(--ats-fg-primary)",
                    }}
                  />
                  {devLoginErr && (
                    <p
                      className="text-[11px] rounded-md px-2 py-1.5 border"
                      style={{
                        borderColor:     "#ef444455",
                        backgroundColor: "#ef44441a",
                        color:           "#ef4444",
                      }}
                    >{devLoginErr}</p>
                  )}
                  <button
                    type="submit"
                    disabled={devLoginBusy}
                    className="w-full rounded-lg px-4 py-2 text-sm font-bold shadow-sm hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-wait"
                    style={{
                      backgroundColor: "var(--ats-fg-accent)",
                      color:           "#ffffff",
                      border:          "1px solid var(--ats-fg-accent)",
                    }}
                  >
                    {devLoginBusy ? "Signing in…" : "Sign in as developer"}
                  </button>
                </form>
              )}
            </div>

            <p className="mt-3 text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
              We never sell your data. See{" "}
              <button onClick={() => setUserPanel("legal")} className="underline hover:opacity-80">Terms & Notices</button>.
            </p>
          </div>
        </div>
      )}

      {/* Day / Night category toggle — rendered as a sibling of the
          announcement banner so it sits in the top-right of that wrapper
          and feels like part of the banner chrome. See the top-bar
          block below where the theme toggle button lives inside the
          banner container's `relative` wrapper. */}

      <div className="flex flex-col flex-1 min-h-0 px-5 pt-5 pb-4 gap-4">
        {/* ── Top bar: title + mascot + announcement side-by-side ──
            The banner ALWAYS mounts (see below); when the user hides it
            via the megaphone we just hide the card with visibility /
            opacity so its exact height stays reserved, forever. That
            replaces the old min-h hack which was guessing at a number
            and pushing content by a pixel or two when the banner did or
            didn't render. Row uses items-start so the banner pins to
            the top instead of vertically centering against the mascot. */}
        <div className="flex-none flex items-start gap-4">
          {/* Title block — the mascot sits in the SAME row as the AcademiCats
              wordmark (right after "Cats"), NOT spanning down to the subtitle.
              That keeps the subtitle on its own line directly below the brand. */}
          <div className="shrink-0 flex flex-col justify-center py-1">
            <div className="flex items-center gap-3">
              <div className="text-5xl font-black tracking-tight leading-none">
                <span className="text-slate-100">Academi</span>
                <span className="text-blue-500">Cats</span>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/Cats_01.png"
                alt="AcademiCats mascot"
                // Height matches the wordmark's cap-to-baseline box (text-5xl
                // ≈ 3rem = 48px) so the mascot is top/bottom-aligned with
                // "AcademiCats" and doesn't push into the subtitle below.
                className="h-12 w-12 object-contain select-none pointer-events-none shrink-0"
                draggable={false}
              />
              {/* Megaphone toggle (banner show/hide) on top + Day/Night
                  toggle directly below it — stacked vertically in a single
                  flex column so both buttons share the same horizontal
                  slot. Stacking keeps them out of the wordmark + tagline
                  width, so the title row never gets pushed when extra
                  controls land here in the future. */}
              <div className="shrink-0 self-start mt-0.5 flex flex-col items-center gap-1">
                <button
                  onClick={() => setAnnouncementsVisible(v => !v)}
                  title={announcementsVisible ? "Hide announcements" : "Show announcements"}
                  aria-label={announcementsVisible ? "Hide announcements" : "Show announcements"}
                  aria-pressed={announcementsVisible}
                  {...helpProps(announcementsVisible ? "this hides the public ticker (◕‿◕)" : "click me to show the public announcement ticker")}
                  className={`flex items-center justify-center rounded-full border transition-all duration-200 hover:brightness-110 ${announcementsVisible ? "megaphone-breath" : ""}`}
                  style={{
                    height: "26px",
                    width: "26px",
                    borderColor:     announcementsVisible ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                    backgroundColor: announcementsVisible ? "var(--ats-bg-accent-soft)" : "var(--ats-bg-panel)",
                    color:           announcementsVisible ? "var(--ats-fg-accent)"     : "var(--ats-fg-muted)",
                  }}
                >
                  <Megaphone size={13} />
                </button>
                {/* Day / Night toggle — always visible, even when the
                    announcement banner is hidden. Sits directly below the
                    megaphone so the two share one column instead of
                    crowding the title row left/right. */}
                <button
                  onClick={() => setThemeMode(m => m === "night" ? "day" : "night")}
                  title={themeMode === "night" ? "Switch to Day theme" : "Switch to Night theme"}
                  aria-label={themeMode === "night" ? "Switch to day theme" : "Switch to night theme"}
                  {...helpProps(themeMode === "night" ? "click to swap to a Day palette ☀" : "click to swap to a Night palette 🌙")}
                  className="flex items-center justify-center rounded-full border transition-all duration-200 hover:brightness-110"
                  style={{
                    height: "26px",
                    width: "26px",
                    borderColor:     "var(--ats-border-subtle)",
                    backgroundColor: "var(--ats-bg-accent-soft)",
                    color:           "var(--ats-fg-accent)",
                  }}
                >
                  {themeMode === "night" ? <Sun size={13} /> : <Moon size={13} />}
                </button>
              </div>
            </div>
            {/* Tagline is sized so the whole line (descriptor + version)
                fits within the wordmark + mascot row width above — no
                overflow past the mascot's right edge. */}
            <p className="mt-1.5 text-[0.7rem] leading-snug text-slate-400 whitespace-nowrap">An academic assistant for structuring and verifying thought. <span className="text-[0.6rem] text-slate-600">{APP_VERSION}</span></p>
          </div>
          {/* Announcement banner — ALWAYS mounted so its height is
              always part of the top-bar flex row, preventing any pixel
              shift when the user toggles visibility. When off, we hide
              via opacity:0 + pointer-events:none (screen readers also
              ignore it via aria-hidden). That means the layout below
              is set in stone the moment the page renders. Fade timing
              is driven by CSS transition here instead of the
              stage-reveal keyframe because we're toggling opacity on an
              already-mounted element. */}
          {/* Right column = announcement banner with the layout-mode
              picker absolutely positioned in its top-right corner. The
              picker takes ZERO layout height (it floats over the
              banner's right edge), so it never pushes the rest of the
              UI down — even on short viewports. */}
          <div className="relative min-w-0 flex-1 pl-4">
            {/* Layout-mode picker — absolute top-right, lifted just
                enough above the banner top to leave a ~6px visible gap
                (not glued, not pushed away). z-30 stays above banner
                chrome. */}
            <div className="absolute -top-[10px] right-0 z-30 flex items-center gap-1">
            {([
              { mode: "default" as const, label: "Default", icon: <LayoutGrid size={13} />,        desc: "Balanced 3-pane layout" },
              { mode: "scholar" as const, label: "Scholar", icon: <BookOpen size={13} />,         desc: "Big left for charts + brief; right hidden" },
              { mode: "student" as const, label: "Student", icon: <FlaskConical size={13} />,     desc: "Right Lab panel takes more room" },
              { mode: "writing" as const, label: "Writing", icon: <PenLine size={13} />,          desc: "Left hidden; right wide for the Lab" },
            ]).map(({ mode, label, icon, desc }) => {
                const active = layoutMode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => applyLayoutMode(mode)}
                    title={`${label} mode — ${desc}`}
                    aria-label={`${label} layout`}
                    aria-pressed={active}
                    {...helpProps(`${label} layout — ${desc}`)}
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-md border transition-all hover:brightness-110"
                    style={{
                      borderColor:     active ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                      backgroundColor: active ? "var(--ats-bg-accent-soft)" : "var(--ats-bg-panel)",
                      color:           active ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
                    }}
                  >
                    {icon}
                  </button>
                );
              })}
            </div>
            {/* Announcement banner. Visibility is opacity-toggled so its
                height stays reserved even when hidden. The picker above
                this is absolute so it doesn't add to the row height. */}
            <div
              aria-hidden={!announcementsVisible}
              style={{
                opacity: announcementsVisible ? 1 : 0,
                transform: announcementsVisible ? "translateY(0)" : "translateY(-3px)",
                transition: "opacity 0.75s cubic-bezier(0.22, 0.8, 0.28, 1), transform 0.75s cubic-bezier(0.22, 0.8, 0.28, 1)",
                pointerEvents: announcementsVisible ? "auto" : "none",
              }}
            >
              <AnnouncementBanner
                collapsed={announcementCollapsed}
                onCollapse={() => setAnnouncementCollapsed(true)}
                onExpand={() => setAnnouncementCollapsed(false)}
                announcements={announcementsFeed.items}
                msgInput={msgInput}
                setMsgInput={setMsgInput}
                msgAnonymous={msgAnonymous}
                setMsgAnonymous={setMsgAnonymous}
                msgSending={msgSending}
                msgSentOk={msgSentOk}
                onSend={handleSendMessage}
                themeMode={themeMode}
                onToggleTheme={() => setThemeMode(m => m === "night" ? "day" : "night")}
              />
            </div>
          </div>
        </div>

        {(uiError || (job?.status === "error" && job?.error)) && (() => {
          // Two classes of message render through this banner:
          //   1. QUOTA NOTICES — not errors, just "you've hit the cap".
          //      Marked by a "__quota__" sentinel prefix set in
          //      ensureQuota / handleQuotaResponse. Rendered in amber
          //      with softer copy + a "View usage" CTA rather than a
          //      Retry button (retrying won't help until the counter
          //      resets).
          //   2. ACTUAL ERRORS — search failed, backend exploded, etc.
          //      Rendered in red with a Retry button as before.
          const raw = uiError || (job?.status === "error" && job?.error ? `Search failed: ${job.error}` : "");
          const isQuotaNotice = raw.startsWith("__quota__");
          const message = isQuotaNotice ? raw.slice("__quota__".length) : raw;

          if (isQuotaNotice) {
            return (
              <div
                className="stage-reveal mb-4 rounded-2xl border px-4 py-3 text-sm flex items-start gap-3 flex-wrap"
                style={{
                  borderColor:     "rgba(245, 158, 11, 0.35)",
                  backgroundColor: "rgba(245, 158, 11, 0.08)",
                  color:           "#fcd34d",
                }}
              >
                <span aria-hidden className="shrink-0 mt-0.5" style={{ color: "#fbbf24" }}>⏳</span>
                <span className="flex-1 min-w-0 leading-relaxed">{message}</span>
                <button
                  onClick={() => { setUiError(""); setUserPanel("usage"); }}
                  className="shrink-0 rounded-lg border px-3 py-1 text-xs font-semibold transition-colors"
                  style={{
                    borderColor:     "rgba(245, 158, 11, 0.45)",
                    color:           "#fbbf24",
                    backgroundColor: "transparent",
                  }}
                >View usage</button>
              </div>
            );
          }
          return (
            <div className="stage-reveal mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-3 flex-wrap">
              <span className="flex-1 min-w-0">{message}</span>
              <button
                onClick={() => { setUiError(""); void handleSearch(); }}
                className="shrink-0 rounded-lg border border-red-400/40 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/20 transition-colors"
              >↺ Retry</button>
            </div>
          );
        })()}

        <div
          ref={gridRef}
          className="relative grid flex-1 min-h-0"
          style={{
            // Grid tracks are computed in uniform px units so that when panels
            // toggle, every track (left col, dividers, centre, right col)
            // interpolates at the same rate — mixing fr + px previously made
            // the centre edge snap ahead of the side panels' slide-in.
            // During live divider drag, gridTransitioning is false so the
            // drag remains 1:1 with the pointer.
            gridTemplateColumns: (() => {
              const W = gridWidth || 0;
              if (W <= 0) {
                // First paint before the ResizeObserver has measured — fall
                // back to fr so SSR + initial render still looks right.
                const leftCol = gridLeftCollapsed ? "36px" : `${leftPct}fr`;
                const leftDiv = gridLeftCollapsed ? "0px" : "12px";
                const midFr = (gridLeftCollapsed ? leftPct : 0) + centerPct + (gridRightCollapsed ? rightPct : 0);
                const rightDiv = gridRightCollapsed ? "0px" : "12px";
                const rightCol = gridRightCollapsed ? "36px" : `${rightPct}fr`;
                return `${leftCol} ${leftDiv} ${midFr}fr ${rightDiv} ${rightCol}`;
              }
              // Collapsed tracks reserve enough width for the floating expand button.
              const leftPx  = gridLeftCollapsed  ? 36 : (leftPct  / 100) * W;
              const rightPx = gridRightCollapsed ? 36 : (rightPct / 100) * W;
              const leftDivPx  = gridLeftCollapsed  ? 0 : 12;
              const rightDivPx = gridRightCollapsed ? 0 : 12;
              const midPx = Math.max(0, W - leftPx - rightPx - leftDivPx - rightDivPx);
              return `${leftPx}px ${leftDivPx}px ${midPx}px ${rightDivPx}px ${rightPx}px`;
            })(),
            columnGap: 0,
            rowGap: 0,
            transition: gridTransitioning ? "grid-template-columns 0.9s cubic-bezier(0.25,0.8,0.25,1)" : "none",
          }}
        >
          {/* Left panel — Research Brief | Analytics (collapsible).
              Wrapped in ErrorBoundary so a crash in the Brief / agent
              trace rendering doesn't take down the entire app — the
              user still has the center Workspace + right Lab working. */}
          <ErrorBoundary label="Research Brief panel">
          {/* Left panel */}
          <div className="relative min-w-0 h-full overflow-hidden rounded-xl">
            {/* Expand button — sits at tab-bar height on the left edge, square (not circular)
                so it reads as a panel toggle rather than a "next" arrow. */}
            <button
              onClick={() => setLeftVisible(true)}
              title="Show panel"
              aria-label="Show left panel"
              style={{
                opacity: leftVisible ? 0 : 1,
                pointerEvents: leftVisible ? "none" : "auto",
                transition: "opacity 0.25s 0.55s ease",
              }}
              className="absolute top-[11px] left-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border border-[var(--ats-border-subtle)] bg-[var(--ats-bg-panel)] text-slate-400 hover:text-blue-400 hover:border-blue-500/60 transition-colors"
            ><PanelLeftOpen size={15} /></button>

            <section
              data-region="synthesis"
              className="absolute inset-0 flex flex-col rounded-xl bg-[var(--ats-bg-section)] ats-panel overflow-hidden"
              style={{
                transform: leftVisible ? "translateX(0)" : "translateX(-105%)",
                transition: "transform 0.9s cubic-bezier(0.25,0.8,0.25,1)",
              }}
            >
              {/* Collapse button — aligned with tab bar, square. */}
              <button
                onClick={() => setLeftVisible(false)}
                title="Hide panel"
                aria-label="Hide left panel"
                className="absolute top-[11px] left-2 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-[var(--ats-border-subtle)] bg-[var(--ats-bg-panel)] text-slate-400 hover:text-blue-400 hover:border-blue-500/60 transition-colors"
              ><PanelLeftClose size={15} /></button>
              {/* Tab bar — leading padding reserves space for the absolute collapse button. */}
              <div className="shrink-0 flex items-center gap-1.5 pl-12 pr-3 py-2.5 border-b border-slate-800/60">
                <button
                  onClick={() => setLeftTab("brief")}
                  {...helpProps("Research Brief — synthesised summary of what the retrieved papers are saying")}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                    leftTab === "brief"
                      ? "bg-slate-900/70 text-slate-100"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                ><ClipboardList size={14} /><span>Research Brief</span></button>
                <button
                  onClick={() => setLeftTab("analytics")}
                  {...helpProps("Charts — year / venue / citation distribution of the retrieved papers")}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                    leftTab === "analytics"
                      ? "bg-slate-900/70 text-slate-100"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                ><BarChart2 size={14} /><span>Charts</span></button>
                {/* Collapse action moved to the fold-side edge — see absolute button above. */}
              </div>

              {/* ── Research Brief content ── */}
              <div ref={leftSectionRef as React.RefObject<HTMLDivElement>} className={`flex-1 min-h-0 overflow-y-auto thin-scrollbar p-5 ${leftTab === "brief" ? "" : "hidden"}`}>
                {/* Research Brief section header — hidden while the panel is in
                    its idle empty state so the centred copy below can use the
                    full panel height (matches the Synthesis Lab empty state).
                    The Translate button sits INSIDE this title row (right of
                    the title text) so it reads as a header control, not a
                    footer action. It only appears once streaming has finished
                    AND a brief is present — translating a half-written brief
                    would give half-translated output. */}
                {(researchBriefMarkdown || isSubmitting) && (
                  <div className="mb-3 flex items-center gap-2 text-base font-bold flex-wrap">
                    <FileText size={16} />
                    <span>Research Brief</span>
                    {!isStreamingBrief && !!result?.brief && (
                      <div className="ml-2 inline-flex items-stretch rounded-lg border overflow-hidden"
                        style={{ borderColor: "var(--ats-border-accent)" }}
                      >
                        {/* Language picker — changes the target locale.
                            Changing it while a cached translation exists
                            in a DIFFERENT language automatically flips the
                            button back to "Translate" (see comparison
                            below) so the user knows they need to refetch. */}
                        <select
                          value={briefTargetLang}
                          onChange={(e) => setBriefTargetLang(e.target.value)}
                          disabled={briefTranslating}
                          title="Target language"
                          className="bg-[var(--ats-bg-accent-soft)] text-xs font-semibold px-2 py-1 outline-none border-r disabled:opacity-60"
                          style={{
                            borderColor: "var(--ats-border-accent)",
                            color:       "var(--ats-fg-accent)",
                          }}
                        >
                          {BRIEF_LANG_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value} className="bg-slate-900 text-slate-100">
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => {
                            // Four paths:
                            //  a) IN FLIGHT → clicking again cancels the
                            //     translation (AbortController). Label
                            //     flips to "Stop" while translating so
                            //     the affordance is clear.
                            //  b) Currently viewing translation in the
                            //     selected language → flip back to original.
                            //  c) Have a cached translation in the selected
                            //     language but viewing original → flip to it.
                            //  d) Otherwise → fire a fresh request.
                            if (briefTranslating) {
                              briefTransAbortRef.current?.abort();
                              return;
                            }
                            const cachedMatches =
                              !!briefTranslated && briefTranslatedLang === briefTargetLang;
                            if (briefShowTrans && cachedMatches) {
                              setBriefShowTrans(false);
                              return;
                            }
                            if (cachedMatches) {
                              setBriefShowTrans(true);
                              return;
                            }
                            void requestBriefTranslation();
                          }}
                          title={
                            briefTranslating ? "Stop translation" :
                            briefShowTrans  ? "Show original brief" :
                                              "Translate this brief"
                          }
                          // No `disabled` while translating — we want the
                          // click to cancel. cursor-default + animated
                          // feedback make it clear work is happening.
                          className="relative inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold transition-all hover:brightness-110 overflow-hidden"
                          style={{
                            backgroundColor: "var(--ats-bg-accent-soft)",
                            color:           "var(--ats-fg-accent)",
                          }}
                        >
                          {briefTranslating ? (
                            <Square size={10} fill="currentColor" />
                          ) : (
                            <Globe size={12} />
                          )}
                          <span>
                            {briefTranslating
                              ? "Stop"
                              : (briefShowTrans && briefTranslatedLang === briefTargetLang)
                                ? "Show Original"
                                : (briefTranslated && briefTranslatedLang === briefTargetLang)
                                  ? "Show Translation"
                                  : "Translate"}
                          </span>
                          <ProgressStrip active={briefTranslating} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {researchBriefMarkdown && (briefStatus === "draft" || briefStatus === "final") && (
                  <div className="mb-3">
                    {briefStatus === "draft" && isSubmitting && (
                      <span className="text-xs font-normal text-amber-400/80">· draft · refining with agent analysis…</span>
                    )}
                    {briefStatus === "final" && isSubmitting && (
                      <span className="text-xs font-normal text-emerald-400/80">· final · refined with deep analysis</span>
                    )}
                  </div>
                )}

                {/* Brief — writing indicator before first token arrives */}
                {isSubmitting && !researchBriefMarkdown && (
                  <div className="mb-4 flex items-center gap-2 rounded-2xl border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm font-medium text-blue-300 animate-pulse shadow-[0_0_16px_rgba(59,130,246,0.25)]">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-400" />
                    Writing research brief…
                  </div>
                )}

                {researchBriefMarkdown ? (
                  <>
                    {/* Research Brief is now Google-Translate-eligible. The
                        old guard (`translate="no"` + `notranslate` class)
                        existed because we worried the extension's DOM
                        rewrite would collide with our streamed-markdown
                        diff. After real-world testing that never
                        materialised, so we let Google Translate handle
                        this container — users reading in a non-English
                        locale get an auto-translated brief for free,
                        and our in-app Translate button below still
                        handles the higher-quality LLM translation.
                        Body text at 0.78rem — one step below the
                        previous 0.85rem — with tighter line-height /
                        margins so the brief reads more densely without
                        the headings (prose-h2 / h3 controlled by
                        mdComponents) changing. */}
                    <div className="fade-in prose prose-invert max-w-none break-words
                      prose-p:text-[0.78rem] prose-p:leading-[1.45] prose-p:my-0.5 prose-p:text-slate-300
                      prose-strong:text-slate-100 prose-strong:font-semibold
                      prose-li:text-[0.78rem] prose-li:leading-[1.4] prose-li:text-slate-300 prose-li:my-0
                      prose-ul:my-1 prose-ol:my-1 prose-ul:pl-4 prose-ol:pl-4">
                      <ReactMarkdown components={mdComponents}>
                        {briefShowTrans ? (briefTranslated || " ") : researchBriefMarkdown}
                      </ReactMarkdown>
                      {((isStreamingBrief && !briefShowTrans) || (briefShowTrans && briefTranslating)) && (
                        <span className="inline-block h-[1.1em] w-[2px] animate-pulse rounded-sm bg-blue-400 align-text-bottom ml-0.5" />
                      )}
                      {briefShowTrans && briefTransError && (
                        <p className="mt-2 text-xs text-red-400">Translation failed: {briefTransError}</p>
                      )}
                    </div>
                    {!isStreamingBrief && result?.brief && (
                      <div className="mt-6 flex flex-nowrap items-center gap-2 overflow-hidden">
                        {/* Copy / Download act on whatever the user is
                            currently looking at — translated text when
                            the translation is on screen, original brief
                            otherwise. Matches the user's ask: "下载的是
                            当前显示的内容". The filename slug is
                            suffixed with the language tag when exporting
                            a translation so the file name announces
                            itself. */}
                        {(() => {
                          const showingTrans = briefShowTrans && briefTranslated
                            && briefTranslatedLang === briefTargetLang;
                          const downloadText = showingTrans ? briefTranslated : (result?.brief || "");
                          const langSlug = showingTrans
                            ? "_" + briefTranslatedLang.replace(/[^\w]+/g, "_").replace(/_+$/, "")
                            : "";
                          const slug = (result?.original_query || query || "brief")
                            .replace(/\s+/g, "_").replace(/[^\w_]/g, "").slice(0, 40);
                          const filename = `research_brief_${slug}${langSlug}`;
                          return (
                            <>
                              <button
                                onClick={() => void navigator.clipboard.writeText(downloadText)}
                                className="shrink min-w-0 inline-flex items-center gap-1 rounded-xl border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-400 hover:text-blue-300 hover:border-blue-500/50 transition-colors"
                                title={showingTrans ? "Copy the displayed translation" : "Copy the original brief"}
                              ><ClipboardList size={13} className="shrink-0" /><span className="truncate">
                                Copy {showingTrans ? "Translation" : "Brief"}
                              </span></button>
                              <div className="flex flex-nowrap items-center gap-1.5 min-w-0">
                                <select
                                  value={briefDownloadFmt}
                                  onChange={e => setBriefDownloadFmt(e.target.value as "pdf"|"html"|"txt"|"md")}
                                  className="shrink-0 rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm text-slate-400 focus:outline-none focus:border-blue-500/60"
                                >
                                  <option value="pdf">PDF</option>
                                  <option value="html">HTML</option>
                                  <option value="md">Markdown</option>
                                  <option value="txt">TXT</option>
                                </select>
                                <button
                                  onClick={() => {
                                    if (briefDownloadFmt === "pdf") {
                                      void triggerDownload(buildApiUrl("/api/brief/download"), {
                                        brief_text:         downloadText,
                                        original_query:     result?.original_query || query,
                                        final_search_query: result?.final_search_query || query,
                                        // Language hint → backend picks a CJK-capable
                                        // CID font. Empty string when downloading the
                                        // original (English) brief → Helvetica.
                                        language:           showingTrans ? briefTranslatedLang : "",
                                      }, `${filename}.pdf`, "brief-download");
                                    } else {
                                      downloadTextAs(downloadText, filename, briefDownloadFmt as "html"|"txt"|"md");
                                    }
                                  }}
                                  className="shrink min-w-0 inline-flex items-center gap-1 rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 transition-colors"
                                  title={showingTrans
                                    ? `Download the ${briefTranslatedLang} translation`
                                    : "Download the original brief"}
                                ><Download size={14} className="shrink-0" /><span className="truncate">
                                  Download {showingTrans ? "Translation" : "Brief"}
                                </span></button>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </>
                ) : !isSubmitting ? (
                  // Mirrors the right-panel Synthesis Lab empty-state spec so both
                  // idle panels centre their copy identically inside their region.
                  <div className="flex min-h-[20rem] h-full items-center justify-center px-6 text-center">
                    <div className="max-w-[22rem] text-xs leading-relaxed text-slate-500">
                      Run a search first —<br />
                      your Research Brief will show up here when the analysis finishes.
                    </div>
                  </div>
                ) : null}

                {/* Analytical Trace — appears INLINE below the brief, only
                    after at least one agent has produced output. No shared
                    disclosure wrapper, no fallback copy; if there's nothing
                    to show, nothing renders. */}
                {hasAgentOutput && (
                  <div className="mt-6 ats-card rounded-3xl bg-slate-950/40 p-4">
                    <div className="mb-2 flex items-center gap-2 text-base font-bold"><Brain size={16} /><span>How the Answer Was Built</span></div>
                    <p className="mb-4 text-sm text-slate-400">A step-by-step look at what each analysis agent found.</p>
                    <div className="space-y-3">
                      <AgentSection title="Evidence Mapper" payload={agentData.evidence_mapper} running={isSubmitting && !fastMode && startedAgents.has("evidence_mapper")} />
                      <AgentSection title="Scholar"         payload={agentData.scholar}        running={isSubmitting && !fastMode && startedAgents.has("scholar")} />
                      <AgentSection title="Gap Analyst"     payload={agentData.gap_analyst}    running={isSubmitting && !fastMode && startedAgents.has("gap_analyst")} />
                      <AgentSection title="Verifier"        payload={agentData.verifier}       running={isSubmitting && !fastMode && startedAgents.has("verifier")} />
                    </div>
                  </div>
                )}

                {/* Retrieval Strategy Summary — independent of Analytical
                    Trace, renders INLINE after the brief when strategy data
                    is present. Dashed accent border makes it visually
                    distinct from the neutral trace card above. */}
                {hasStrategy && (
                  <div
                    className="mt-4 rounded-3xl border-2 border-dashed border-[var(--ats-border-accent)] bg-[var(--ats-bg-accent-soft)] p-4"
                    style={{ boxShadow: "inset 0 0 0 1px var(--ats-border-subtle)" }}
                  >
                    <div className="mb-2 flex items-center gap-2 text-base font-bold text-[var(--ats-fg-accent)]">
                      <Compass size={16} />
                      <span>How We Found These Papers</span>
                      <span className="ml-auto text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--ats-fg-muted)]">behind the scenes</span>
                    </div>
                    <p className="mb-4 text-sm text-[var(--ats-fg-secondary)]">How the search was run, filtered, and ranked.</p>
                    <div className="space-y-2 text-xs text-[var(--ats-fg-secondary)]">
                      {Array.isArray(result?.strategy_summary?.strategy_points) &&
                        result.strategy_summary.strategy_points.map((item: any, idx: number) => (
                          <div key={idx} className="break-words">• {String(item)}</div>
                        ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Analytics content ── */}
              <div className={`flex-1 min-h-0 overflow-y-auto thin-scrollbar ${leftTab === "analytics" ? "" : "hidden"}`}>
                {displayedPapers.length === 0 ? (
                  // Mirrors the Lab empty-state spec so left/right panels read the same when idle.
                  <div className="flex min-h-[20rem] h-full items-center justify-center px-6 text-center">
                    <div className="max-w-[22rem] text-xs leading-relaxed text-slate-500">
                      Run a search first —<br />
                      charts will fill in once papers are found.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="px-4 pt-3 pb-1">
                      <div className="text-xs text-slate-500">
                        {displayedPapers.length} paper{displayedPapers.length !== 1 ? "s" : ""} · {fastMode ? "Fast" : "Deep"} mode
                      </div>
                    </div>
                    <div className="px-4 pb-4">
                      <PaperCharts papers={displayedPapers} wide={false} />
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>
          </ErrorBoundary>

          <DividerScrollbar onResizeStart={() => startDrag("left")} onSnap={snapDividerToDefault} sectionRef={leftSectionRef} />

          {/* Center Workspace — the textarea + Retrieved Papers stream +
              agent trace live here. Isolated in its own boundary so a
              render bug in a single paper card doesn't nuke the whole
              query + results view. */}
          <ErrorBoundary label="Workspace">
          <section data-region="workspace" className="min-w-0 h-full rounded-xl bg-[var(--ats-bg-section)] ats-panel flex flex-col overflow-hidden transition-[width] duration-200">
            <div ref={centerSectionRef as React.RefObject<HTMLDivElement>} className="flex-1 min-h-0 overflow-y-auto thin-scrollbar p-5">
            <div className="mb-4 flex items-center gap-2 text-xl font-bold">
              <LayoutGrid size={18} /><span>Workspace</span>
              {/* Start over — clears query, sprite results, layout, and
                  any in-flight search to drop the user back at the
                  pristine landing. Hidden on the initial landing so it
                  doesn't clutter the empty workspace; only surfaces once
                  the user has actually run a search and might want a way
                  back to the start. Fades in when it appears. */}
              {(hasRunSearch || isSubmitting) && (
                <button
                  onClick={handleStartOver}
                  title="Start over — clear query, directions, and any in-flight search"
                  {...helpProps("clears your query, directions, and any in-flight search — full reset to the landing")}
                  className="stage-reveal ml-auto inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-all hover:brightness-110"
                  style={{
                    borderColor:     "var(--ats-border-subtle)",
                    backgroundColor: "var(--ats-bg-panel)",
                    color:           "var(--ats-fg-muted)",
                  }}
                >
                  <RotateCcw size={12} />
                  <span>Start over</span>
                </button>
              )}
            </div>

            {/* Unified workspace card — textarea + action row live inside one bordered container */}
            <div className="rounded-xl border border-slate-700/60 bg-[var(--ats-bg-input)] shadow-[0_2px_8px_rgba(15,23,42,0.08)] overflow-hidden">
              <div ref={placeholderWrapperRef} className="relative" style={{ containerType: "inline-size" }}>
                <textarea
                  ref={taRef}
                  value={query}
                  maxLength={workspaceCharLimit}
                  // onChange is the ONLY setter. During IME composition the
                  // browser still fires onChange with each intermediate value —
                  // if we skipped those, the textarea visual + controlled value
                  // would drift apart. We accept the intermediate values; the
                  // composingRef guards nothing here but is exposed to other
                  // effects (e.g. the imperative height write) so they can
                  // avoid touching the DOM mid-composition.
                  onChange={(e) => setQuery(e.target.value)}
                  onCompositionStart={() => { _composingRef.current = true; }}
                  onCompositionEnd={(e) => {
                    _composingRef.current = false;
                    // The compositionend event carries the final committed text.
                    // Commit it again to guarantee the controlled value matches
                    // what the user sees — a safety net against the rare browser
                    // that withholds the trailing onChange.
                    setQuery((e.target as HTMLTextAreaElement).value);
                  }}
                  // Enter behaviour on the landing (`blank`) stage:
                  //   1. Sub-bubbles visible (a direction is picked + that
                  //      direction has sub_options + no sub selected yet)
                  //      → pick the recommended sub.
                  //   2. Direction bubbles visible, none picked yet →
                  //      pick the recommended big-direction.
                  //   3. Still streaming directions → no-op (wait).
                  //   4. Otherwise (first Enter) → AUTO-FIRE Find Angles.
                  //      The user no longer has to click an intermediate
                  //      "Find angles for me" bubble — typing + Enter is
                  //      enough; the directions stream in directly.
                  // Shift+Enter still inserts a newline; IME composition
                  // Enter is ignored so CJK candidate confirmations don't
                  // submit.
                  onKeyDown={(e) => {
                    // Esc — back out of the 3-step Enter ritual without
                    // losing the typed query. Step 2 → 1 (drop the focus
                    // ring), step 1 → 0 (hide the buttons). At step 0
                    // there's nothing to back out of, so Esc is a no-op.
                    if (e.key === "Escape" && buttonStep > 0 && !isSubmitting) {
                      e.preventDefault();
                      setButtonStep((s) => (s > 0 ? ((s - 1) as 0 | 1 | 2) : 0));
                      return;
                    }
                    // Bubble navigation (Arrow keys) — when the sprite has
                    // any actionable bubble on screen (Quick / Curated +
                    // recommended-term chips), arrow keys cycle the
                    // focused bubble instead of moving the textarea
                    // cursor. Suppressed during IME composition so CJK
                    // candidate selection still works.
                    if ((e.key === "ArrowLeft" || e.key === "ArrowRight" ||
                         e.key === "ArrowUp"   || e.key === "ArrowDown") &&
                        !e.nativeEvent.isComposing && !_composingRef.current &&
                        spriteRef.current?.hasBubbles()) {
                      e.preventDefault();
                      const delta = (e.key === "ArrowLeft" || e.key === "ArrowUp") ? -1 : 1;
                      spriteRef.current.moveFocus(delta);
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !_composingRef.current) {
                      e.preventDefault();
                      const trimmed = query.trim();
                      if (isSubmitting || !trimmed) return;
                      // Three-step Quick / Curated reveal flow:
                      //   1st Enter → buttonStep 0 → 1 (buttons appear, no ring)
                      //   2nd Enter → buttonStep 1 → 2 (focus ring on default mode)
                      //   3rd Enter → commit the focused mode (fire search)
                      // EXCEPT when the user has explicitly arrowed onto a
                      // recommended-term chip — in that case Enter commits
                      // the chip (fills the input) regardless of buttonStep,
                      // since the chip IS the focus target.
                      const focusedKind = spriteRef.current?.getFocusedKind?.() ?? null;
                      if (focusedKind === "term") {
                        spriteRef.current?.commitFocused();
                        return;
                      }
                      if (buttonStep === 0) { setButtonStep(1); return; }
                      if (buttonStep === 1) { setButtonStep(2); return; }
                      // buttonStep === 2 — commit whatever mode currently
                      // owns the focus ring (Quick by default, or Curated
                      // if the user arrowed across).
                      spriteRef.current?.commitFocused();
                    }
                  }}
                  onFocus={() => setTaFocused(true)}
                  onBlur={(e) => {
                    setTaFocused(false);
                    // If the user left the box empty, shuffle to a fresh random phrase
                    // so the overlay that re-appears is different from the one they just dismissed.
                    if (e.target.value.length === 0 && WORKSPACE_PLACEHOLDERS.length > 1) {
                      setPlaceholderIdx(i => {
                        let next = i;
                        while (next === i) next = Math.floor(Math.random() * WORKSPACE_PLACEHOLDERS.length);
                        try { window.sessionStorage.setItem("ats:workspace_placeholder_idx", String(next)); } catch {}
                        return next;
                      });
                    }
                  }}
                  // bg-transparent so the decorative placeholder overlay sitting at z-0
                  // is actually visible behind the textarea surface — the wrapper div
                  // carries `bg-[var(--ats-bg-input)]` for the filled look.
                  // resize-none: no user drag handle; long content scrolls via the
                  // hair-thin scrollbar (thinner than the panel's own scrollbar).
                  // `leading-[1.2]` matches the placeholder overlay's line-height
                  // exactly, so typed text sits on the same baseline rhythm as
                  // the slogan. fontSize + fontWeight are written imperatively
                  // in the useLayoutEffect above — pre-search we push toward the
                  // same clamp(1.25rem, 11cqw, 4.25rem) + bold the overlay uses;
                  // post-search we shrink back to a normal editing body size.
                  // `caret-color` only — `caret-shape: block` turned out to
                  // render an overly-chunky block in Chrome 134+. We want
                  // the caret to MATCH the slogan's 3-px fake cursor in
                  // feel, not dwarf it, so we accept the browser's native
                  // thin bar and just colour it with the primary text
                  // token so it stays crisply visible on every theme.
                  className="relative z-10 block w-full resize-none bg-transparent px-5 text-center leading-[1.2] text-slate-100 outline-none hairline-scrollbar transition-all duration-300 ease-out"
                  style={{
                    caretColor: "var(--ats-fg-primary)",
                  } as React.CSSProperties}
                />
                {/* Rotating greeting — shown only when textarea is empty AND not focused.
                    On click, focus fires → overlay hides → native caret takes over.
                    The fake cursor sits at the END of the second line so it reads
                    as "ready to append" rather than "type from the start".
                    `animate-pulse` gives both the text and the bar the same breathing rhythm. */}
                {/* Char-limit counter — only surfaces when the user is
                    within 10 % of the cap, so it never pesters short
                    queries. Goes amber at 90 % and red at the cap. The
                    textarea already enforces the cap via `maxLength`,
                    so this is just user-visible feedback. */}
                {(() => {
                  const lim = workspaceCharLimit;
                  if (!lim || query.length < Math.floor(lim * 0.9)) return null;
                  const atCap = query.length >= lim;
                  return (
                    <div
                      aria-live="polite"
                      className="pointer-events-none absolute bottom-1.5 right-3 z-20 select-none rounded-md px-1.5 py-0.5 text-[10px] font-mono tabular-nums"
                      style={{
                        color:           atCap ? "#dc2626" : "#d97706",
                        backgroundColor: "rgba(15, 23, 42, 0.55)",
                      }}
                    >
                      {query.length}/{lim}
                    </div>
                  );
                })()}
                {query.length === 0 && !taFocused && (
                  <div
                    className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center px-6 text-center font-bold leading-[1.2] text-[var(--ats-placeholder-fg)] select-none animate-pulse"
                    // Font scales with the container width (`cqw` = 1% of the wrapper's
                    // inline size). Upper bound goes beyond the product logo (text-5xl ≈ 3rem)
                    // so the greeting fills the expanded textarea at wide widths.
                    style={{ fontSize: "clamp(1.25rem, 9cqw, 3rem)" }}
                  >
                    {/* Render the phrase as a single string so the browser wraps naturally.
                        Greedy wrap is top-heavy by default — line 1 fills first, line 2
                        gets the remainder — matching the spec "more on top, less below". */}
                    <span className="max-w-full">
                      {WORKSPACE_PLACEHOLDERS[placeholderIdx]}
                      {/* Slogan fake cursor — slightly chunkier (3px) so it
                          reads as the same visual weight as the native
                          caret in the textarea now that `caret-shape:block`
                          is in play for Chromium. Roughly matches the "|"
                          thickness in the user's bold 11cqw text. */}
                      <span aria-hidden className="inline-block w-[3px] h-[0.9em] ml-1 bg-current align-[-2px] rounded-[1px]" />
                    </span>
                  </div>
                )}
              </div>

              {/* ── Staged action bar ──────────────────────────────────────
                  Visible after the user has chosen a direction from the
                  blank landing. Which controls appear depends on
                  introStage:
                    explore → Search Settings + Explore Angles only
                    full    → Search Settings + Explore Angles + Quick /
                              Curated toggle + Start button
                  Everything uses the same layout / classes so the row
                  visually grows as the stage unlocks.

                  The wrapper is rendered AT ALL TIMES once the user has
                  engaged (typed something or advanced past blank) so the
                  action bar's vertical space is reserved up-front and
                  doesn't suddenly pop in after the angle stream finishes
                  — that pop-in was pushing the sprite + bubbles below
                  the textarea down by a row-height every search. On the
                  truly empty landing we use `visibility: hidden` instead
                  of unmounting so the textarea card height stays
                  identical between empty and engaged states. */}
              {(() => {
                const showActionBar = introStage !== "blank" || query.trim().length > 0;
                return (
              <div
                className="flex flex-nowrap items-center gap-2 border-t border-slate-700/40 px-3 py-2 overflow-hidden"
                style={{
                  // Always reserve space (visibility hidden when not engaged
                  // yet) so the bar doesn't pop in and shove content. When
                  // showActionBar flips on we fade opacity 0 → 1 to give
                  // the row a soft fade-in instead of a hard appear.
                  visibility: showActionBar ? "visible" : "hidden",
                  opacity:    showActionBar ? 1 : 0,
                  transition: "opacity 360ms ease-out",
                }}
              >
                <button
                  onClick={() => setSettingsOpen(o => !o)}
                  {...helpProps("open per-search settings — paper count, sort mode, year range, source filters…")}
                  className="shrink min-w-0 flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:border-blue-500/40 transition-colors"
                >
                  <SlidersHorizontal size={14} className="shrink-0" />
                  <span className="truncate">Search Settings</span>
                  <ChevronDown size={12} className={`shrink-0 ${settingsOpen ? "rotate-180 transition-transform duration-200" : "transition-transform duration-200"}`} />
                </button>

                {/* AI sprite lives BELOW the textarea card now (see the
                    "Sprite commentary" block after the workspace card).
                    That single location works in every stage, so we keep
                    the action bar free of duplicate commentary. */}

                <div className="ml-auto flex flex-nowrap items-center gap-2 min-w-0">
                  {/* Cancel-angles button removed — when the user kicks
                      off a search via the sprite Quick / Curated bubble,
                      handleSearch auto-cancels any in-flight Find Angles
                      stream (see the cancelUnderstand call there). The
                      explicit cancel was never the right escape because
                      the user almost always wanted to commit, not back
                      out. */}

                  {/* Quick / Curated toggle + Start search button were
                      removed — those are now sprite chat bubbles (see
                      handleStartSearchFromSprite + Sprite.tsx
                      showSearchModeBubbles). The action bar keeps only
                      Search Settings + Cancel/Stop affordances. */}
                  {introStage === "full" && isSubmitting && (
                    <button
                      onClick={handleStop}
                      title="Stop search"
                      aria-label="Stop search"
                      {...helpProps("stop the search and restore the layout — your query + directions stay")}
                      className="stage-reveal flex h-8 w-8 items-center justify-center rounded-full border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                    >
                      <Square size={13} fill="currentColor" />
                    </button>
                  )}

                  {/* Re-run mode toggle — appears once a search has run
                      so the user can swap modes and re-fire without
                      hitting Start over. The currently-active mode gets
                      the accent border; clicking the OTHER mode flips
                      fastMode and re-invokes handleSearch. Hidden while
                      a search is mid-flight (the Stop button is the
                      affordance there). */}
                  {introStage === "full" && hasRunSearch && !isSubmitting && (
                    <div className="stage-reveal inline-flex items-center rounded-xl border p-0.5 text-xs font-semibold"
                         style={{ borderColor: "var(--ats-border-subtle)", backgroundColor: "var(--ats-bg-panel)" }}>
                      <button
                        onClick={() => { setFastMode(true); setTimeout(() => { void handleSearch(); }, 50); }}
                        {...helpProps("re-run as Quick Search — fast smart-ranked retrieval")}
                        title="Re-run as Quick Search"
                        className="flex items-center gap-1 rounded-lg px-2.5 py-1 transition-colors"
                        style={{
                          backgroundColor: fastMode ? "var(--ats-bg-accent-soft)" : "transparent",
                          color:           fastMode ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
                        }}
                      >
                        <Zap size={12} className="shrink-0" /><span>Quick</span>
                      </button>
                      <button
                        onClick={() => { setFastMode(false); setTimeout(() => { void handleSearch(); }, 50); }}
                        {...helpProps("re-run as Curated Analysis — multi-agent deep dive")}
                        title="Re-run as Curated Analysis"
                        className="flex items-center gap-1 rounded-lg px-2.5 py-1 transition-colors"
                        style={{
                          backgroundColor: !fastMode ? "var(--ats-bg-accent-soft)" : "transparent",
                          color:           !fastMode ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
                        }}
                      >
                        <FlaskConical size={12} className="shrink-0" /><span>Curated</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
                );
              })()}
            </div>

            {/* Settings panel — controlled. Positioned IMMEDIATELY below
                the workspace card (above the sprite) so clicking the
                Search Settings button inside the action bar reveals the
                panel right under the user's eye, never below the fold.
                `stage-reveal` smooths the open transition. */}
            {settingsOpen && (
            <div
              className="stage-reveal mt-4 rounded-2xl bg-slate-950/40 px-4 py-3"
            >
              <div className="flex cursor-pointer select-none items-center gap-1.5 text-sm font-semibold text-slate-200 mb-2" onClick={() => setSettingsOpen(false)}><SlidersHorizontal size={14} /><span>Settings & Controls</span><ChevronDown size={12} className="ml-auto rotate-180" /></div>
              <div className="mt-2 space-y-2.5">
                {/* Row 1: count + sort */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">Paper count</label>
                    <input type="number" min={3} max={500} value={paperCount} onChange={(e) => setPaperCount(Number(e.target.value))} className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">Sort mode</label>
                    <select value={sortMode} onChange={(e) => setSortMode(e.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-blue-500">
                      {SORT_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                    </select>
                  </div>
                </div>
                {/* Row 2: checkboxes */}
                <div className="flex flex-wrap gap-2">
                  <label className="flex items-center gap-1.5 rounded-lg border border-slate-800 px-2 py-1 text-xs text-slate-300"><input type="checkbox" checked={preferAbstracts} onChange={(e) => setPreferAbstracts(e.target.checked)} />Prefer abstracts</label>
                  <label className="flex items-center gap-1.5 rounded-lg border border-slate-800 px-2 py-1 text-xs text-slate-300"><input type="checkbox" checked={strictCoreOnly} onChange={(e) => setStrictCoreOnly(e.target.checked)} />Strict core only</label>
                  <label className="flex items-center gap-1.5 rounded-lg border border-slate-800 px-2 py-1 text-xs text-slate-300"><input type="checkbox" checked={openAccessOnly} onChange={(e) => setOpenAccessOnly(e.target.checked)} />Open access only</label>
                </div>
                {/* Row 3: year range */}
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400"><input type="checkbox" checked={useYearRange} onChange={(e) => setUseYearRange(e.target.checked)} />Year range</label>
                  {useYearRange && (
                    <>
                      <input type="number" value={yearStart} onChange={(e) => setYearStart(Number(e.target.value))} className="w-20 rounded-lg border border-slate-700 bg-slate-900/50 px-2 py-1 text-xs text-slate-100 outline-none focus:border-blue-500" />
                      <span className="text-xs text-slate-600">–</span>
                      <input type="number" value={yearEnd} onChange={(e) => setYearEnd(Number(e.target.value))} className="w-20 rounded-lg border border-slate-700 bg-slate-900/50 px-2 py-1 text-xs text-slate-100 outline-none focus:border-blue-500" />
                    </>
                  )}
                </div>
                {/* Row 4: sources */}
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-400">Sources</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {DEFAULT_SOURCES.map((source) => {
                      const checked = sourceFilters.includes(source);
                      return <label key={source} className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition ${checked ? "border-blue-500/50 bg-blue-500/10 text-white" : "border-slate-800 text-slate-300"}`}><input type="checkbox" checked={checked} onChange={() => toggleSource(source)} /><span className="min-w-0 truncate">{source}</span></label>;
                    })}
                  </div>
                </div>
                {/* Row 5: cache clear */}
                <div className="flex items-center gap-2 pt-1 border-t border-slate-800/60">
                  <button
                    onClick={async () => {
                      try { await fetchWithApiFallback("/api/cache/clear", { method: "POST" }); setUiError(""); alert("Cache cleared."); }
                      catch { setUiError("Failed to clear cache."); }
                    }}
                    className="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-1 text-xs font-semibold text-slate-400 transition hover:border-red-500/40 hover:text-red-400 hover:bg-red-500/5"
                  ><span className="flex items-center gap-1.5"><Trash2 size={12} />Clear Cache</span></button>
                  <span className="text-xs text-slate-600">Clears in-memory backend cache</span>
                </div>
              </div>
            </div>
            )}

            {/* ── Sprite commentary — lives below the textarea card at every
                stage so the user always has one consistent spot to glance at.
                Priority order of what gets displayed:
                  1. Thinking pulse — while the AI is deliberating on a fresh
                     edit. Reads as "the sprite is reading what you wrote".
                  2. AI message — whatever short reaction the last assessment
                     produced. Lives as long as the user hasn't started typing
                     something new.
                  3. Default hint — when the textarea is empty. Invites the
                     user in and shows the Enter key cue. Hidden once they've
                     typed anything, so the sprite's voice takes over.
                The Enter badge is only shown with the default hint AND at
                blank stage, since Enter-to-advance is only meaningful then.
                The whole row uses `stage-reveal` on first mount so it fades
                in with the rest of the landing rather than popping.

                The wrapper anchors the sprite at the TOP of the area
                directly under the textarea (justify-start instead of
                justify-center, no min-height). Earlier we centred the
                sprite inside a 14rem reserved band on the landing so it
                floated mid-page; users found that confusing because the
                sprite then jumped UP toward the textarea once angles
                arrived. Pinning it near the textarea bottom from the
                first frame keeps its position consistent across every
                state — empty landing, mid-stream, post-stream. */}
            <div className="flex flex-col items-center w-full">
            <Sprite
              ref={spriteRef}
              query={query}
              introStage={introStage as "blank" | "explore" | "full"}
              hasRunSearch={hasRunSearch}
              message={assessmentMessage}
              hoverHelp={hoverHelpText}
              onHoverHelp={setHoverHelpText}
              recommendedTerms={recommendedTerms}
              buttonStep={buttonStep}
              onPickRecommendedTerm={handlePickRecommendedTerm}
              onStartSearch={handleStartSearchFromSprite}
            />
            </div>
            {/* Sprite UI lives in src/components/sprite/Sprite.tsx — rendering
                logic, derived booleans (queryHasDrifted, showChoiceBubbles
                etc.) and the per-state markup are encapsulated there. The
                page only owns state + handler wiring. */}

            {/* Previously this slot held a two-line blurb explaining what
                Quick / Curated does. Removed — the sprite now volunteers a
                mode recommendation after the user picks a direction, so
                two sources of guidance competed for the same slot. The
                sprite line is the single source of truth. */}

            {/* The "QUERY: <selectedSearchQuery>" echo pill was removed —
                it duplicated the text already visible in the workspace
                textarea above and cluttered the landing view. The refined
                query is still applied internally when a direction is
                selected from Explore Angles; it just isn't rendered as a
                separate chip. */}

            {/* Inline query analysis — small lighter text while a deep search is running */}
            {plannerThinking && isSubmitting && !result && (
              <div className="mt-1.5 px-1 text-[10px] leading-snug text-slate-500/90">
                {plannerThinking.planner_summary && (
                  <div className="italic">{plannerThinking.planner_summary}</div>
                )}
                {(plannerThinking.search_focus || plannerThinking.query_type || (plannerThinking.agents_planned?.length ?? 0) > 0) && (
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[9.5px] text-slate-500/70">
                    {plannerThinking.search_focus && <span><span className="text-slate-600/80">Focus:</span> {plannerThinking.search_focus}</span>}
                    {plannerThinking.query_type && <span><span className="text-slate-600/80">Type:</span> {plannerThinking.query_type}</span>}
                    {plannerThinking.agents_planned && plannerThinking.agents_planned.length > 0 && (
                      <span><span className="text-slate-600/80">Agents:</span> {plannerThinking.agents_planned.join(", ")}</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Understanding progress bar removed — the streaming progress
                now lives entirely in the sprite chat. The sprite voice
                line surfaces the current stage ("Decomposing…",
                "Expanding…", "Building direction tree…") and a small
                "what I'm seeing" panel below shows the live decompose +
                expand payload (key terms, contexts, synonyms) as they
                stream in, so the user can watch the AI's thinking instead
                of staring at an indeterminate bar. */}

            {/* The legacy Research Angles accordion / direction-card grid /
                custom-query input has been removed entirely. The pre-search
                landing now consists of three pieces: textarea + Quick /
                Curated buttons + recommended-term chips (rendered by the
                Sprite component above). Settings panel was relocated to
                directly below the workspace card so opening it never
                pushes the user below the fold. */}
            
            {/* Divider between the action area and retrieved results — hidden alongside the
                Current Run block when idle, so the space below action row stays clean. */}
            {(isSubmitting || job?.status === "done" || job?.status === "error") && (
              <hr className="mt-5 border-slate-700/40" />
            )}

            {/* Current run status — only rendered while a search is in flight or just completed */}
            {(isSubmitting || job?.status === "done" || job?.status === "error") && (
            <div className={`ats-card mt-4 p-5 ${isSubmitting ? "border-blue-500/40 bg-[var(--ats-bg-accent-soft)]" : "border-blue-500/20 bg-[var(--ats-bg-card)]"}`}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className={`flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] ${job?.status === "error" ? "text-red-400" : "text-blue-400"}`}>
                    {isSubmitting && job?.status !== "error" && (
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
                    )}
                    {job?.status === "done" ? "Search complete" : job?.status === "error" ? "Search failed" : "Current run"}
                  </div>
                  <div className={`mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-slate-100 ${isSubmitting ? "animate-pulse" : ""}`}>
                    <span>{job?.message || (isSubmitting ? "Connecting…" : "Awaiting input")}</span>
                    {isSubmitting && retrievalCount !== null && (
                      <span className="text-xs text-blue-300 font-semibold shrink-0">
                        · {retrievalCount}{candidateLimit ? `/${candidateLimit}` : ""} papers
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {/* Stop button duplicated here so it's always visible while scrolled down */}
                  {isSubmitting && (
                    <button
                      onClick={handleStop}
                      className="shrink-0 flex items-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 transition hover:bg-red-500/20"
                    >
                      <Square size={12} fill="currentColor" />
                      <span>Stop</span>
                    </button>
                  )}
                  <div className="text-right text-sm text-slate-300">
                    <div className={`font-semibold text-slate-100 ${isSubmitting && displayProgress < 100 ? "animate-pulse" : ""}`}>{displayProgress}%</div>
                    {runTimeLabel && <div className="text-xs text-slate-500">{runTimeLabel}</div>}
                  </div>
                </div>
              </div>
              {/* Progress bar — pulses while running */}
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${displayProgress === 100 ? "bg-emerald-500" : "bg-blue-500"} ${isSubmitting && displayProgress < 100 ? "animate-pulse" : ""}`}
                  style={{ width: `${Math.max(displayProgress, isSubmitting ? 3 : 0)}%` }}
                />
              </div>

              {/* Deep mode: completed agents badges only (no brief indicator here) */}
              {!fastMode && isSubmitting && (() => {
                const completedAgents = (["evidence_mapper","scholar","gap_analyst","verifier"] as const)
                  .filter(k => agentData[k]);
                if (completedAgents.length === 0) return null;
                const agentLabels: Record<string,string> = {
                  evidence_mapper:"Evidence Mapper", scholar:"Scholar",
                  gap_analyst:"Gap Analyst", verifier:"Verifier"
                };
                return (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 px-0.5">
                    {completedAgents.map(key => (
                      <span key={key} className="flex items-center gap-1 text-[10px] text-emerald-400">
                        <Check size={10} strokeWidth={3} /><span>{agentLabels[key]}</span>
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
            )}

            {/* Planner thinking is rendered inline under the Query box above — no separate panel */}

            {/* Retrieved Papers is hidden on the clean landing and only
                mounts once a search has actually started. `hasRunSearch`
                stays true for the rest of the session, so subsequent runs
                keep the list visible between searches. `firstInteractionDone`
                is retained inside the className purely so the rise animation
                keyframe fires on first reveal. */}
            {(hasRunSearch || isSubmitting || displayedPapers.length > 0) && (
            <div className={`mt-6 border-t border-slate-800 pt-6 ${firstInteractionDone ? "retrieved-papers-rise" : "hidden"}`}>
              <div className="mb-3 flex items-center gap-3">
                <span className="flex items-center gap-2 text-xl font-black"><BookOpen size={18} /><span>Retrieved Papers</span></span>
                {papersAreStreaming && (
                  <span className="flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-400">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                    Deep analysis running…
                  </span>
                )}
                {displayedPapers.length > 0 && (
                  <span className="text-sm text-slate-500">
                    {retrievedPoolSize > displayedPapers.length
                      ? <>Selected <span className="font-semibold text-slate-300">{displayedPapers.length}</span> from <span className="font-semibold text-slate-300">{retrievedPoolSize.toLocaleString()}</span> retrieved</>
                      : <>{displayedPapers.length} papers</>}
                  </span>
                )}
              </div>
              {papersAreStreaming && (
                <div className="mb-3 rounded-2xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="flex items-center gap-1.5 text-blue-300 font-semibold">
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400 shrink-0" />
                      Deep analysis in progress
                    </span>
                    <span className="text-slate-500 tabular-nums">{progress}%</span>
                  </div>
                  {/* Progress bar — layered: (1) determinate backing fill
                      whose width tracks the real backend progress so the
                      user still has a "how far along" signal, and
                      (2) the product-wide `progress-slide` sliding
                      segment on top so there's always motion even when
                      the percentage holds steady between backend events.
                      Same keyframe as ProgressStrip / Query Understanding
                      for a consistent loading idiom across the product. */}
                  <div className="relative h-1 w-full overflow-hidden rounded-full bg-slate-800 mb-1.5">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-blue-500/55 transition-all duration-700"
                      style={{ width: `${Math.max(progress, 5)}%` }}
                    />
                    <div
                      className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-blue-400"
                      style={{ animation: "progress-slide 1.2s ease-in-out infinite" }}
                    />
                  </div>
                  {/* Raw backend message — shows exact step (e.g. adversarial batch X/Y).
                      Prefixed with a tiny animated dot so the message
                      area also reads as "actively updating" even when
                      the same step label is shown for several seconds. */}
                  <div className="text-[11px] text-slate-400 leading-snug flex items-center gap-1.5">
                    <span
                      className="inline-block h-1 w-1 rounded-full bg-blue-400/70 animate-pulse shrink-0"
                      aria-hidden
                    />
                    <span className="italic truncate">
                      {rawProgressMsg || "Initialising deep validation…"}
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] text-slate-600">
                    {displayedPapers.length} candidates found · Scores available after analysis completes
                  </div>
                </div>
              )}
              {displayedPapers.length > 0 ? (
                <div className="space-y-5">
                  {displayedPapers.map((paper, index) => {
                    const paperKey = getPaperKey(paper, index);
                    const langs = translationLanguages[paperKey] || ["Chinese (Simplified)"];
                    const deepRead = deepReadResults[paperKey];
                    return (
                      <article key={`${paper.title}-${index}`} className="rounded-3xl bg-slate-950/40 p-5 fade-in">
                        {/* Title row */}
                        <div className="flex items-start gap-3">
                          <h3 className="flex-1 text-sm font-semibold leading-snug break-words text-slate-100">{index + 1}. {paper.title || "Untitled"}</h3>
                          {/* Add-to-Lab button — only in final phase */}
                          {!papersAreStreaming && (() => {
                            const inLab = labRefs.some(r => r.key === paperKey);
                            return (
                              <button
                                onClick={() => inLab ? removeFromLab(paperKey) : addToLab(paper, paperKey)}
                                title={inLab ? "Remove from writing references" : "Use this paper as a reference in the writing tools"}
                                className={`shrink-0 mt-1 flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-all ${
                                  inLab
                                    ? "border-blue-500/50 bg-blue-500/10 text-blue-300 hover:border-rose-500/50 hover:text-rose-400 hover:bg-rose-500/10"
                                    : "border-slate-700 bg-slate-900/50 text-slate-500 hover:border-blue-500/50 hover:text-blue-400 hover:bg-blue-500/10"
                                }`}
                              >
                                {inLab ? <Check size={11} strokeWidth={3} /> : <Plus size={11} strokeWidth={3} />}
                                <span>{inLab ? "Reference" : "Add as reference"}</span>
                              </button>
                            );
                          })()}
                        </div>

                        {papersAreStreaming ? (
                          /* ── Phase 1: candidate preview ── */
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">Candidate</span>
                            <span><span className="font-semibold text-slate-300">Authors:</span> {paper.authors || "Unknown authors"}</span>
                            <span><span className="font-semibold text-slate-300">Year:</span> {paper.year || "Unknown year"}</span>
                            <span><span className="font-semibold text-slate-300">Source:</span> {paper.source || "Unknown source"}</span>
                          </div>
                        ) : (
                          /* ── Phase 2: full scored result ── */
                          <>
                        {/* Meta row — score chip first, then fields */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                          {(() => {
                            const deepScore = deepRead?.relevance_score != null ? (deepRead.relevance_score as number) : null;
                            const rawScore = deepScore ?? (paper.evidence_score as number) ?? (paper.score as number);
                            const sc = scoreChip(rawScore);
                            return (
                              <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold shrink-0 ${sc.cls}`}>
                                {sc.label} &middot; {rawScore != null ? `${rawScore}/100` : "N/A"}
                                {deepScore != null && <span className="ml-1 opacity-60 font-normal">(deep)</span>}
                              </span>
                            );
                          })()}
                          <span><span className="font-semibold text-slate-300">Authors:</span> {paper.authors || "Unknown authors"}</span>
                          <span><span className="font-semibold text-slate-300">Year:</span> {paper.year || "Unknown year"}</span>
                          <span><span className="font-semibold text-slate-300">Source:</span> {paper.source || "Unknown source"}</span>
                          {(() => {
                            const raw = paper.citation_count;
                            // Backend returns null/undefined when the source API did not expose a citation count.
                            // Surface that explicitly instead of hiding the field so readers can tell
                            // "undisclosed" apart from "zero citations".
                            if (raw === null || raw === undefined || raw === "") {
                              return (
                                <span className="inline-flex items-center gap-1 rounded-full border border-slate-600/50 bg-slate-700/30 px-2 py-0.5 text-[11px] font-medium text-slate-400" title="The source API did not publish a citation count for this paper.">
                                  <Quote size={10} />
                                  <span>Citations undisclosed</span>
                                </span>
                              );
                            }
                            const cn = Number(raw);
                            if (!Number.isFinite(cn) || cn < 0) return null;
                            const compact = cn >= 1000 ? `${(cn / 1000).toFixed(cn >= 10000 ? 0 : 1)}k` : String(cn);
                            return (
                              <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-300" title={`${cn} citations`}>
                                <Quote size={10} />
                                <span className="tabular-nums">{compact}</span>
                              </span>
                            );
                          })()}
                          <span><span className="font-semibold text-slate-300">OA:</span> {String(Boolean(paper.is_oa))}</span>
                          {paper.paper_type_label && paper.paper_type_label !== "theory/other" && (
                            <span><span className="font-semibold text-slate-300">Type:</span> {paper.paper_type_label}</span>
                          )}
                          {paper.domain_fit_label && paper.domain_fit_label !== "adjacent" && (
                            <span><span className="font-semibold text-slate-300">Domain fit:</span> {paper.domain_fit_label}</span>
                          )}
                        </div>

                        {/* One-line Insight */}
                        {paper.recommendation_reason && (
                          <div className="mt-1.5 flex items-start gap-1.5 border-l-2 border-slate-700 pl-3 text-xs text-slate-400 break-words leading-[1.35]">
                            <Lightbulb size={11} className="shrink-0 mt-0.5 text-amber-400/80" />
                            <span>{paper.recommendation_reason}</span>
                          </div>
                        )}

                        {/* Action buttons — single horizontal row; each shrinks + truncates
                            instead of reflowing to a second row as the panel narrows. */}
                        {(() => {
                          // Evaluate access once per paper render — avoids calling
                          // classifyPaperAccess three times per button, and gives a
                          // single source of truth for the "grey + tooltip" state.
                          const access = classifyPaperAccess(paper);
                          const isBlocked = !access.accessible;
                          // PDF-pipeline buttons use the same disabled-style so a
                          // user scanning the row sees "three greyed-out, one blue"
                          // and instantly knows only Open Paper will work here.
                          const blockedClasses = "border-slate-800 bg-slate-900/30 text-slate-500 cursor-not-allowed opacity-60";
                          const blockedTooltip = isBlocked ? access.reason : undefined;
                        return (
                        <div className="mt-3 flex flex-nowrap items-center gap-2 overflow-hidden">
                          {/* Open Paper — always enabled; publisher's own landing
                              page reliably works even when their PDF is paywalled. */}
                          {paper.url && (
                            <a href={paper.url} target="_blank" rel="noreferrer"
                               className="shrink min-w-0 inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 transition-all">
                              <ExternalLink size={12} className="shrink-0" /><span className="truncate">Open Paper</span>
                            </a>
                          )}
                          {/* Evidence Chain — TEMPORARILY DISABLED via the
                              EVIDENCE_CHAIN_ENABLED flag at the top of this
                              file. When the flag is off, the button renders
                              greyed-out with a tooltip explaining why;
                              runDeepRead is gated by `disabled` so the
                              click can't fire anyway. When re-enabled, the
                              button restores to the normal action-button
                              styling + `isBlocked` is NOT applied (Evidence
                              Chain is metadata-only; no PDF paywall gate
                              needed). */}
                          <button
                            onClick={() => { if (EVIDENCE_CHAIN_ENABLED) void runDeepRead(paper, paperKey); }}
                            disabled={!EVIDENCE_CHAIN_ENABLED || deepReadLoading[paperKey]}
                            title={!EVIDENCE_CHAIN_ENABLED ? EVIDENCE_CHAIN_DISABLED_NOTE : undefined}
                            className={`relative shrink min-w-0 inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all overflow-hidden ${
                              !EVIDENCE_CHAIN_ENABLED
                                ? "border-slate-800 bg-slate-900/30 text-slate-500 cursor-not-allowed opacity-60"
                                : deepReadLoading[paperKey]
                                ? "border-blue-500/60 bg-blue-500/15 text-blue-300"
                                : "border-slate-700 bg-slate-900/50 text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                            }`}
                          >
                            <ShieldCheck size={12} className={`shrink-0 ${deepReadLoading[paperKey] ? "animate-spin" : ""}`} />
                            <span className="truncate">
                              {!EVIDENCE_CHAIN_ENABLED
                                ? "Evidence Chain · soon"
                                : deepReadLoading[paperKey] ? "Tracing…" : "Evidence Chain"}
                            </span>
                            <ProgressStrip active={!!deepReadLoading[paperKey]} />
                          </button>
                          {/* Download PDF */}
                          <button
                            onClick={() => void triggerDownload(buildApiUrl("/api/papers/download-original"), { paper: toBackendPaper(paper) }, `${paper.title || "paper"}.pdf`, `${paperKey}-original`)}
                            disabled={isBlocked || originalLoading[`${paperKey}-original`]}
                            title={blockedTooltip}
                            className={`relative shrink min-w-0 inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all overflow-hidden ${
                              isBlocked
                                ? blockedClasses
                                : originalLoading[`${paperKey}-original`]
                                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                                : "border-slate-700 bg-slate-900/50 text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                            }`}
                          >
                            <Download size={12} className={`shrink-0 ${originalLoading[`${paperKey}-original`] ? "animate-pulse" : ""}`} />
                            <span className="truncate">{originalLoading[`${paperKey}-original`] ? "Downloading…" : "Download PDF"}</span>
                            <ProgressStrip active={!!originalLoading[`${paperKey}-original`]} />
                          </button>
                          {/* Translate PDF + inline language selector */}
                          <button
                            onClick={() => void triggerDownload(buildApiUrl("/api/papers/translate-pdf"), { paper: toBackendPaper(paper), target_languages: langs }, `${paper.title || "paper"}_${(langs[0] || "translated").replace(/\s*\(.*?\)/g, "").trim()}.pdf`, `${paperKey}-translate`)}
                            disabled={isBlocked || translateLoading[`${paperKey}-translate`]}
                            title={blockedTooltip}
                            className={`relative shrink min-w-0 inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all overflow-hidden ${
                              isBlocked
                                ? blockedClasses
                                : translateLoading[`${paperKey}-translate`]
                                ? "border-purple-500/60 bg-purple-500/10 text-purple-300"
                                : "border-slate-700 bg-slate-900/50 text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                            }`}
                          >
                            <Globe size={12} className={`shrink-0 ${translateLoading[`${paperKey}-translate`] ? "animate-spin" : ""}`} />
                            <span className="truncate">{translateLoading[`${paperKey}-translate`] ? "Translating…" : "Translate PDF"}</span>
                            <ProgressStrip active={!!translateLoading[`${paperKey}-translate`]} />
                          </button>
                          <select
                            value={langs[0] ?? "Chinese (Simplified)"}
                            onChange={(e) => setTranslationLanguages((prev) => ({ ...prev, [paperKey]: [e.target.value] }))}
                            className="shrink min-w-0 max-w-[9rem] rounded-xl border border-slate-700 bg-slate-900/50 px-2 py-1.5 text-xs text-slate-400 outline-none focus:border-purple-500/50 cursor-pointer truncate"
                          >
                            {["Chinese (Simplified)","Chinese (Traditional)","English","Japanese","Korean","Spanish","French","German","Indonesian"].map((lang) => (
                              <option key={lang} value={lang}>{lang}</option>
                            ))}
                          </select>
                          {/* Gentle inline note when all three PDF actions are
                              gated, so users don't just see a row of grey
                              buttons and wonder if something broke. Uses
                              muted slate text — never the red/yellow alert
                              palette, because this isn't an error, it's a
                              publisher choice. */}
                          {isBlocked && (
                            <span className="ml-1 shrink-0 hidden sm:inline-flex items-center gap-1 text-[10px] italic text-slate-500">
                              <span aria-hidden className="text-slate-600">·</span>
                              Not publicly accessible
                            </span>
                          )}
                        </div>
                        );
                        })()}

                        {/* Error messages — classified as "soft" (publisher didn't
                            expose the PDF — gray, informational) or "hard" (our
                            pipeline broke — red). Soft errors use the same muted
                            slate palette as the pre-gate "Not publicly accessible"
                            note above so the visual language is consistent: gray
                            always means "the publisher, not us". */}
                        {deepReadErrors[paperKey] && (
                          isSoftAccessError(deepReadErrors[paperKey])
                            ? <div className="mt-2 rounded-xl border border-slate-700/60 bg-slate-800/40 px-3 py-2 text-xs text-slate-400">{deepReadErrors[paperKey]}</div>
                            : <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{deepReadErrors[paperKey]}</div>
                        )}
                        {originalErrors[paperKey] && (
                          isSoftAccessError(originalErrors[paperKey])
                            ? <div className="mt-2 rounded-xl border border-slate-700/60 bg-slate-800/40 px-3 py-2 text-xs text-slate-400">{originalErrors[paperKey]}</div>
                            : <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{originalErrors[paperKey]}</div>
                        )}
                        {translateErrors[paperKey] && (
                          isSoftAccessError(translateErrors[paperKey])
                            ? <div className="mt-2 rounded-xl border border-slate-700/60 bg-slate-800/40 px-3 py-2 text-xs text-slate-400">{translateErrors[paperKey]}</div>
                            : <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{translateErrors[paperKey]}</div>
                        )}

                        {/* Abstract — collapsed by default.
                            Some sources (Google Scholar, CORE) return only a
                            SERP snippet rather than the full abstract — at
                            which point the text trails off with "…" and the
                            whole string is ≲ 250 chars. When we detect that
                            shape, show a small notice + direct link to the
                            source page, so the user doesn't think our
                            rendering cut it off. "No abstract available." is
                            the explicit backend fallback — surfaced clearly
                            instead of hidden under the collapsed summary. */}
                        {paper.summary && (() => {
                          const s = String(paper.summary || "").trim();
                          const isMissing = s === "No abstract available.";
                          const looksTruncated =
                            !isMissing && s.length < 260 && (s.endsWith("…") || s.endsWith("...") || /\b(snippet)\b/i.test(paper.source || ""));
                          return (
                            <details className="mt-3 rounded-xl bg-slate-950/20">
                              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-2">
                                <span>Abstract</span>
                                {isMissing && <span className="text-[10px] font-normal text-slate-500">not provided by source</span>}
                                {looksTruncated && (
                                  // Subdued muted-foreground token instead of
                                  // the old amber-400/80 — the previous colour
                                  // fought with every warm-paper / light theme
                                  // and still jumped out on dark themes, which
                                  // was overstating how important this note is.
                                  // A quiet meta-annotation reads correctly on
                                  // every surface.
                                  <span
                                    className="text-[10px] font-normal italic"
                                    style={{ color: "var(--ats-fg-muted)" }}
                                  >
                                    only a preview snippet — see source for the full abstract
                                  </span>
                                )}
                              </summary>
                              <p className="px-3 pb-3 pt-1 whitespace-pre-wrap break-words text-sm leading-7 text-slate-300">{paper.summary}</p>
                              {looksTruncated && paper.url && (
                                <p className="px-3 pb-3 -mt-2 text-xs text-slate-500">
                                  <a href={paper.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline inline-flex items-center gap-1">
                                    <ExternalLink size={10} />Open source page for the full abstract
                                  </a>
                                </p>
                              )}
                            </details>
                          );
                        })()}


                        {/* Empty state: the endpoint returned but produced
                            zero claims (paper metadata too thin for the
                            LLM to extract anything useful). Tell the user
                            rather than silently showing nothing. */}
                        {deepRead && Array.isArray(deepRead.claims) && deepRead.claims.length === 0 && (
                          <div className="mt-3 rounded-xl border border-slate-700/60 bg-slate-800/40 px-4 py-2.5 text-xs text-slate-400 flex items-start gap-2">
                            <ShieldCheck size={14} className="shrink-0 mt-0.5 text-slate-500" />
                            <span>
                              Evidence Chain couldn&apos;t extract structured claims from this paper&apos;s metadata. Try the abstract on the paper&apos;s source page via <span className="font-semibold">Open Paper</span>, or add this paper to Synthesis Lab where its full-text processing lives.
                            </span>
                          </div>
                        )}
                        {/* Evidence Chain result — collapsible. Replaces
                            the old Deep Reading narrative report. Each
                            claim gets its own card with a chain of source
                            entries (title / authors / year / strength pill
                            / clickable link) so users can trace exactly
                            where a statement came from. */}
                        {deepRead && Array.isArray(deepRead.claims) && deepRead.claims.length > 0 && (
                          <details className="mt-3 rounded-xl bg-blue-500/5" open>
                            <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-bold text-slate-200 hover:text-white transition-colors inline-flex items-center gap-2">
                              <ShieldCheck size={14} />
                              Evidence Chain
                              <span className="text-[10px] font-normal text-slate-500">
                                · {deepRead.claims.length} claim{deepRead.claims.length !== 1 ? "s" : ""}
                              </span>
                            </summary>
                            <div className="px-4 pb-4 pt-1 space-y-3">
                              {deepRead.claims.map((claim: Record<string, unknown>, ci: number) => {
                                const claimText = String((claim?.claim ?? claim?.claim_text) || "").trim();
                                if (!claimText) return null;
                                const support  = String(claim?.support_level || "moderate").toLowerCase();
                                const chain    = Array.isArray(claim?.evidence_chain) ? (claim.evidence_chain as Array<Record<string, unknown>>) : [];
                                const chainColor =
                                  support === "strong"   ? "#10b981"
                                  : support === "weak"   ? "#f59e0b"
                                  : "#3b82f6";
                                return (
                                  <div key={ci} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                                    {/* Claim text — the thing being supported */}
                                    <div className="flex items-start gap-2">
                                      <span
                                        className="shrink-0 mt-0.5 inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-bold tabular-nums"
                                        style={{ backgroundColor: `${chainColor}22`, color: chainColor, border: `1px solid ${chainColor}55` }}
                                      >
                                        C{ci + 1}
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm leading-snug text-slate-100 break-words">
                                          {claimText}
                                        </p>
                                        {(claim.scope_note || claim.claim_type) ? (
                                          <p className="mt-0.5 text-[10px] text-slate-500">
                                            {claim.claim_type ? <span className="uppercase tracking-wider font-bold text-slate-400">{String(claim.claim_type)}</span> : null}
                                            {claim.claim_type && claim.scope_note ? " · " : ""}
                                            {claim.scope_note ? String(claim.scope_note) : ""}
                                          </p>
                                        ) : null}
                                      </div>
                                      {/* Support-level pill */}
                                      <span
                                        className="shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                                        style={{ backgroundColor: `${chainColor}22`, color: chainColor, border: `1px solid ${chainColor}55` }}
                                      >
                                        {support}
                                      </span>
                                    </div>
                                    {/* Evidence chain entries */}
                                    {chain.length > 0 && (
                                      <div className="mt-2 pl-7 space-y-1.5">
                                        {chain.map((entry, ei) => {
                                          const link = String(entry?.link || "").trim();
                                          const strength = String(entry?.evidence_strength || "moderate").toLowerCase();
                                          const entryColor =
                                            strength === "strong" ? "#10b981"
                                            : strength === "weak" ? "#f59e0b"
                                            : "#64748b";
                                          return (
                                            <div key={ei} className="flex items-start gap-1.5 text-[11px] leading-snug">
                                              <LinkIcon size={10} className="shrink-0 mt-[3px] text-slate-600" />
                                              <div className="flex-1 min-w-0">
                                                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0">
                                                  {link ? (
                                                    <a
                                                      href={link}
                                                      target="_blank"
                                                      rel="noreferrer"
                                                      className="font-semibold text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline break-words"
                                                      title={link}
                                                    >
                                                      {String(entry?.title || "(untitled)")}
                                                    </a>
                                                  ) : (
                                                    <span className="font-semibold text-slate-300 break-words">
                                                      {String(entry?.title || "(untitled)")}
                                                    </span>
                                                  )}
                                                  {entry?.year != null && entry.year !== "" && (
                                                    <span className="text-slate-500">({String(entry.year)})</span>
                                                  )}
                                                  <span
                                                    className="text-[9px] font-bold uppercase tracking-wider px-1 py-0 rounded"
                                                    style={{ color: entryColor, border: `1px solid ${entryColor}55` }}
                                                  >
                                                    {strength}
                                                  </span>
                                                </div>
                                                {entry?.authors ? (
                                                  <div className="text-slate-500 text-[10px] break-words">
                                                    {String(entry.authors)}
                                                    {entry?.source ? <span className="text-slate-600"> · {String(entry.source)}</span> : null}
                                                  </div>
                                                ) : null}
                                                {entry?.summary ? (
                                                  <div className="mt-0.5 text-slate-400 text-[11px] leading-snug break-words">
                                                    {String(entry.summary)}
                                                  </div>
                                                ) : null}
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                              {/* Copy / download — shortened since the
                                  structured output is the better artefact.
                                  Users who want a file can still reach this. */}
                              <div className="flex flex-nowrap items-center gap-1.5">
                                <button
                                  onClick={() => {
                                    const lines: string[] = [];
                                    lines.push(`# Evidence Chain: ${paper.title || "Paper"}`);
                                    for (const c of (deepRead.claims || [])) {
                                      const cText = String((c as Record<string, unknown>)?.claim || (c as Record<string, unknown>)?.claim_text || "").trim();
                                      if (!cText) continue;
                                      lines.push(`\n## ${cText}`);
                                      const cc = (c as Record<string, unknown>)?.evidence_chain;
                                      if (Array.isArray(cc)) {
                                        for (const e of cc) {
                                          const en = e as Record<string, unknown>;
                                          lines.push(`- [${en.evidence_strength || "moderate"}] ${en.title || "(untitled)"} (${en.year ?? "—"}) — ${en.link || "no link"}`);
                                        }
                                      }
                                    }
                                    void navigator.clipboard.writeText(lines.join("\n"));
                                  }}
                                  className="shrink min-w-0 inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-500 hover:text-blue-400 hover:border-blue-500/50 transition-colors"
                                ><ClipboardList size={11} className="shrink-0" /><span className="truncate">Copy chain</span></button>
                              </div>
                            </div>
                          </details>
                        )}
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : isSubmitting ? (
                <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm animate-pulse">
                  <div className="flex items-center gap-2 text-blue-300 font-medium">
                    <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
                    Retrieving papers — this may take a few minutes…
                  </div>
                  <div className="mt-1.5 text-xs text-slate-500">Searching academic databases and ranking by relevance</div>
                </div>
              ) : (
                <div className="rounded-2xl bg-slate-900/30 p-4 text-sm text-slate-500">No papers returned yet.</div>
              )}
            </div>
            )}
            </div>
          </section>
          </ErrorBoundary>

          <DividerScrollbar onResizeStart={() => startDrag("center")} onSnap={snapDividerToDefault} sectionRef={centerSectionRef} />

          {/* Right panel — Synthesis Lab. Isolated so a crash in the
              Lab editor or reference list doesn't take down search +
              the workspace alongside it. */}
          <ErrorBoundary label="Synthesis Lab">
          {/* Analytics column — slides in/out to the right */}
          <div className="relative min-w-0 h-full overflow-hidden rounded-xl">
            {/* Expand button — at header height on the right edge, square. */}
            <button
              onClick={() => setAnalyticsVisible(true)}
              title="Show Synthesis Lab"
              aria-label="Show Synthesis Lab panel"
              style={{
                opacity: analyticsVisible ? 0 : 1,
                pointerEvents: analyticsVisible ? "none" : "auto",
                transition: "opacity 0.25s 0.55s ease",
              }}
              className="absolute top-[11px] right-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border border-[var(--ats-border-subtle)] bg-[var(--ats-bg-panel)] text-slate-400 hover:text-blue-400 hover:border-blue-500/60 transition-colors"
            ><PanelRightOpen size={15} /></button>
            {/* ── Right panel: Synthesis Lab ── */}
            <aside
              data-region="lab"
              className="absolute inset-0 flex flex-col rounded-xl bg-[var(--ats-bg-section)] ats-panel overflow-hidden"
              style={{
                transform: analyticsVisible ? "translateX(0)" : "translateX(105%)",
                transition: "transform 0.9s cubic-bezier(0.25,0.8,0.25,1)",
              }}
            >
              {/* Collapse button — aligned with header, square. */}
              <button
                onClick={() => setAnalyticsVisible(false)}
                title="Hide panel"
                aria-label="Hide Synthesis Lab panel"
                className="absolute top-[11px] right-2 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-[var(--ats-border-subtle)] bg-[var(--ats-bg-panel)] text-slate-400 hover:text-blue-400 hover:border-blue-500/60 transition-colors"
              ><PanelRightClose size={15} /></button>
              {/* Header bar — two-tab module switcher (Synthesis Lab | Paper
                  Review). Styling MIRRORS the left panel's Research Brief /
                  Charts tabs exactly: no border, same padding, same font
                  weight, same active-tab treatment (slate-900/70 fill). The
                  visual unit is the tab bar itself, not each pill — matches
                  the rest of the product so users don't read this as a
                  different control than the left panel's tabs. Trailing
                  padding reserves space for the absolute collapse button. */}
              <div className="shrink-0 flex items-center gap-1.5 pl-3 pr-12 py-2.5 border-b border-slate-800/60">
                {/* Paper Review is the first tab — it's the more common
                    starting point for a user arriving with a draft they
                    want feedback on. Synthesis Lab still follows right
                    after for users who came through the search → papers
                    flow. */}
                <button
                  onClick={() => setLabModule("review")}
                  {...helpProps("Paper Review — paste your draft and get adversarial multi-agent peer review")}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                    labModule === "review"
                      ? "bg-slate-900/70 text-slate-100"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                  title="Peer review of your draft"
                >
                  <ShieldCheck size={14} />
                  <span>Paper Review</span>
                </button>
                <button
                  onClick={() => setLabModule("synthesis")}
                  {...helpProps("Synthesis Lab — write a draft using the papers you've collected as references")}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                    labModule === "synthesis"
                      ? "bg-slate-900/70 text-slate-100"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                  title="Write from selected papers"
                >
                  <PenLine size={14} />
                  <span>Synthesis Lab</span>
                  {labRefs.length > 0 && (
                    <span className={`ml-0.5 rounded-full px-1.5 text-[10px] font-bold ${
                      labModule === "synthesis" ? "bg-slate-700/70 text-slate-200" : "bg-slate-800/60 text-slate-400"
                    }`}>{labRefs.length}</span>
                  )}
                </button>
              </div>

              {/* ── Paper Review module ─────────────────────────────────
                  Self-contained panel with its own state / streaming /
                  agent log. Rendered in a scrollable flex child so long
                  review letters stay inside the Lab column. */}
              {labModule === "review" && (
                <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar">
                  <PaperReviewPanel />
                </div>
              )}

              {/* ── Synthesis Lab content — gated only when nothing has happened yet.
                  Once the user has added papers, typed core argument, added points,
                  uploaded files, or generated output, the Lab stays open even if
                  the current search has no results — their in-progress work is preserved. */}
              {labModule === "synthesis" && (
              <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar">
                {(() => {
                  const hasLabState =
                    labRefs.length > 0 ||
                    labUserFiles.length > 0 ||
                    labCoreArg.trim().length > 0 ||
                    labPoints.some(p => p.trim().length > 0) ||
                    !!labResult ||
                    labRuns.length > 0 ||
                    labGenerating;
                  const shouldGate = displayedPapers.length === 0 && !hasLabState;
                  return shouldGate;
                })() ? (
                  <div className="flex min-h-[20rem] h-full items-center justify-center px-6 text-center">
                    <div className="max-w-[22rem] text-xs leading-relaxed text-slate-500">
                      Run a search first — writing tools unlock when papers arrive.
                    </div>
                  </div>
                ) : (
                <div className="px-4 py-4 space-y-4">

                  {/* References — compact header + tighter empty state for a denser top of Lab. */}
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-200"><BookOpen size={14} /><span>Papers to use</span></span>
                      <span className="text-xs text-slate-500">{labRefs.length} picked</span>
                    </div>
                    {labRefs.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-700 py-2.5 text-center text-xs text-slate-600 leading-5">
                        Pick papers with <span className="text-violet-400 font-semibold">Add as reference</span>.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {labRefs.map(({ key, paper }) => (
                          <div key={key} className="flex items-start gap-2 rounded-lg border border-slate-800/60 bg-slate-900/50 px-3 py-1.5">
                            <span className="flex-1 text-xs text-slate-300 leading-5 break-words line-clamp-2">{paper.title}</span>
                            <button onClick={() => removeFromLab(key)} className="shrink-0 mt-0.5 text-slate-600 hover:text-rose-400 transition-colors text-xs">✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="h-px bg-slate-800" />

                  {/* User file upload — compact dropzone so the top of the Lab stays dense. */}
                  <div>
                    <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-200"><Upload size={14} /><span>Add your own files</span></label>
                    <p className="mt-0.5 text-[11px] text-slate-500">PDF, TXT, or Markdown. Drag & drop works.</p>
                    <label
                      className="mt-1.5 flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-3 py-2.5 text-xs text-slate-500 transition hover:border-violet-500/50 hover:text-violet-400"
                      onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("border-violet-500/60", "bg-violet-500/5"); }}
                      onDragLeave={(e) => { e.currentTarget.classList.remove("border-violet-500/60", "bg-violet-500/5"); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.remove("border-violet-500/60", "bg-violet-500/5");
                        const files = Array.from(e.dataTransfer.files).filter(f => /\.(pdf|txt|md|docx)$/i.test(f.name));
                        setLabUserFiles(prev => {
                          const names = new Set(prev.map(f => f.name));
                          return [...prev, ...files.filter(f => !names.has(f.name))];
                        });
                      }}
                    >
                      <FolderOpen size={18} className="text-slate-400" />
                      <span>Drop a file or click to choose</span>
                      <input
                        type="file"
                        accept=".pdf,.txt,.md,.docx"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          const files = Array.from(e.target.files || []);
                          setLabUserFiles(prev => {
                            const names = new Set(prev.map(f => f.name));
                            return [...prev, ...files.filter(f => !names.has(f.name))];
                          });
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {labUserFiles.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {labUserFiles.map((f, i) => (
                          <div key={i} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-1.5">
                            <span className="flex-1 truncate text-xs text-slate-300">{f.name}</span>
                            <button onClick={() => setLabUserFiles(prev => prev.filter((_, j) => j !== i))} className="shrink-0 text-slate-600 hover:text-rose-400 transition-colors text-xs">✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Output Type — placed right after Upload so the spec-specific fields
                      below already reflect the type the user just picked. */}
                  <div>
                    <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-200"><FileText size={14} /><span>What do you want to write?</span></label>
                    <select
                      value={labOutputType}
                      onChange={e => setLabOutputType(e.target.value)}
                      className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500"
                    >
                      <option value="literature_review">Literature Review</option>
                      <option value="theoretical_framework">Theoretical Framework</option>
                      <option value="research_proposal">Research Proposal</option>
                      <option value="discussion">Discussion Section</option>
                      <option value="introduction">Introduction</option>
                      <option value="conclusion">Conclusion</option>
                      <option value="abstract">Abstract</option>
                      <option value="argumentative_essay">Academic Essay</option>
                    </select>
                  </div>

                  <div className="h-px bg-slate-800" />

                  {/* Fields below rerender whenever labOutputType changes.
                      Spec lives in src/lib/lab-fields.ts — edit there to change a type's inputs. */}
                  {(() => {
                    const spec = labFieldSpec(labOutputType);
                    const pointsPh = labPointsPlaceholder(spec);
                    const hasPoints = spec.pointsLabel !== null && spec.pointsLabel !== undefined;
                    // Subdued inline label — only surfaces when a field is
                    // strongly recommended. Optional fields get no annotation
                    // (empty nodes render nothing) because "optional" is the
                    // default expectation — adding it just adds visual noise.
                    const requiredBadge = (req: boolean) => (
                      req
                        ? <span className="ml-1.5 shrink-0 text-[10px] font-normal italic text-amber-400/80">
                            recommended
                          </span>
                        : null
                    );
                    return (
                      <>
                        {/* Type blurb — tells the user what the output is */}
                        {spec.blurb && (
                          <p className="-mt-2 text-[11px] italic text-slate-500">{spec.blurb}</p>
                        )}

                        {/* Core argument (label + description + required flag adapt per type) */}
                        <div>
                          <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                            <PenLine size={14} />
                            <span>{spec.coreLabel}</span>
                            {requiredBadge(spec.coreRequired)}
                          </label>
                          <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{spec.coreDescription}</p>
                          <textarea
                            value={labCoreArg}
                            onChange={e => setLabCoreArg(e.target.value)}
                            placeholder={spec.corePlaceholder}
                            rows={spec.coreRows ?? 3}
                            className="mt-2 w-full resize-y hairline-scrollbar rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-violet-500 placeholder:text-slate-600"
                          />
                        </div>

                        {/* Points list — multi-entry by design */}
                        {hasPoints && (
                          <div>
                            <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                              <ListChecks size={14} />
                              <span>{spec.pointsLabel}</span>
                              {requiredBadge(!!spec.pointsRequired)}
                            </label>
                            {spec.pointsDescription && (
                              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{spec.pointsDescription}</p>
                            )}
                            <div className="mt-2 space-y-2">
                              {labPoints.map((pt, i) => (
                                <div key={i} className="flex items-center gap-2">
                                  <input
                                    value={pt}
                                    onChange={e => setLabPoints(prev => prev.map((p, j) => j === i ? e.target.value : p))}
                                    placeholder={pointsPh(i)}
                                    className="flex-1 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500 placeholder:text-slate-600"
                                  />
                                  {labPoints.length > 1 && (
                                    <button onClick={() => setLabPoints(prev => prev.filter((_, j) => j !== i))} className="shrink-0 text-slate-600 hover:text-rose-400 transition-colors">✕</button>
                                  )}
                                </div>
                              ))}
                              <button onClick={() => setLabPoints(prev => [...prev, ""])} className="text-xs text-slate-500 hover:text-violet-400 transition-colors">{spec.pointsAddLabel ?? "+ Add Point"}</button>
                            </div>
                          </div>
                        )}

                        {/* Spec-specific extras — single or multi depending on field.multi */}
                        {(spec.extras ?? []).map(field => (
                          <div key={field.key}>
                            <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                              <PenLine size={14} />
                              <span>{field.label}</span>
                              {requiredBadge(field.required)}
                            </label>
                            <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{field.description}</p>
                            {field.multi ? (
                              <div className="mt-2 space-y-2">
                                {((labExtrasMulti[field.key] ?? [""]).length === 0 ? [""] : (labExtrasMulti[field.key] ?? [""])).map((val, i) => (
                                  <div key={i} className="flex items-start gap-2">
                                    {field.rows ? (
                                      <textarea
                                        value={val}
                                        onChange={e => setLabExtrasMulti(prev => {
                                          const arr = [...(prev[field.key] ?? [""])];
                                          arr[i] = e.target.value;
                                          return { ...prev, [field.key]: arr };
                                        })}
                                        placeholder={field.placeholder}
                                        rows={field.rows}
                                        className="flex-1 resize-y rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-violet-500 placeholder:text-slate-600"
                                      />
                                    ) : (
                                      <input
                                        value={val}
                                        onChange={e => setLabExtrasMulti(prev => {
                                          const arr = [...(prev[field.key] ?? [""])];
                                          arr[i] = e.target.value;
                                          return { ...prev, [field.key]: arr };
                                        })}
                                        placeholder={field.placeholder}
                                        className="flex-1 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500 placeholder:text-slate-600"
                                      />
                                    )}
                                    {((labExtrasMulti[field.key] ?? [""]).length > 1) && (
                                      <button
                                        onClick={() => setLabExtrasMulti(prev => ({
                                          ...prev,
                                          [field.key]: (prev[field.key] ?? []).filter((_, j) => j !== i),
                                        }))}
                                        className="shrink-0 mt-1 text-slate-600 hover:text-rose-400 transition-colors"
                                      >✕</button>
                                    )}
                                  </div>
                                ))}
                                <button
                                  onClick={() => setLabExtrasMulti(prev => ({
                                    ...prev,
                                    [field.key]: [...(prev[field.key] ?? [""]), ""],
                                  }))}
                                  className="text-xs text-slate-500 hover:text-violet-400 transition-colors"
                                >{field.addLabel ?? "+ Add"}</button>
                              </div>
                            ) : field.rows ? (
                              <textarea
                                value={labExtras[field.key] ?? ""}
                                onChange={e => setLabExtras(prev => ({ ...prev, [field.key]: e.target.value }))}
                                placeholder={field.placeholder}
                                rows={field.rows}
                                className="mt-2 w-full resize-y hairline-scrollbar rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-violet-500 placeholder:text-slate-600"
                              />
                            ) : (
                              <input
                                value={labExtras[field.key] ?? ""}
                                onChange={e => setLabExtras(prev => ({ ...prev, [field.key]: e.target.value }))}
                                placeholder={field.placeholder}
                                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500 placeholder:text-slate-600"
                              />
                            )}
                          </div>
                        ))}
                      </>
                    );
                  })()}

                  <div className="h-px bg-slate-800" />

                  {/* Output Type moved up — placed right after Upload Your Files. */}

                  {/* Target pages */}
                  <div>
                    <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-200"><Ruler size={14} /><span>How long?</span></label>
                    <div className="mt-2 flex items-center gap-3">
                      <input
                        type="range" min={1} max={15} step={1}
                        value={labTargetPages}
                        onChange={e => setLabTargetPages(Number(e.target.value))}
                        className="flex-1 accent-violet-500 cursor-pointer"
                      />
                      <span className="shrink-0 w-20 text-right text-sm font-bold text-violet-400">
                        {labTargetPages} {labTargetPages === 1 ? "page" : "pages"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">≈ {labTargetPages * 450} words · {Math.min(labTargetPages + 1, 8)} sections</p>
                  </div>

                  {/* Citation Format — sits directly above Output Language so the two
                      output-format controls live next to each other in one block. */}
                  <div>
                    <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-200"><Quote size={14} /><span>Citation style</span></label>
                    <select
                      value={labCitationFormat}
                      onChange={e => setLabCitationFormat(e.target.value)}
                      className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500"
                    >
                      <option value="APA 7th Edition">APA 7th Edition</option>
                      <option value="MLA 9th Edition">MLA 9th Edition</option>
                      <option value="Chicago 17th Edition">Chicago 17th Edition</option>
                      <option value="Vancouver">Vancouver</option>
                      <option value="Harvard">Harvard</option>
                      <option value="IEEE">IEEE</option>
                      <option value="AMA">AMA (Medical)</option>
                      <option value="Turabian">Turabian</option>
                    </select>
                  </div>

                  {/* Output language */}
                  <div>
                    <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-200"><Globe size={14} /><span>Writing language</span></label>
                    <select
                      value={labLanguage}
                      onChange={e => setLabLanguage(e.target.value)}
                      className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500"
                    >
                      <option value="English">English</option>
                      <option value="Chinese (Simplified)">Chinese (Simplified)</option>
                      <option value="Chinese (Traditional)">Chinese (Traditional)</option>
                      <option value="Japanese">Japanese</option>
                      <option value="Korean">Korean</option>
                      <option value="Spanish">Spanish</option>
                      <option value="French">French</option>
                      <option value="German">German</option>
                      <option value="Portuguese">Portuguese</option>
                      <option value="Arabic">Arabic</option>
                    </select>
                  </div>

                  {/* Generate / Stop row — Generate button gets the same
                      spinning-icon + sliding-bar treatment as the brief
                      Translate button so its in-flight state reads the
                      same way across the app. */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => void handleSynthesize()}
                      disabled={labRefs.length === 0 || labGenerating}
                      className={`relative flex-1 rounded-xl px-4 py-3 text-sm font-bold transition-all disabled:cursor-not-allowed overflow-hidden ${
                        labGenerating
                          ? "border border-violet-500/40 bg-violet-500/10 text-violet-300"
                          : "bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40"
                      }`}
                    >
                      <span className="flex items-center justify-center gap-1.5">
                        <Sparkles size={14} className={labGenerating ? "animate-spin" : ""} />
                        {labGenerating ? "Writing…" : "Write it for me"}
                      </span>
                      <ProgressStrip active={labGenerating} />
                    </button>
                    {labGenerating && (
                      <button
                        onClick={handleLabStop}
                        className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-3 text-sm font-bold text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-all"
                        title="Stop generation"
                      ><span className="flex items-center gap-1.5"><Square size={14} />Stop</span></button>
                    )}
                  </div>

                  {/* ── Run-history tabs ────────────────────────────────────
                      Only shown once the user has ≥ 2 archived runs. Each
                      button switches the displayed article + agent log +
                      reviewer notes to that past run; "Latest" returns to
                      the live working buffer (useful after Regenerate).
                      Tabs are disabled mid-generation so a switch doesn't
                      interrupt the streaming writer's target. */}
                  {labRuns.length >= 2 && (
                    <div
                      className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-700/50 bg-slate-900/40 px-2 py-1.5"
                      role="tablist"
                      aria-label="Past Lab generations"
                    >
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 pl-1 pr-1">Runs:</span>
                      {labRuns.map((run, i) => {
                        const isActive = labViewingId === run.id;
                        return (
                          <button
                            key={run.id}
                            role="tab"
                            aria-selected={isActive}
                            disabled={labGenerating}
                            onClick={() => setLabViewingId(run.id)}
                            title={`Run ${i + 1} — ${new Date(run.createdAt).toLocaleTimeString()}`}
                            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                              isActive
                                ? "border-violet-500/60 bg-violet-500/15 text-violet-200"
                                : "border-slate-700/60 bg-slate-900/40 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                            }`}
                          >
                            Run {i + 1}
                          </button>
                        );
                      })}
                      {/* "Latest" pill — returns to the live buffer so the
                          user can see a fresh Regenerate as it streams. */}
                      <button
                        role="tab"
                        aria-selected={labViewingId === null}
                        disabled={labGenerating}
                        onClick={() => setLabViewingId(null)}
                        title="Show the live/working buffer"
                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          labViewingId === null
                            ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                            : "border-slate-700/60 bg-slate-900/40 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                        }`}
                      >
                        Latest
                      </button>
                    </div>
                  )}

                  {/* Writing model selector (collapsible).
                      Displays user-facing aliases ("Swift Writer" / "Deep
                      Writer" / "Scholar Writer"); the backend still receives
                      the real provider model id under the hood. */}
                  <div>
                    <button
                      onClick={() => setLabModelOpen(o => !o)}
                      className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      <span>{labModelOpen ? "▾" : "▸"}</span>
                      <span>Writer: <span className="text-violet-400 font-semibold">{labModelLabel(labWritingModel)}</span></span>
                    </button>
                    {labModelOpen && (
                      <div className="mt-2 flex flex-nowrap items-center gap-2 overflow-hidden">
                        {LAB_MODEL_OPTIONS.map(m => (
                          <button
                            key={m.id}
                            onClick={() => setLabWritingModel(m.id)}
                            className={`shrink min-w-0 inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all ${labWritingModel === m.id ? "border-violet-500/60 bg-violet-500/15 text-violet-300" : "border-slate-700 bg-slate-900/40 text-slate-400 hover:border-slate-600 hover:text-slate-200"}`}
                          >
                            <span className="truncate">{m.label}</span>
                            <span className="truncate font-normal text-slate-500">{m.tagline}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Progress bar */}
                  {labGenerating && labAgentLog.length > 0 && (() => {
                    const done = labAgentLog.filter(e => e.done || e.error).length;
                    const total = labAgentLog.length;
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    return (
                      <div className="space-y-0.5">
                        <div className="flex justify-between text-[10px] text-slate-500">
                          <span>{done}/{total} agents done</span>
                          <span>{pct}%</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-violet-500 transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })()}

                  {/* Agent activity panel — reads displayedLabAgentLog so
                      past-run tabs also show the original agent trace. */}
                  {(labGenerating || displayedLabAgentLog.length > 0) && (
                    <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 px-3 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <button
                          onClick={() => setLabAgentLogOpen(o => !o)}
                          className="flex items-center gap-1.5 text-xs font-bold text-violet-400 hover:text-violet-300 transition-colors"
                        >
                          {labAgentLogOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          <Bot size={12} />
                          <span>Agent Activity</span>
                          {!labAgentLogOpen && displayedLabAgentLog.length > 0 && (
                            <span className="text-slate-500 font-normal">({displayedLabAgentLog.length} agents)</span>
                          )}
                        </button>
                        {labGenerating && !labViewingId && (
                          <span className="text-xs text-slate-500 animate-pulse ml-1">{labStatus.replace(/^\[[^\]]+\]\s*/, "") || "Running…"}</span>
                        )}
                      </div>
                      {labAgentLogOpen && (
                      <div>
                      {displayedLabAgentLog.length === 0 && labGenerating && !labViewingId && (
                        <div className="text-xs text-slate-600 animate-pulse">Initialising…</div>
                      )}
                      <div className="space-y-1 mt-1.5">
                        {displayedLabAgentLog.map(entry => {
                          const isWriter   = entry.name.startsWith("Scholar·");
                          const isReviewer = entry.name.startsWith("Review·");
                          const isEditor   = entry.name === "Editor";
                          const isRef      = entry.name === "References";
                          const isFinalQA  = entry.name === "FinalReview·QA";
                          const nameColor  =
                            isWriter   ? "text-blue-300"   :
                            isReviewer ? "text-amber-300"  :
                            isEditor   ? "text-emerald-300":
                            isRef      ? "text-cyan-300"   :
                            isFinalQA  ? "text-amber-200"  :
                            "text-violet-300";
                          const iconColor  =
                            entry.done     ? "text-emerald-400" :
                            entry.error    ? "text-red-400"     :
                            entry.revision ? "text-amber-400"   :
                            "text-violet-400";
                          // Status glyphs replaced with lucide icons so the
                          // agent log matches the rest of the iconography
                          // (lucide everywhere) instead of mixing emoji /
                          // arrow chars that render inconsistently across
                          // platforms (especially on Windows zh-CN where the
                          // bare ▶ rendered as a tofu box).
                          const icon =
                            entry.done     ? <Check size={13} /> :
                            entry.error    ? <X size={13} /> :
                            entry.revision ? (entry.msg.startsWith("↩") ? <CornerDownLeft size={13} /> : <RotateCcw size={13} />) :
                            <Play size={13} className="animate-pulse" />;
                          return (
                            <div key={entry.name} className="flex items-start gap-2 py-0.5">
                              <span className={`shrink-0 mt-0.5 ${iconColor}`}>{icon}</span>
                              <div className="min-w-0">
                                <span className={`text-sm font-semibold ${nameColor}`}>{entry.name}</span>
                                <span className="text-sm text-slate-500 ml-1.5 break-words">
                                  {entry.msg.replace(/^[✓✗▶↩↺]\s*/, "")}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      </div>
                      )}
                    </div>
                  )}

                  {/* Error */}
                  {labError && (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 break-words">{labError}</div>
                  )}

                  {/* Result */}
                  {displayedLabResult && (() => {
                    // Shared resolvers — used by every filename + PDF title in this block.
                    const OUTPUT_LABELS_SLUG: Record<string,string> = {
                      literature_review:     "Literature_Review",
                      theoretical_framework: "Theoretical_Framework",
                      research_proposal:     "Research_Proposal",
                      discussion:            "Discussion",
                      introduction:          "Introduction",
                      conclusion:            "Conclusion",
                      abstract:              "Abstract",
                      argumentative_essay:   "Academic_Essay",
                    };
                    const OUTPUT_LABELS_TITLE: Record<string,string> = {
                      literature_review:     "Literature Review",
                      theoretical_framework: "Theoretical Framework",
                      research_proposal:     "Research Proposal",
                      discussion:            "Discussion",
                      introduction:          "Introduction",
                      conclusion:            "Conclusion",
                      abstract:              "Abstract",
                      argumentative_essay:   "Academic Essay",
                    };
                    const outputSlug  = OUTPUT_LABELS_SLUG[labOutputType] ?? "Output";
                    const outputTitle = OUTPUT_LABELS_TITLE[labOutputType] ?? "Lab Output";
                    const argSlug = (labCoreArg || "synthesis").replace(/\s+/g, "_").replace(/[^\w_]/g, "").slice(0, 40);
                    const filename = `${outputSlug}_${argSlug}`;
                    return (
                    <div>
                      <div className="flex flex-nowrap items-center gap-2 mb-2 overflow-hidden">
                        <span className="shrink min-w-0 truncate text-sm font-semibold text-slate-200">Generated Text</span>
                        <div className="ml-auto flex flex-nowrap items-center gap-1.5 min-w-0">
                          {/* Quick copy — stays in the header because it's
                              instantaneous and most users want it close to
                              the title. Download / Translate are consolidated
                              in the footer block below the article body. */}
                          <button
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(displayedLabResult);
                                setLabCopied(true);
                                window.setTimeout(() => setLabCopied(false), 1500);
                              } catch { /* clipboard may be blocked — silently fail */ }
                            }}
                            className={`shrink min-w-0 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors ${labCopied ? "border-emerald-500/50 text-emerald-400" : "border-slate-700 text-slate-500 hover:text-blue-400 hover:border-blue-500/50"}`}
                          >
                            {labCopied ? <><Check size={11} strokeWidth={3} className="shrink-0" /><span className="truncate">Copied</span></> : <><ClipboardList size={11} className="shrink-0" /><span className="truncate">Copy</span></>}
                          </button>
                        </div>
                      </div>
                      <div translate="no" className="notranslate rounded-xl border border-slate-700/60 bg-slate-900/30 px-4 py-3 text-sm text-slate-200 leading-7 whitespace-pre-wrap break-words">
                        {displayedLabResult}
                        {labGenerating && !labViewingId && <span className="inline-block ml-0.5 h-4 w-0.5 rounded-sm bg-violet-400 animate-pulse align-text-bottom" />}
                      </div>

                      {/* ── Consolidated download footer ─────────────────────
                          All download controls live below the article text so
                          the reading flow is: title → article → actions. Two
                          rows: (1) download the original, (2) download a
                          translation. Each row has its own format picker and
                          a single button that flips to "Cancel" while the
                          request is in flight, so the user can pause a slow
                          PDF render without hunting for a separate stop. */}
                      {!labGenerating && (
                        <div className="mt-3 rounded-xl border border-slate-700/60 bg-slate-900/40 p-3 space-y-2.5 text-xs">
                          <div className="flex items-center gap-2 text-slate-300 text-[11px] font-bold uppercase tracking-wide">
                            <Download size={12} />
                            <span>Download</span>
                          </div>

                          {/* Row 1: original article */}
                          <div className="flex flex-nowrap items-center gap-1.5 overflow-hidden">
                            <span className="shrink min-w-0 truncate text-slate-500">Article format:</span>
                            <select
                              value={labDownloadFormat}
                              onChange={e => setLabDownloadFormat(e.target.value as "pdf"|"html"|"txt"|"md")}
                              disabled={labDownloading}
                              className="shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-emerald-500/60 disabled:opacity-60"
                            >
                              <option value="pdf">PDF</option>
                              <option value="html">HTML</option>
                              <option value="md">Markdown</option>
                              <option value="txt">TXT</option>
                            </select>
                            <button
                              onClick={async () => {
                                // Second click cancels an in-flight download.
                                if (labDownloading) {
                                  labDownloadAbortRef.current?.abort();
                                  labDownloadAbortRef.current = null;
                                  setLabDownloading(false);
                                  return;
                                }
                                if (labDownloadFormat === "pdf") {
                                  const ac = new AbortController();
                                  labDownloadAbortRef.current = ac;
                                  setLabDownloading(true);
                                  try {
                                    await triggerDownload(
                                      buildApiUrl("/api/text/to-pdf"),
                                      { text: displayedLabResult, title: outputSlug.replace(/_/g, " ") },
                                      `${filename}.pdf`,
                                      "lab-download-pdf",
                                      ac.signal,
                                    );
                                  } finally {
                                    setLabDownloading(false);
                                    labDownloadAbortRef.current = null;
                                  }
                                } else {
                                  // Text formats are synchronous client-side — no
                                  // pause needed because there's nothing to wait on.
                                  downloadTextAs(displayedLabResult, filename, labDownloadFormat as "html"|"txt"|"md");
                                }
                              }}
                              className={`ml-auto shrink min-w-0 inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${labDownloading ? "border-red-500/40 bg-red-500/10 text-red-300 animate-pulse" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/60"}`}
                            >
                              {labDownloading
                                ? <><Square size={11} fill="currentColor" className="shrink-0" /><span className="truncate">Pause</span></>
                                : <><Download size={11} className="shrink-0" /><span className="truncate">Download article</span></>}
                            </button>
                          </div>

                          {/* Row 2: translated article */}
                          <div className="flex flex-nowrap items-center gap-1.5 overflow-hidden">
                            <span className="shrink min-w-0 truncate text-slate-500">Translate to:</span>
                            <select
                              value={labTranslateLang}
                              onChange={e => setLabTranslateLang(e.target.value)}
                              disabled={labTranslating}
                              className="shrink min-w-0 max-w-[10rem] rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-emerald-500/60 truncate disabled:opacity-60"
                            >
                              {["Chinese (Simplified)", "Chinese (Traditional)", "English", "Japanese", "Korean", "Spanish", "French", "German", "Indonesian", "Arabic"].map(l => (
                                <option key={l} value={l}>{l}</option>
                              ))}
                            </select>
                            <select
                              value={labTranslateFormat}
                              onChange={e => setLabTranslateFormat(e.target.value as "pdf"|"md"|"txt")}
                              disabled={labTranslating}
                              className="shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-emerald-500/60 disabled:opacity-60"
                            >
                              <option value="pdf">PDF</option>
                              <option value="md">Markdown</option>
                              <option value="txt">TXT</option>
                            </select>
                            <button
                              onClick={async () => {
                                // Second click cancels the in-flight translate.
                                if (labTranslating) {
                                  labTranslateAbortRef.current?.abort();
                                  labTranslateAbortRef.current = null;
                                  setLabTranslating(false);
                                  return;
                                }
                                const controller = new AbortController();
                                labTranslateAbortRef.current = controller;
                                try {
                                  setLabTranslating(true);
                                  const res = await fetchWithApiFallback("/api/text/translate-export", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ text: displayedLabResult, target_language: labTranslateLang, title: outputTitle, file_format: labTranslateFormat }),
                                    signal: controller.signal,
                                  }, true);
                                  if (!res.ok) throw new Error(`Translate failed: ${res.status}`);
                                  const blob = await res.blob();
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement("a");
                                  a.href = url;
                                  a.download = `${outputTitle.replace(/\s+/g, "_")}_${labTranslateLang.replace(/[()\s]/g, "")}.${labTranslateFormat}`;
                                  a.click();
                                  URL.revokeObjectURL(url);
                                } catch (err) {
                                  if ((err as { name?: string })?.name !== "AbortError") {
                                    console.warn("[translate-export] failed:", err);
                                  }
                                } finally {
                                  setLabTranslating(false);
                                  labTranslateAbortRef.current = null;
                                }
                              }}
                              className={`ml-auto shrink min-w-0 inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${labTranslating ? "border-red-500/40 bg-red-500/10 text-red-300 animate-pulse" : "border-blue-500/40 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:border-blue-500/60"}`}
                            >
                              {labTranslating
                                ? <><Square size={11} fill="currentColor" className="shrink-0" /><span className="truncate">Pause</span></>
                                : <><Globe size={11} className="shrink-0" /><span className="truncate">Download translation</span></>}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    );
                  })()}

                  {/* Reviewer Notes — collapsible improvement feedback.
                      Reads from displayedLabReviewerNotes via a local alias
                      so past-run tabs also surface their own notes; the
                      existing sub-expressions below stay identical. */}
                  {displayedLabReviewerNotes && (() => {
                    const labReviewerNotes = displayedLabReviewerNotes;
                    return (
                    <div className="rounded-xl border border-amber-500/25 bg-amber-500/5">
                      <button
                        onClick={() => setLabNotesOpen(o => !o)}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-bold text-amber-400 hover:text-amber-300 transition-colors"
                      >
                        <span>{labNotesOpen ? "▾" : "▸"}</span>
                        <Lightbulb size={12} />
                        <span>Reviewer Improvement Notes</span>
                        {!labNotesOpen && <span className="text-slate-500 font-normal">(click to expand)</span>}
                      </button>
                      {labNotesOpen && (
                        <div className="px-3 pb-3 space-y-2.5">
                          {/* Input-completeness block — surfaces which fields from the Lab spec were
                              left blank (deterministic audit from the backend) plus any LLM-written
                              suggestions on how fuller input would have improved the draft. */}
                          {((labReviewerNotes.completeness?.missing?.length ?? 0) > 0 ||
                            (labReviewerNotes.completeness?.thin?.length ?? 0) > 0 ||
                            (labReviewerNotes.missing_inputs?.length ?? 0) > 0) && (
                            <div>
                              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1"><Lightbulb size={10} />Missing / Improvable Input</div>
                              <ul className="space-y-1">
                                {(labReviewerNotes.completeness?.missing ?? []).map((m, i) => (
                                  <li key={`m-${i}`} className="text-xs text-slate-400 flex gap-1.5">
                                    <span className="text-rose-400/80 shrink-0">✕</span>
                                    <span><span className="text-rose-300">Not provided:</span> {m}</span>
                                  </li>
                                ))}
                                {(labReviewerNotes.completeness?.thin ?? []).map((t, i) => (
                                  <li key={`t-${i}`} className="text-xs text-slate-400 flex gap-1.5">
                                    <span className="text-amber-400/80 shrink-0">~</span>
                                    <span>{t}</span>
                                  </li>
                                ))}
                                {(labReviewerNotes.missing_inputs ?? []).map((m, i) => (
                                  <li key={`ai-${i}`} className="text-xs text-slate-400 flex gap-1.5">
                                    <span className="text-amber-500 shrink-0">·</span>{m}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {(labReviewerNotes.citation_gaps?.length ?? 0) > 0 && (
                            <div>
                              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1"><Pin size={10} />Citation Gaps</div>
                              <ul className="space-y-1">
                                {(labReviewerNotes.citation_gaps ?? []).map((note, i) => (
                                  <li key={i} className="text-xs text-slate-400 flex gap-1.5"><span className="text-amber-500 shrink-0">·</span>{note}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {(labReviewerNotes.data_suggestions?.length ?? 0) > 0 && (
                            <div>
                              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1"><BarChartIcon size={10} />Data &amp; Evidence</div>
                              <ul className="space-y-1">
                                {(labReviewerNotes.data_suggestions ?? []).map((note, i) => (
                                  <li key={i} className="text-xs text-slate-400 flex gap-1.5"><span className="text-amber-500 shrink-0">·</span>{note}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {(labReviewerNotes.argument_suggestions?.length ?? 0) > 0 && (
                            <div>
                              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1"><Target size={10} />Core Argument</div>
                              <ul className="space-y-1">
                                {(labReviewerNotes.argument_suggestions ?? []).map((note, i) => (
                                  <li key={i} className="text-xs text-slate-400 flex gap-1.5"><span className="text-amber-500 shrink-0">·</span>{note}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {(labReviewerNotes.supporting_points?.length ?? 0) > 0 && (
                            <div>
                              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1"><Plus size={10} />Suggested Supporting Points</div>
                              <ul className="space-y-1">
                                {(labReviewerNotes.supporting_points ?? []).map((note, i) => (
                                  <li key={i} className="text-xs text-slate-400 flex gap-1.5"><span className="text-amber-500 shrink-0">·</span>{note}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {/* Paper-usage report — tells the user which of their selected references
                              actually made it into the draft, which were read but skipped (and why),
                              and which couldn't be read (so they know why a paper may have been ignored). */}
                          {labReviewerNotes.paper_usage && (labReviewerNotes.paper_usage.total ?? 0) > 0 && (
                            <div className="pt-1 border-t border-amber-500/15">
                              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1"><BookOpen size={10} />Paper usage</div>
                              <ul className="space-y-1">
                                {(labReviewerNotes.paper_usage.used ?? []).map(u => (
                                  <li key={`u-${u.index}`} className="text-xs text-slate-400 flex gap-1.5">
                                    <span className="text-emerald-400 shrink-0 tabular-nums">[{u.index}]</span>
                                    <span><span className="text-emerald-300">Used —</span> {u.note || "cited in the draft"}</span>
                                  </li>
                                ))}
                                {(labReviewerNotes.paper_usage.unused ?? []).map(u => (
                                  <li key={`x-${u.index}`} className="text-xs text-slate-400 flex gap-1.5">
                                    <span className="text-slate-500 shrink-0 tabular-nums">[{u.index}]</span>
                                    <span><span className="text-slate-300">Not used —</span> {u.reason || "reviewer judged it off-topic for this brief"}</span>
                                  </li>
                                ))}
                                {(labReviewerNotes.paper_usage.unreadable ?? []).map(u => (
                                  <li key={`q-${u.index}`} className="text-xs text-slate-400 flex gap-1.5">
                                    <span className="text-rose-400 shrink-0 tabular-nums">[{u.index}]</span>
                                    <span>
                                      <span className="text-rose-300">Unreadable —</span> {u.reason || "abstract/body was missing"}
                                      {" "}
                                      <span className="text-slate-600">(tip: upload the PDF under Files to give the writer full text)</span>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    );
                  })()}

                </div>
                )}
              </div>
              )}
            </aside>
          </div>
          </ErrorBoundary>
        </div>
      </div>

      {/* ── Feedback icon bubble + modal — fixed bottom-right ────────────── */}
      {!!authUser && (
        <>
          <button
            onClick={() => { setFeedbackOpen(true); setFeedbackMsg(null); }}
            className="group fixed right-4 z-50 flex items-center justify-center rounded-full border shadow-lg backdrop-blur-sm transition-all duration-200 hover:brightness-110 hover:scale-110 h-11 w-11"
            style={{
              bottom:          historyPanelOpen ? historyPanelHeight + 12 : 16,
              borderColor:     "var(--ats-border-accent)",
              backgroundColor: "var(--ats-bg-accent-soft)",
              color:           "var(--ats-fg-accent)",
            }}
            aria-label="Send feedback"
          >
            {/* Lucide MessageCircle — matches the line-drawing style of
                every other icon in the app (Search, Brain, Trash2, etc).
                Previously an emoji bug 🐛 which looked foreign next to
                the rest of the UI. */}
            <MessageCircle size={18} aria-hidden />
            {/* Hover tooltip — appears to the left so it never clips off-screen. */}
            <span
              className="pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-150"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-panel)",
                color:           "var(--ats-fg-primary)",
              }}
            >
              Report a bug / feedback
            </span>
          </button>

          {feedbackOpen && (
            <div
              className="fixed inset-0 z-[70] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm"
              onClick={() => { setFeedbackOpen(false); setAutoPromptedFeedback(false); }}
            >
              <div
                className={`w-full max-w-lg rounded-2xl border shadow-2xl ${autoPromptedFeedback ? "ring-4 ring-offset-2" : ""}`}
                style={{
                  borderColor:     autoPromptedFeedback ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                  backgroundColor: "var(--ats-bg-panel)",
                  ...({
                    "--tw-ring-color":        autoPromptedFeedback ? "var(--ats-border-accent)" : "transparent",
                    "--tw-ring-offset-color": "var(--ats-bg-panel)",
                  } as Record<string, string>),
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header — merges title + close. When auto-opened after N uses
                    it shows a bold ask; otherwise a plain "Send feedback". */}
                <div className="flex items-start gap-3 px-6 pt-5 pb-4">
                  <div className="flex-1 min-w-0">
                    {autoPromptedFeedback ? (
                      <>
                        <h2 className="text-xl font-bold leading-tight" style={{ color: "var(--ats-fg-accent)" }}>
                          We really need your feedback
                        </h2>
                        <p className="mt-1 text-sm font-medium" style={{ color: "var(--ats-fg-primary)" }}>
                          This <span className="font-bold" style={{ color: "var(--ats-fg-accent)" }}>really matters to us</span> — your input directly shapes what we ship next. We read every single note.
                        </p>
                      </>
                    ) : (
                      <>
                        <h2 className="text-lg font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
                          Send feedback
                        </h2>
                        <p className="mt-1 text-xs" style={{ color: "var(--ats-fg-secondary)" }}>
                          We need your feedback — it matters to us. Every note gets read.
                        </p>
                      </>
                    )}
                  </div>
                  <button
                    onClick={() => { setFeedbackOpen(false); setAutoPromptedFeedback(false); }}
                    className="transition-colors p-1 rounded hover:bg-black/5 shrink-0"
                    aria-label="Close"
                    style={{ color: "var(--ats-fg-muted)" }}
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="px-6 pb-5 space-y-3">
                  <div className="flex gap-2">
                    {(["bug", "feature", "general"] as const).map(c => {
                      const active = feedbackCategory === c;
                      return (
                        <button
                          key={c}
                          onClick={() => setFeedbackCategory(c)}
                          className="flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors"
                          style={{
                            borderColor:     active ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                            backgroundColor: active ? "var(--ats-bg-accent-soft)" : "transparent",
                            color:           active ? "var(--ats-fg-accent)"      : "var(--ats-fg-secondary)",
                          }}
                        >
                          {c === "bug" ? "Bug" : c === "feature" ? "Feature" : "General"}
                        </button>
                      );
                    })}
                  </div>
                  <textarea
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    rows={6}
                    maxLength={4000}
                    autoFocus
                    placeholder={
                      feedbackCategory === "bug"
                        ? "What happened? What did you expect?"
                        : feedbackCategory === "feature"
                          ? "What would you like AcademiCats to do?"
                          : "Share anything — ideas, confusions, compliments."
                    }
                    className="w-full rounded-lg border p-3 text-sm outline-none resize-y"
                    style={{
                      borderColor:     "var(--ats-border-subtle)",
                      backgroundColor: "var(--ats-bg-base)",
                      color:           "var(--ats-fg-primary)",
                    }}
                  />
                  {feedbackMsg && (
                    <p
                      className="text-sm rounded-lg px-3 py-2 border"
                      style={{
                        borderColor:     feedbackMsg.error ? "#ef444455" : "#10b98155",
                        backgroundColor: feedbackMsg.error ? "#ef44441a" : "#10b9811a",
                        color:           feedbackMsg.error ? "#ef4444"   : "#10b981",
                      }}
                    >
                      {feedbackMsg.text}
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <span className="text-xs tabular-nums" style={{ color: "var(--ats-fg-muted)" }}>
                      {feedbackText.length} / 4000
                    </span>
                    <button
                      onClick={() => void submitFeedback()}
                      disabled={feedbackSending || feedbackText.trim().length < 3}
                      className="rounded-lg border px-5 py-2 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{
                        borderColor:     "var(--ats-border-accent)",
                        backgroundColor: "var(--ats-bg-accent-soft)",
                        color:           "var(--ats-fg-accent)",
                      }}
                    >
                      {feedbackSending ? "Sending…" : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Dev-to-user popup notifications (tier bumps, quota grants, notes).
              Renders only when the hook has at least one pending item; the
              component auto-dismisses on backdrop / ESC / "Got it" and acks
              the row server-side. Positioned at the end of the authed block
              so it stacks cleanly above everything else except the auth widget. */}
          <UserNotificationPopup queue={userNotifications.queue} ack={userNotifications.ack} />
        </>
      )}

      {/* ── Auth widget — fixed bottom-left ───────────────────────────────── */}
      {!authLoading && (
        <div ref={authWidgetRef} className="fixed left-4 z-50 transition-[bottom] duration-200" style={{ bottom: historyPanelOpen ? historyPanelHeight + 12 : 16 }}>
          {authUser ? (
            <div className="relative">
              {/* User menu popup */}
              {userMenuOpen && (
                <>
                  {/* Backdrop */}
                  <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                  <div className="absolute bottom-12 left-0 z-50 w-64 rounded-2xl border border-slate-700/60 bg-slate-900/95 shadow-2xl backdrop-blur-md overflow-hidden">
                    {/* User info header */}
                    <div className="px-4 py-3 border-b border-slate-700/50">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
                          {(authUser.email?.[0] ?? "U").toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-200 truncate">{authUser.email}</p>
                          <p className="text-[10px] text-blue-400 mt-0.5 capitalize">
                            {usage.data?.tier ? `${usage.data.tier} · Alpha` : "Alpha Member"}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Usage — its own dedicated button at the top of the menu,
                        separated from the profile/settings/... list below.
                        Shows a compact remaining-minimum summary on the right
                        so the user sees immediately whether quota is tight;
                        full breakdown lives in the Usage modal. */}
                    {usage.data && (() => {
                      const rows = (Object.keys(USAGE_FEATURE_LABELS) as Array<keyof UsageSnapshot["limits"]>)
                        .map((feature) => {
                          const limit = usage.data!.limits[feature] ?? null;
                          const used  = (usage.data!.used as any)[`${feature}_count`] ?? 0;
                          const remaining = limit === null ? Number.POSITIVE_INFINITY : Math.max(0, limit - used);
                          return { feature, limit, used, remaining };
                        });
                      const bounded = rows.filter(r => r.limit !== null);
                      const tightest = bounded.length === 0 ? null : bounded.reduce((m, r) => r.remaining < m.remaining ? r : m);
                      const empty = tightest?.remaining === 0;
                      return (
                        <button
                          onClick={() => { setUserPanel("usage"); setUserMenuOpen(false); }}
                          className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 border-y transition-colors text-left ${
                            empty
                              ? "border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/15 text-rose-300"
                              : "border-slate-700/50 hover:bg-slate-800/60 text-slate-200"
                          }`}
                          aria-label="Open usage dashboard"
                        >
                          <span className="flex items-center gap-2 text-sm font-semibold">
                            <BarChart2 size={14} className={empty ? "text-amber-400" : "text-blue-400"} />
                            Usage
                            {empty && <span className="text-[10px] font-bold uppercase tracking-wide text-amber-400">Refreshes at 00:00 UTC</span>}
                          </span>
                          <span className={`text-[11px] tabular-nums ${empty ? "text-amber-300" : "text-slate-400"}`}>
                            {tightest
                              ? (tightest.limit === null
                                  ? "Unlimited"
                                  : `${tightest.remaining} / ${tightest.limit} ${USAGE_FEATURE_LABELS[tightest.feature].toLowerCase()} left today`)
                              : "Unlimited · all features"}
                          </span>
                        </button>
                      );
                    })()}

                    {/* Menu items. Developer accounts (userRole === "dev"
                        / email in DEV_ACCTS) get an extra "Developer" entry
                        routing to the dev control panel — hidden entirely
                        for regular users so the menu stays clean. */}
                    <div className="py-1.5">
                      {([
                        { key: "profile",      label: "Profile",      icon: <User size={14} /> },
                        { key: "accounts",     label: "Accounts",     icon: <Users size={14} /> },
                        { key: "settings",     label: "Settings",     icon: <Settings size={14} /> },
                        { key: "subscription", label: "Subscription", icon: <CreditCard size={14} /> },
                        { key: "legal",        label: "Terms & Notices", icon: <FileText size={14} /> },
                        { key: "help",         label: "Help",         icon: <HelpCircle size={14} /> },
                        ...(isDeveloper ? [{ key: "dev" as const, label: "Developer", icon: <Sparkles size={14} /> }] : []),
                      ] as const).map(({ key, label, icon }) => (
                        <button
                          key={key}
                          onClick={() => { setUserPanel(key); setUserMenuOpen(false); }}
                          className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors text-left ${
                            key === "dev"
                              ? "text-amber-300 hover:bg-amber-500/10 hover:text-amber-200 border-t border-slate-700/50"
                              : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
                          }`}
                        >
                          <span className={key === "dev" ? "text-amber-400" : "text-slate-500"}>{icon}</span>
                          {label}
                        </button>
                      ))}
                    </div>

                    {/* Add account — inline below Help */}
                    <div className="border-t border-slate-700/50 px-4 py-2.5 space-y-2">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide">Add account</p>
                      {/* Saved accounts quick-switch */}
                      {savedAccounts.length > 0 && (
                        <div className="space-y-1">
                          {savedAccounts.map(acct => {
                            const isCurrent = acct.email === authUser?.email;
                            const isLoading = acctSwitching === acct.email;
                            return (
                              <div key={acct.email} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${isCurrent ? "bg-blue-500/10" : "bg-slate-800/40"}`}>
                                <div className="h-5 w-5 rounded-full bg-slate-700 flex items-center justify-center text-[9px] font-bold text-slate-300 shrink-0">
                                  {acct.email[0].toUpperCase()}
                                </div>
                                <p className="flex-1 text-[11px] text-slate-300 truncate">{acct.email}</p>
                                {isCurrent
                                  ? <span className="text-[9px] text-blue-400 shrink-0">Active</span>
                                  : <button onClick={() => switchToAccount(acct)} disabled={acctSwitching !== null} className="text-[10px] text-blue-400 hover:text-blue-300 disabled:opacity-50 shrink-0">{isLoading ? "…" : "Switch"}</button>
                                }
                                <button onClick={() => removeSavedAccount(acct.email)} className="text-[9px] text-slate-600 hover:text-red-400 shrink-0 ml-0.5">✕</button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Status message */}
                      {acctSwitchMsg && (
                        <p className={`text-[10px] rounded px-2 py-1 ${acctSwitchMsg.error ? "text-red-400 bg-red-500/10" : "text-emerald-400 bg-emerald-500/10"}`}>
                          {acctSwitchMsg.text}
                        </p>
                      )}
                      {/* Google login */}
                      <button
                        onClick={handleGoogleLogin}
                        className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 hover:bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-200 transition-colors"
                      >
                        <svg width="12" height="12" viewBox="0 0 48 48" fill="none"><path d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 20-9 20-20 0-1.2-.1-2.4-.4-3.5z" fill="#FFC107"/><path d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" fill="#FF3D00"/><path d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.6 34.9 26.9 36 24 36c-5.3 0-9.7-3.4-11.3-8H6.1C9.4 35.6 16.2 44 24 44z" fill="#4CAF50"/><path d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.5 5.5C41.7 36.2 44 30.5 44 24c0-1.2-.1-2.4-.4-3.5z" fill="#1976D2"/></svg>
                        Continue with Google
                      </button>
                      {/* Input + Add (coming soon) */}
                      <div className="flex gap-1.5 opacity-40 cursor-not-allowed">
                        <input
                          type="email"
                          disabled
                          placeholder="email@example.com"
                          className="flex-1 min-w-0 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[11px] text-slate-500 placeholder-slate-700 cursor-not-allowed"
                        />
                        <button
                          disabled
                          className="rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] text-slate-600 cursor-not-allowed shrink-0"
                        >Add</button>
                      </div>
                      <p className="text-[9px] text-slate-600">Email login coming soon · use Google to sign in</p>
                    </div>

                    {/* Sign out */}
                    <div className="border-t border-slate-700/50 py-1.5">
                      <button
                        onClick={async () => {
                          // 1) Close the popup so it doesn't flash on the
                          //    now-logged-out overlay.
                          setUserMenuOpen(false);
                          // 2) AWAIT signOut so Supabase's localStorage
                          //    slot is actually cleared before anything
                          //    else runs. Previous bug: fire-and-forget
                          //    signOut + sync setAuthUser(null) triggered
                          //    the reload-on-auth-change effect BEFORE
                          //    signOut finished. After reload getSession
                          //    still saw the old token → user appeared
                          //    logged back in.
                          try { await supabase.auth.signOut(); } catch {
                            /* offline sign-outs still clear local storage */
                          }
                          // 3) onAuthStateChange fires with session=null
                          //    → setAuthUser(null) runs there → the
                          //    prevAuthEmailRef effect reloads the page
                          //    automatically. No need to reload / setAuthUser
                          //    manually here (doing so re-introduces the
                          //    race condition we just fixed).
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors text-left"
                      >
                        <span className="text-base w-5 text-center">→</span>
                        Sign out
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* Avatar button + History button. Compact sizing matches the
                  original spec — text-xs, avatar 6x6 — so the widget sits
                  quietly in the bottom-left without competing with the
                  main workspace controls. */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setUserMenuOpen(o => !o)}
                  aria-label="Open user menu"
                  className="flex items-center gap-2 rounded-full border border-slate-700/60 bg-slate-900/90 pl-1 pr-3 py-1 shadow-lg backdrop-blur-sm hover:border-blue-500/40 transition-all"
                >
                  <div className="h-6 w-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold">
                    {(authUser.email?.[0] ?? "U").toUpperCase()}
                  </div>
                  <span className="max-w-[140px] truncate text-xs text-slate-400">{authUser.email}</span>
                </button>
                <button
                  onClick={() => {
                    const next = !historyPanelOpen;
                    setHistoryPanelOpen(next);
                    if (next) {
                      // Load from localStorage immediately (works for all users)
                      try {
                        const _k = authUser?.email ? _hKey(authUser.email) : null;
                        const local: typeof historyList = JSON.parse((_k && localStorage.getItem(_k)) || "[]");
                        setHistoryList(local);
                      } catch { setHistoryList([]); }
                      setHistoryLoading(false);
                    }
                  }}
                  className={`rounded-full border px-3 py-1 text-xs shadow-lg backdrop-blur-sm transition-all ${
                    historyPanelOpen
                      ? "border-blue-500/60 bg-blue-500/10 text-blue-400"
                      : "border-slate-700/60 bg-slate-900/90 text-slate-400 hover:border-blue-500/40 hover:text-blue-400"
                  }`}
                >
                  History
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => router.push("/login")}
              className="rounded-full border border-slate-700/60 bg-slate-900/90 px-4 py-1.5 text-xs font-medium text-slate-400 shadow-lg backdrop-blur-sm hover:border-blue-500/50 hover:text-blue-400 transition-all"
            >
              Sign in
            </button>
          )}
        </div>
      )}

      {/* ── History slide-up panel ───────────────────────────────────────────── */}
      {historyPanelOpen && (
        <div
          ref={historyPanelRef}
          className="fixed bottom-0 left-0 right-0 z-40 rounded-t-2xl border-t border-slate-700/60 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col"
          style={{ height: historyPanelHeight }}
        >
          {/* Drag strip — invisible h-0 touch target at top, nub sits over border */}
          <div
            className="absolute top-0 left-0 right-0 h-3 cursor-ns-resize select-none z-10 flex items-center justify-center"
            onMouseDown={e => {
              e.preventDefault();
              historyDragRef.current = { startY: e.clientY, startH: historyPanelHeight };
              const onMove = (ev: MouseEvent) => {
                if (!historyDragRef.current) return;
                const delta = historyDragRef.current.startY - ev.clientY;
                // `ev.clientY` is in zoomed coords; normalise innerHeight to
                // the same space so the 85 % cap matches what the user sees.
                const next = Math.max(120, Math.min(getVisualVH() * 0.85, historyDragRef.current.startH + delta));
                setHistoryPanelHeight(next);
              };
              const onUp = () => {
                historyDragRef.current = null;
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          >
            <div className="w-8 h-0.5 rounded-full bg-slate-700/80 mt-1" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-3 pb-1.5 shrink-0">
            <div className="flex items-center gap-3">
              {/* Title + count badge */}
              <span className="relative text-sm font-semibold text-slate-200 pr-3">
                Search History
                {historyList.length > 0 && (
                  <span className="absolute -top-1.5 right-0 min-w-[14px] text-center text-[8px] font-normal leading-tight bg-slate-700 text-slate-300 rounded-full px-0.5">
                    {historyList.length}
                  </span>
                )}
              </span>
              {historyList.length > 0 && (
                <button onClick={clearAllHistory} className="text-[10px] text-slate-600 hover:text-red-400 transition-colors leading-none">Clear all</button>
              )}
            </div>
            <button onClick={() => setHistoryPanelOpen(false)} className="text-slate-600 hover:text-slate-300 transition-colors text-base leading-none">✕</button>
          </div>

          {/* Timeline body — horizontal scroll, no vertical scroll */}
          <div
            ref={timelineScrollRef}
            className="flex-1 overflow-x-auto overflow-y-hidden thin-scrollbar-x"
            onWheel={e => {
              if (!timelineScrollRef.current) return;
              e.preventDefault();
              timelineScrollRef.current.scrollLeft += e.deltaY + e.deltaX;
            }}
          >
            {/* Inner column: nodes row + clear-all row (both scroll together; clear-all is sticky-left) */}
            <div className="flex flex-col min-w-max px-4 pt-2 pb-1">
              {!historyLoading && historyList.length === 0 && (
                <p className="text-xs text-slate-500 py-2">No history yet. Run a search to get started.</p>
              )}
              {!historyLoading && historyList.length > 0 && (
                <div className="relative flex items-start">
                  {/* Continuous timeline line behind all nodes */}
                  <div className="absolute top-[19px] left-[5px] right-[5px] h-px bg-slate-700/50 pointer-events-none" />
                  {historyList.map((item, i) => {
                    const next = historyList[i + 1];
                    const sameGroup = next && next.title === item.title;
                    const isFav = favoritedIds.has(item.id);
                    const d = new Date(item.updated_at);
                    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                    const dateStr = d.toLocaleDateString([], { year: "2-digit", month: "2-digit", day: "2-digit" });
                    // Dot color: blue = newest (i===0), green = quick search, amber = curated (deep) search
                    const dotCls = i === 0
                      ? "border-blue-500 bg-blue-500/40"
                      : item.entryType === "understand"
                        ? "border-slate-500 bg-slate-500/20"
                        : item.isFast
                          ? "border-emerald-500 bg-emerald-500/20"
                          : "border-amber-500 bg-amber-500/20";
                    return (
                      <div
                        key={item.id}
                        className={`relative flex flex-col items-center z-10 group ${i < historyList.length - 1 ? (sameGroup ? "mr-3" : "mr-10") : ""}`}
                      >
                        {/* Active highlight */}
                        {activeHistoryId === item.id && (
                          <div className="absolute inset-x-0 -top-0.5 bottom-0 rounded-lg bg-blue-500/10 ring-1 ring-blue-500/20 pointer-events-none" />
                        )}
                        {/* Delete button */}
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteHistoryEntry(item.id); }}
                          className="absolute -top-1 -right-1 hidden group-hover:flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-700 hover:bg-red-600 text-slate-400 hover:text-white text-[9px] leading-none transition-colors z-20"
                          title="Delete"
                        >✕</button>
                        {/* Star — above dot */}
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(item.id); }}
                          className={`text-[10px] leading-none mb-0.5 transition-colors ${isFav ? "text-amber-400" : "text-slate-700 hover:text-amber-400"}`}
                          title={isFav ? "Unfavourite" : "Favourite"}
                        >{isFav ? "★" : "☆"}</button>
                        {/* Restore button */}
                        <button
                          onClick={() => restoreHistory(item)}
                          className="relative flex flex-col items-center gap-1 px-1.5 pt-0 pb-0.5 focus:outline-none"
                          title={item.title}
                        >
                          {/* Dot — ring masks the line behind it */}
                          <div className={`h-2.5 w-2.5 rounded-full border-2 ring-[3px] ring-slate-950 transition-colors group-hover:border-blue-400 group-hover:bg-blue-400/30 ${dotCls}`} />
                          <p className="max-w-[100px] text-[11px] text-slate-300 group-hover:text-blue-300 transition-colors leading-snug line-clamp-2 text-center mt-0.5">{item.title}</p>
                          <p className="text-[9px] text-slate-600 whitespace-nowrap leading-[1.1]">{timeStr}</p>
                          <p className="text-[9px] text-slate-700 whitespace-nowrap leading-[1.1]">{dateStr}</p>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── User panel modals ───────────────────────────────────────────────────
          z-[100] so this sits ABOVE the sign-in gate (z-[80]). Previously this
          modal was z-[60], which meant a user clicking "Terms & Notices" from
          the sign-in card opened the Terms modal BEHIND the card — completely
          hidden. Signed-in users never noticed because the sign-in gate isn't
          rendered for them, but anonymous visitors couldn't read the terms
          before accepting. Placing user-panel modals above the sign-in gate
          costs nothing while fixing the visibility bug. */}
      {userPanel && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/30 backdrop-blur-sm" onClick={() => setUserPanel(null)}>
          <div
            // translate="yes" explicitly opts the dialog copy in to Google
            // Translate so every label/paragraph inside profile/settings/
            // subscription/help/accounts/legal can be translated. Volatile
            // streaming regions still opt out individually via translate="no".
            translate="yes"
            className={`w-full rounded-2xl border border-slate-700/60 bg-slate-900 shadow-2xl ${
              // Dev panel hosts a 3-column grid (warning + editor + cleanup),
              // so it needs the widest modal size — anything narrower squashes
              // the system-announcement editor. Subscription / Legal / Usage /
              // Settings all benefit from extra horizontal room — Settings
              // specifically lays its theme picker + opacity sliders side-by-
              // side. Everything else fits comfortably at the default width.
              userPanel === "dev"
                ? "max-w-7xl"
                : userPanel === "subscription" || userPanel === "legal" || userPanel === "usage" || userPanel === "settings"
                  ? "max-w-3xl" : "max-w-md"
            }`}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-700/50">
              <span className="text-slate-400">
                {userPanel === "profile"      && <User size={16} />}
                {userPanel === "accounts"     && <Users size={16} />}
                {userPanel === "settings"     && <Settings size={16} />}
                {userPanel === "subscription" && <CreditCard size={16} />}
                {userPanel === "legal"        && <FileText size={16} />}
                {userPanel === "help"         && <HelpCircle size={16} />}
                {userPanel === "usage"        && <BarChart2 size={16} />}
                {userPanel === "dev"          && <Sparkles size={16} />}
              </span>
              <h2 className="flex-1 text-base font-semibold text-slate-100">
                {userPanel === "profile"      && "Profile"}
                {userPanel === "accounts"     && "Accounts"}
                {userPanel === "settings"     && "Settings"}
                {userPanel === "subscription" && "Subscription"}
                {userPanel === "legal"        && "Terms & Notices"}
                {userPanel === "help"         && "Help"}
                {userPanel === "usage"        && "Usage"}
                {userPanel === "dev"          && "Developer Controls"}
              </h2>
              <button onClick={() => setUserPanel(null)} className="text-slate-500 hover:text-slate-300 transition-colors"><X size={16} /></button>
            </div>

            {/* Body — dev panel gets extra vertical breathing room
                because its 3-column grid + editor rows otherwise feel
                cramped against the modal header/footer borders. */}
            <div className={`px-6 ${userPanel === "dev" ? "py-8" : "py-5"}`}>

              {userPanel === "profile" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="h-16 w-16 rounded-full bg-blue-600 flex items-center justify-center text-white text-2xl font-bold">
                      {(authUser?.email?.[0] ?? "U").toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-200">{authUser?.email}</p>
                      <p className="text-xs text-blue-400 mt-0.5">Alpha Member</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="rounded-xl bg-slate-800/50 px-4 py-3">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Email</p>
                      <p className="text-sm text-slate-300">{authUser?.email}</p>
                    </div>
                    <div className="rounded-xl bg-slate-800/50 px-4 py-3">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Plan</p>
                      <p className="text-sm text-slate-300">Alpha — Early Access</p>
                    </div>
                  </div>
                </div>
              )}

              {userPanel === "settings" && (
                // Two-column horizontal layout at md+: Appearance on the left,
                // Behaviour controls on the right. Stacks vertically on narrow
                // viewports so the modal stays usable on small windows.
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
                  {/* ── APPEARANCE ───────────────────────────────────────── */}
                  <div className="rounded-xl bg-slate-800/50 px-4 py-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-200">Appearance</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">Day or Night</p>
                      </div>
                      <div className="inline-flex items-center rounded-xl border border-slate-700 bg-slate-900/50 p-0.5 text-xs font-semibold">
                        <button
                          onClick={() => setThemeMode("day")}
                          className={`flex items-center gap-1 rounded-lg px-2.5 py-1 transition-colors ${themeMode === "day" ? "bg-blue-500 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
                        ><Sun size={12} />Day</button>
                        <button
                          onClick={() => setThemeMode("night")}
                          className={`flex items-center gap-1 rounded-lg px-2.5 py-1 transition-colors ${themeMode === "night" ? "bg-blue-500 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}
                        ><Moon size={12} />Night</button>
                      </div>
                    </div>

                    {/* Day + Night theme lists side-by-side inside Appearance */}
                    <div className="grid grid-cols-2 gap-2">
                      {(["day", "night"] as const).map(section => {
                        const themes = themesByMode(section);
                        const activeId = section === "day" ? dayThemeId : nightThemeId;
                        const setId = section === "day" ? setDayThemeId : setNightThemeId;
                        return (
                          <div key={section} className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">{section === "day" ? "Day" : "Night"}</p>
                            <div className="flex flex-col gap-1.5">
                              {themes.map(t => {
                                const isActive = t.id === activeId;
                                return (
                                  <button
                                    key={t.id}
                                    onClick={() => { setId(t.id); setThemeMode(section); }}
                                    className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left transition-colors ${isActive ? "border-blue-500/60 bg-blue-500/10" : "border-slate-700/60 bg-slate-900/40 hover:border-slate-600"}`}
                                    title={t.blurb}
                                  >
                                    <span className="flex shrink-0 items-center gap-0.5">
                                      {t.swatches.map((c, i) => (
                                        <span key={i} className="h-3 w-3 rounded-full border border-black/20" style={{ backgroundColor: c }} />
                                      ))}
                                    </span>
                                    <span className="min-w-0 flex-1 text-[11px] font-semibold text-slate-100 truncate">{t.label}</span>
                                    {isActive && <Check size={11} className="shrink-0 text-blue-400" />}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* ── BEHAVIOUR ────────────────────────────────────────── */}
                  <div className="space-y-3">
                    {/* Panel opacity */}
                    <div className="rounded-xl bg-slate-800/50 px-4 py-3">
                      <p className="text-sm font-semibold text-slate-200">Panel opacity</p>
                      <p className="text-[10px] text-slate-500 mt-0.5 mb-2">Let the page canvas bleed through each panel</p>
                      <div className="space-y-2">
                        {(["synthesis", "workspace", "lab"] as const).map(region => {
                          const labels = { synthesis: "Synthesis", workspace: "Workspace", lab: "Lab" };
                          return (
                            <div key={region} className="flex items-center gap-2">
                              <span className="shrink-0 w-20 text-[11px] text-slate-300">{labels[region]}</span>
                              <input
                                type="range"
                                min={0.4}
                                max={1}
                                step={0.05}
                                value={panelAlpha[region]}
                                onChange={(e) => setPanelAlpha(prev => ({ ...prev, [region]: Number(e.target.value) }))}
                                className="flex-1 accent-blue-500 cursor-pointer"
                              />
                              <span className="shrink-0 w-10 text-right text-[10px] font-mono text-slate-400 tabular-nums">{Math.round(panelAlpha[region] * 100)}%</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* Default paper count */}
                    <div className="flex items-center justify-between rounded-xl bg-slate-800/50 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-200">Default paper count</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">Papers returned per search (3–500)</p>
                      </div>
                      <input
                        type="number"
                        min={3}
                        max={500}
                        value={paperCount}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) setPaperCount(Math.max(3, Math.min(500, Math.round(n))));
                        }}
                        className="w-20 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 text-right text-sm font-mono text-slate-100 outline-none focus:border-blue-500/60 tabular-nums"
                      />
                    </div>
                    {/* Fast mode indicator */}
                    <div className="flex items-center justify-between rounded-xl bg-slate-800/50 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-200">Fast Mode</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">Quick results vs deep analysis</p>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${fastMode ? "bg-blue-500/20 text-blue-400" : "bg-slate-700 text-slate-400"}`}>
                        {fastMode ? "On" : "Off"}
                      </span>
                    </div>

                    {/* Announcement rotation interval — how fast the ticker cycles */}
                    <div className="rounded-xl bg-slate-800/50 px-4 py-3">
                      <div className="flex items-center justify-between mb-1">
                        <div>
                          <p className="text-sm font-semibold text-slate-200">Announcement rotation</p>
                          <p className="text-[10px] text-slate-500 mt-0.5">How long each message stays before cycling</p>
                        </div>
                        <span className="text-[11px] font-mono text-slate-300 tabular-nums">
                          {(rotatorIntervalMs / 1000).toFixed(1)}s
                        </span>
                      </div>
                      <input
                        type="range"
                        min={ROTATOR_INTERVAL_MIN}
                        max={ROTATOR_INTERVAL_MAX}
                        step={500}
                        value={rotatorIntervalMs}
                        onChange={(e) => setRotatorIntervalMs(Number(e.target.value))}
                        className="w-full accent-blue-500 cursor-pointer mt-1"
                      />
                      <div className="flex justify-between text-[9px] text-slate-600 mt-0.5 font-mono">
                        <span>{(ROTATOR_INTERVAL_MIN / 1000).toFixed(0)}s</span>
                        <span>{(ROTATOR_INTERVAL_MAX / 1000).toFixed(0)}s</span>
                      </div>
                    </div>

                    {/* Theme cross-fade duration — how slowly day/night transitions */}
                    <div className="rounded-xl bg-slate-800/50 px-4 py-3">
                      <div className="flex items-center justify-between mb-1">
                        <div>
                          <p className="text-sm font-semibold text-slate-200">Theme transition</p>
                          <p className="text-[10px] text-slate-500 mt-0.5">Cross-fade duration when switching day/night</p>
                        </div>
                        <span className="text-[11px] font-mono text-slate-300 tabular-nums">
                          {themeTransitionMs}ms
                        </span>
                      </div>
                      <input
                        type="range"
                        min={THEME_TRANSITION_MIN}
                        max={THEME_TRANSITION_MAX}
                        step={50}
                        value={themeTransitionMs}
                        onChange={(e) => setThemeTransitionMs(Number(e.target.value))}
                        className="w-full accent-blue-500 cursor-pointer mt-1"
                      />
                      <div className="flex justify-between text-[9px] text-slate-600 mt-0.5 font-mono">
                        <span>{THEME_TRANSITION_MIN}ms</span>
                        <span>{(THEME_TRANSITION_MAX / 1000).toFixed(1)}s</span>
                      </div>
                    </div>

                    {/* The Workspace question length cap is admin-controlled
                        only — see the ClientConfigEditor in /admin. We do
                        NOT expose it here because mis-sized user inputs
                        degrade the retrieval pipeline for the whole
                        product, not just the individual user. */}
                  </div>
                </div>
              )}

              {userPanel === "usage" && (() => {
                // Live countdown. `nowMs` ticks every second; when the card
                // renders we diff against next_reset_utc to render
                // "Resets in Xh Ym Zs" + the exact wall-clock time.
                const resetIso = usage.data?.next_reset_utc;
                const resetMs = resetIso ? Date.parse(resetIso) : NaN;
                const remainingMs = Number.isFinite(resetMs) ? Math.max(0, resetMs - nowMs) : 0;
                const rh = Math.floor(remainingMs / 3_600_000);
                const rm = Math.floor((remainingMs % 3_600_000) / 60_000);
                const rs = Math.floor((remainingMs % 60_000) / 1000);
                const resetLocal = resetIso ? new Date(resetIso).toLocaleString() : "";
                const resetUtc   = resetIso ? new Date(resetIso).toUTCString()    : "";
                return (
                // Dedicated Usage dashboard — shows remaining quota per
                // feature, current tier, and a path to the Subscription
                // modal for upgrade. Hover on any card lifts the border so
                // the panel feels interactive even though the cards
                // themselves are read-only — that addresses the "I clicked
                // and nothing happened" feedback from the Alpha test.
                <div className="space-y-4">
                  {usage.loading && !usage.data && (
                    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 px-4 py-6 text-sm text-slate-400 text-center animate-pulse">
                      Loading your usage…
                    </div>
                  )}
                  {usage.error && !usage.data && (
                    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                      Couldn&apos;t load usage: {usage.error}. Your quotas still apply server-side.
                    </div>
                  )}
                  {usage.data && (
                    <>
                      {/* Dev badge — when the caller is a developer / internal
                          operator (tier='dev' per /api/usage/me), show a
                          prominent gold "DEV · Unlimited" pill so they
                          don't second-guess whether the "0 left / 5" style
                          numbers below apply to them (they don't — the
                          backend short-circuits all quota checks for
                          tier=dev). Pill floats at the top-right so it
                          reads as "status stamp" rather than as UI chrome. */}
                      {usage.data.tier === "dev" && (
                        <div
                          className="flex items-center justify-between rounded-xl border px-3 py-2"
                          style={{
                            background: "linear-gradient(135deg, rgba(250, 204, 21, 0.18), rgba(234, 179, 8, 0.10))",
                            borderColor: "rgba(250, 204, 21, 0.45)",
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-base" aria-hidden>👑</span>
                            <div>
                              <p className="text-xs font-bold" style={{ color: "#fde68a" }}>
                                DEV · Unlimited
                              </p>
                              <p className="text-[10px]" style={{ color: "#fcd34d" }}>
                                Developer account — no quota enforcement. Counters below are informational only.
                              </p>
                            </div>
                          </div>
                          <span
                            className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                            style={{
                              color: "#facc15",
                              backgroundColor: "rgba(250, 204, 21, 0.15)",
                              border: "1px solid rgba(250, 204, 21, 0.45)",
                            }}
                          >
                            ∞
                          </span>
                        </div>
                      )}
                      <div className="flex items-start justify-between flex-wrap gap-2">
                        <div>
                          <p className="text-xs font-bold text-slate-200">
                            Current plan: <span className="capitalize text-blue-300">{usage.data.tier}</span>
                          </p>
                          <p className="text-[11px] text-slate-500">
                            Every counter below resets daily at 00:00 UTC · today ({usage.data.day_utc ?? usage.data.year_month ?? "—"})
                          </p>
                        </div>
                        <button
                          onClick={() => { void usage.refresh(); }}
                          disabled={usage.loading}
                          className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-50"
                          aria-label="Refresh usage snapshot"
                        >
                          <span aria-hidden className={usage.loading ? "inline-block animate-spin" : "inline-block"}>↻</span>
                          Refresh
                        </button>
                      </div>

                      {/* Countdown + exact reset time. Uses the theme
                          accent tokens so colours follow the active palette
                          (blue / amber / emerald / rose / umber / pink),
                          and the digits use --ats-fg-primary for maximum
                          contrast against the accent-soft background in
                          both day and night modes. */}
                      {resetIso && (
                        <div
                          className="rounded-xl border px-4 py-3"
                          style={{
                            borderColor: "var(--ats-border-accent)",
                            backgroundColor: "var(--ats-bg-accent-soft)",
                          }}
                        >
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="text-xs">
                              <p className="font-bold" style={{ color: "var(--ats-fg-accent)" }}>Next refresh in</p>
                              <p
                                className="tabular-nums font-bold mt-0.5"
                                style={{ color: "var(--ats-fg-primary)", fontSize: "1rem", letterSpacing: "0.01em" }}
                              >
                                {rh}h {String(rm).padStart(2,"0")}m {String(rs).padStart(2,"0")}s
                              </p>
                            </div>
                            <div className="text-right text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>
                              <p>Local: <span className="tabular-nums" style={{ color: "var(--ats-fg-primary)" }}>{resetLocal}</span></p>
                              <p>UTC: <span className="tabular-nums" style={{ color: "var(--ats-fg-primary)" }}>{resetUtc}</span></p>
                            </div>
                          </div>
                        </div>
                      )}

                      <p className="text-[11px] text-slate-500">
                        {usage.data.enforced
                          ? "Quotas are enforced. When a counter hits zero, the action returns an error until the daily refresh."
                          : "Quota enforcement is OFF during Alpha — numbers shown are the caps we'll flip on once we go live."}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {(Object.keys(USAGE_FEATURE_LABELS) as Array<keyof UsageSnapshot["limits"]>).map((feature) => {
                          const limit = usage.data!.limits[feature] ?? null;
                          const used  = (usage.data!.used as any)[`${feature}_count`] ?? 0;
                          const remaining = limit === null ? null : Math.max(0, limit - used);
                          const empty = remaining === 0;
                          const remainingRatio = limit === null || limit <= 0 ? 1 : Math.max(0, Math.min(1, (limit - used) / limit));
                          return (
                            <div
                              key={feature}
                              // Empty state uses amber (not rose/red). Reaching a
                              // tier cap on a free plan is routine — alarming
                              // red made it feel like the product broke, when
                              // really the user just needs to wait for the
                              // daily reset or upgrade. Amber reads as
                              // "heads up" without panic.
                              className={`rounded-xl border px-4 py-3 transition-all cursor-default hover:-translate-y-0.5 hover:shadow-lg ${
                                empty
                                  ? "border-amber-500/40 bg-amber-500/10 hover:border-amber-400"
                                  : "border-slate-700/60 bg-slate-900/40 hover:border-blue-500/60"
                              }`}
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                                  {USAGE_FEATURE_LABELS[feature]}
                                  {/* Flag a temporarily-disabled feature so the user
                                      understands why their "5 left" counter isn't
                                      matched by a working button in the workspace. */}
                                  {feature === "deep_read" && !EVIDENCE_CHAIN_ENABLED && (
                                    <span
                                      className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border"
                                      style={{ color: "#f59e0b", borderColor: "rgba(245,158,11,0.45)", backgroundColor: "rgba(245,158,11,0.10)" }}
                                      title={EVIDENCE_CHAIN_DISABLED_NOTE}
                                    >
                                      Soon
                                    </span>
                                  )}
                                </span>
                                <span className={`text-[11px] font-semibold tabular-nums ${empty ? "text-amber-300" : "text-slate-300"}`}>
                                  {limit === null
                                    ? "Unlimited"
                                    : `${remaining} left / ${limit}`}
                                </span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${empty ? "bg-amber-500" : remainingRatio < 0.2 ? "bg-amber-500" : "bg-blue-500"}`}
                                  style={{ width: `${Math.round(remainingRatio * 100)}%` }}
                                />
                              </div>
                              <p className="mt-1 text-[10px] text-slate-500">
                                {limit === null
                                  ? "Your tier has no cap on this feature."
                                  : `${used} used today.`}
                              </p>
                              {empty && (
                                <p className="mt-1 text-[10px] text-amber-400">
                                  All used for today — refreshes at 00:00 UTC, or upgrade for more headroom.
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-500 border-t border-slate-700/50 pt-2">
                        <span>Total LLM cost today: ≈ ${usage.data.used.llm_cost_usd.toFixed(3)} USD</span>
                        <button
                          onClick={() => setUserPanel("subscription")}
                          className="text-[11px] font-semibold text-blue-400 hover:text-blue-300 transition-colors"
                        >View plans →</button>
                      </div>
                    </>
                  )}
                </div>
                );
              })()}

              {userPanel === "subscription" && (
                <div className="space-y-4">
                  {/* Alpha banner — during alpha, every tier below is unlocked for everyone. */}
                  <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Gem size={14} className="text-blue-400" />
                      <span className="text-xs font-bold text-blue-300">
                        Alpha Access{usage.data ? ` · your tier: ${usage.data.tier}` : ""}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">Every plan below is free to use during Alpha. Pricing goes live once we exit beta.</p>
                  </div>

                  {/* Live usage — per-feature counters with progress bars, grouped as a single panel
                      so the user sees the same quota numbers whether they open this modal or the
                      menu popup. Server is always the source of truth.
                      Quotas are DAILY — bucket refreshes at 00:00 UTC each day. */}
                  {usage.data && (
                    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 px-4 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <BarChart2 size={13} className="text-blue-400" />
                          <span className="text-xs font-bold text-slate-200">
                            Usage today · {usage.data.day_utc ?? usage.data.year_month ?? "—"}
                          </span>
                        </div>
                        <button
                          onClick={() => { void usage.refresh(); }}
                          disabled={usage.loading}
                          className="text-[10px] text-slate-500 hover:text-blue-400 transition-colors disabled:opacity-50"
                          title="Refresh"
                          aria-label="Refresh usage snapshot"
                        >
                          <span aria-hidden className={usage.loading ? "inline-block animate-spin" : "inline-block"}>↻</span>
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-500 mb-2">
                        {usage.data.enforced
                          ? "Quotas are enforced — requests beyond the daily limit return HTTP 429 until 00:00 UTC."
                          : "Alpha mode: we log usage but don't block. Limits shown are the future caps."}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {(Object.keys(USAGE_FEATURE_LABELS) as Array<keyof UsageSnapshot["limits"]>).map((feature) => {
                          const limit = usage.data!.limits[feature] ?? null;
                          const used  = (usage.data!.used as any)[`${feature}_count`] ?? 0;
                          const remaining = limit === null ? null : Math.max(0, limit - used);
                          const empty = remaining === 0;
                          // Bar shows REMAINING — starts full, shrinks with
                          // use. Matches the "starts full, drains" spec in
                          // the Usage modal and the menu summary.
                          const remainingRatio = limit === null || limit <= 0 ? 1 : Math.max(0, Math.min(1, (limit - used) / limit));
                          return (
                            <div key={feature} className="rounded-lg border border-slate-800/60 bg-slate-900/40 px-3 py-2">
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="font-semibold text-slate-300">{USAGE_FEATURE_LABELS[feature]}</span>
                                <span className={`tabular-nums ${empty ? "text-amber-300" : "text-slate-400"}`}>
                                  {limit === null ? "Unlimited" : `${remaining} left / ${limit}`}
                                </span>
                              </div>
                              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-800">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${empty ? "bg-amber-500" : remainingRatio < 0.2 ? "bg-amber-500" : "bg-blue-500"}`}
                                  style={{ width: `${Math.round(remainingRatio * 100)}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <p className="mt-2 text-[10px] text-slate-600">
                        Total LLM cost this month: ≈ ${usage.data.used.llm_cost_usd.toFixed(3)} USD
                      </p>
                    </div>
                  )}
                  {usage.error && !usage.data && (
                    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-[11px] text-rose-300">
                      Couldn&apos;t load usage ({usage.error}). Try reloading — your quota will still apply server-side.
                    </div>
                  )}

                  {(() => {
                    type PlanTier = {
                      id: "free" | "basic" | "scholar";
                      name: string;
                      price: string;
                      tagline: string;
                      perks: string[];
                      accent: string;
                      activeDuringAlpha: boolean;
                    };
                    // Plan perks are aligned to backend TIER_LIMITS in quota.py
                    // so the card copy matches the real per-month caps the
                    // server enforces. Update both sides together if either
                    // changes — the Usage panel above shows live counters
                    // sourced from the same values.
                    const plans: PlanTier[] = [
                      {
                        id: "free",
                        name: "Free",
                        price: "0",
                        tagline: "Kick the tyres",
                        perks: [
                          "150 Quick Searches / month",
                          "10 Deep Analyses / month",
                          "5 Synthesis Lab runs / month",
                          // Evidence Chain is temporarily offline. When
                          // it comes back we restore "30 Evidence Chains /
                          // month" here. The counter key (deep_read) is
                          // untouched on the backend so allowances don't
                          // have to be re-migrated.
                          ...(EVIDENCE_CHAIN_ENABLED ? ["30 Evidence Chains / month"] : []),
                          "Fast-mode Literature Brief",
                          "Community support",
                        ],
                        accent: "border-slate-600/50",
                        activeDuringAlpha: true,
                      },
                      {
                        id: "basic",
                        name: "Basic",
                        price: "0",
                        tagline: "For daily research work",
                        perks: [
                          "1,500 Quick Searches / month",
                          "60 Deep Analyses / month",
                          "40 Synthesis Lab runs / month",
                          ...(EVIDENCE_CHAIN_ENABLED ? ["300 Evidence Chains / month"] : []),
                          "Up to 40 papers per search",
                          "Full Synthesis Lab · PDF export",
                          "Email support",
                        ],
                        accent: "border-blue-500/40",
                        activeDuringAlpha: true,
                      },
                      {
                        id: "scholar",
                        name: "Scholar",
                        price: "0",
                        tagline: "Deep, unlimited, priority",
                        perks: [
                          "Unlimited Quick Searches",
                          "Unlimited Deep Analyses",
                          "Unlimited Synthesis Lab",
                          ...(EVIDENCE_CHAIN_ENABLED ? ["Unlimited Evidence Chains"] : []),
                          "Up to 200 papers per search",
                          "6-agent multi-agent reasoning",
                          "Synthesis Lab with Scholar Writer access",
                          "Citation & author tracking · PDF + Word export",
                          "Priority support · early access",
                        ],
                        accent: "border-amber-400/50",
                        activeDuringAlpha: true,
                      },
                    ];
                    return (
                      // Three-column grid on wide screens; collapses to one column
                      // below `sm` so the modal stays usable on narrow viewports.
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {plans.map(plan => {
                          const isCurrent = usage.data?.tier === plan.id;
                          return (
                            <div
                              key={plan.id}
                              className={`flex flex-col rounded-xl border bg-slate-900/40 px-4 py-3 transition-all ${
                                isCurrent ? "border-blue-500 ring-2 ring-blue-500/30" : plan.accent
                              }`}
                            >
                              <div className="flex items-baseline justify-between gap-2 mb-1">
                                <span className="text-sm font-bold text-slate-100">{plan.name}</span>
                                <span className="text-xs font-semibold text-slate-300 tabular-nums">{plan.price}</span>
                              </div>
                              <p className="text-[11px] text-slate-500 mb-2">{plan.tagline}</p>
                              <ul className="flex-1 space-y-1">
                                {plan.perks.map(perk => (
                                  <li key={perk} className="flex items-start gap-1.5 text-[11px] text-slate-400">
                                    <Check size={11} className="mt-0.5 text-emerald-400 shrink-0" />
                                    <span>{perk}</span>
                                  </li>
                                ))}
                              </ul>
                              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                {isCurrent && (
                                  <div className="inline-flex items-center gap-1 rounded-full bg-blue-500/25 px-2 py-0.5 text-[10px] font-bold text-blue-200">
                                    Current plan
                                  </div>
                                )}
                                {plan.activeDuringAlpha && (
                                  <div className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
                                    <Check size={9} strokeWidth={3} />
                                    Included in Alpha
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}

                  <p className="text-[10px] text-slate-600">Plans are placeholders — numbers and feature mapping are not final. Your Alpha feedback shapes the pricing.</p>
                </div>
              )}

              {userPanel === "accounts" && (
                <div className="space-y-4">
                  {/* Current account */}
                  <div className="rounded-xl bg-slate-800/50 px-4 py-3">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">Current account</p>
                    <div className="flex items-center gap-2.5">
                      <div className="h-7 w-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                        {(authUser?.email?.[0] ?? "U").toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm text-slate-200 truncate">{authUser?.email}</p>
                        <p className="text-[10px] text-slate-500">{isDeveloper ? "Dev account" : "User"}</p>
                      </div>
                    </div>
                  </div>

                  {/* Saved accounts — shows every account that has a
                      cached session in localStorage. Multiple accounts can
                      be "mounted" simultaneously: the Active row is the
                      live supabase.auth session; every other row marked
                      "Mounted" has a cached refresh-token that the /admin
                      page (or any future multi-session feature) can use
                      without disturbing the current session. Dev accounts
                      with a mounted session also unlock admin access. */}
                  {savedAccounts.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] text-slate-500 uppercase tracking-wide">Mounted accounts</p>
                        <p className="text-[9px] text-slate-600">
                          {savedAccounts.length} session{savedAccounts.length === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        {savedAccounts.map(acct => {
                          const isCurrent = acct.email === authUser?.email;
                          const isLoading = acctSwitching === acct.email;
                          const hasCachedSession = (() => {
                            try {
                              return !!window.localStorage.getItem(_sessionKey(acct.email));
                            } catch { return false; }
                          })();
                          const statusLabel = isCurrent
                            ? "Active"
                            : hasCachedSession
                              ? "Mounted"
                              : "Signed out";
                          const statusColor = isCurrent
                            ? "text-blue-400 bg-blue-500/15 border-blue-500/30"
                            : hasCachedSession
                              ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/25"
                              : "text-slate-500 bg-slate-700/30 border-slate-600/40";
                          const typeLabel =
                            acct.type === "dev"   ? "Dev · password login" :
                            acct.type === "oauth" ? "Google OAuth" :
                                                    "OTP · magic link";
                          return (
                            <div key={acct.email} className={`flex items-center gap-2 rounded-xl px-3 py-2 ${isCurrent ? "bg-blue-500/10 border border-blue-500/20" : "bg-slate-800/40"}`}>
                              <div className="h-6 w-6 rounded-full bg-slate-700 flex items-center justify-center text-slate-300 text-[10px] font-bold shrink-0">
                                {acct.email[0].toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-slate-200 truncate">{acct.email}</p>
                                <p className="text-[9px] text-slate-500 flex items-center gap-1.5">
                                  <span>{typeLabel}</span>
                                  {acct.type === "dev" && hasCachedSession && (
                                    <span className="text-amber-400/80">· admin access available</span>
                                  )}
                                </p>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className={`inline-flex items-center text-[9px] font-bold uppercase tracking-wide border rounded px-1.5 py-0.5 ${statusColor}`}>
                                  {statusLabel}
                                </span>
                                {!isCurrent && (
                                  <button
                                    onClick={() => switchToAccount(acct)}
                                    disabled={acctSwitching !== null}
                                    className="text-[10px] text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors font-medium"
                                  >{isLoading ? "…" : "Switch"}</button>
                                )}
                                <button
                                  onClick={() => removeSavedAccount(acct.email)}
                                  className="text-[10px] text-slate-600 hover:text-red-400 transition-colors ml-1"
                                  title="Remove this account (drops its cached session)"
                                >✕</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {/* Explainer — clarifies that multiple accounts can
                          stay mounted at once without conflict, and that
                          admin access follows any mounted dev account. */}
                      <p className="mt-2 text-[9px] text-slate-600 leading-relaxed">
                        Accounts marked <span className="text-emerald-400">Mounted</span> keep a
                        refresh token on this browser — switching between them skips the
                        re-login step. The <span className="text-blue-400">Active</span> row is
                        the live session used for every main-app request. /admin calls use
                        any mounted dev account independently, so you can browse the dashboard
                        while signed in as a regular user.
                      </p>
                    </div>
                  )}

                  {/* Status message */}
                  {acctSwitchMsg && (
                    <p className={`text-xs rounded-lg px-3 py-2 ${acctSwitchMsg.error ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                      {acctSwitchMsg.text}
                    </p>
                  )}

                  {/* Add account */}
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-2">Add account</p>
                    <button
                      onClick={handleGoogleLogin}
                      className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900/50 hover:bg-slate-800 px-3 py-1.5 text-xs text-slate-200 transition-colors mb-2"
                    >
                      <svg width="13" height="13" viewBox="0 0 48 48" fill="none"><path d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 20-9 20-20 0-1.2-.1-2.4-.4-3.5z" fill="#FFC107"/><path d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" fill="#FF3D00"/><path d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.6 34.9 26.9 36 24 36c-5.3 0-9.7-3.4-11.3-8H6.1C9.4 35.6 16.2 44 24 44z" fill="#4CAF50"/><path d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.5 5.5C41.7 36.2 44 30.5 44 24c0-1.2-.1-2.4-.4-3.5z" fill="#1976D2"/></svg>
                      Continue with Google
                    </button>
                    {/* Dev-account input — enabled, but validates that
                        the typed email is one of the seeded dev accounts.
                        Regular emails auto-mount on login via Google /
                        magic link, so manual entry is reserved for the
                        three dev accounts that don't have OAuth coverage. */}
                    <div className="flex gap-2">
                      <input
                        type="email"
                        value={addAcctInput}
                        onChange={(e) => setAddAcctInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !acctSwitching) void addSavedAccount(); }}
                        placeholder="dev01@academicats.com"
                        disabled={!!acctSwitching}
                        className="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-[var(--ats-border-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
                      />
                      <button
                        onClick={() => void addSavedAccount()}
                        disabled={!addAcctInput.trim() || !!acctSwitching}
                        className="rounded-lg border border-[var(--ats-border-accent)] bg-[var(--ats-bg-accent-soft)] px-3 py-1.5 text-xs font-semibold shrink-0 hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ color: "var(--ats-fg-accent)" }}
                      >{acctSwitching ? "…" : "Add"}</button>
                    </div>
                    <p className="text-[9px] text-slate-600 mt-1.5 leading-relaxed">
                      Dev accounts only (dev01 / dev02 / dev03 @academicats.com).
                      Regular accounts auto-mount when you sign in via Google above.
                    </p>
                  </div>
                </div>
              )}

              {userPanel === "legal" && (
                // Read-only view of the SAME 7-section doc shown at sign-in
                // via TermsOfServiceGate. Single source of truth lives in
                // `src/lib/tos-content.ts`; the only difference between
                // here and the gate is that here there's no Accept button
                // because the user has already accepted.
                <div className="space-y-4">
                  <p className="text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>
                    Version {TOS_VERSION} · {APP_VERSION}. You already accepted these terms to use the product;
                    this page is here so you can re-read them at any time.
                  </p>
                  {TOS_SECTIONS.map(section => (
                    <section key={section.title}>
                      <h3
                        className="text-sm font-bold mb-1"
                        style={{ color: "var(--ats-fg-primary)" }}
                      >
                        {section.title}
                      </h3>
                      <p
                        className="text-xs leading-relaxed"
                        style={{ color: "var(--ats-fg-secondary)" }}
                      >
                        {section.body}
                      </p>
                    </section>
                  ))}
                  <p className="text-[10px] text-center" style={{ color: "var(--ats-fg-muted)" }}>
                    Contact: jy1529098645@gmail.com
                  </p>
                </div>
              )}

              {userPanel === "dev" && isDeveloper && (
                <DevControlsPanel
                  onError={setUiError}
                  onCleared={() => { void announcementsFeed.refresh(); }}
                  announcements={announcementsFeed.items}
                  onRefresh={() => { void announcementsFeed.refresh(); }}
                />
              )}

              {userPanel === "help" && (
                <div className="space-y-3">
                  {[
                    { icon: <Search size={14} />,       title: "How to search",  desc: "Enter a research question and click Run Search or Quick Search." },
                    { icon: <PenLine size={14} />,      title: "Synthesis Lab",  desc: "Select papers from results, then generate a literature review or proposal." },
                    // Evidence Chain card is gated on the feature flag so
                    // users don't see a help tip for a button that's
                    // currently disabled — that would look like a bug.
                    ...(EVIDENCE_CHAIN_ENABLED
                      ? [{ icon: <FileText size={14} />, title: "Evidence Chain", desc: "Click Evidence Chain on any paper to trace its claims to citable sources." }]
                      : []),
                    { icon: <Mail size={14} />,         title: "Contact us",     desc: "Email jy1529098645@gmail.com for feedback or support." },
                  ].map(({ icon, title, desc }) => (
                    <div key={title} className="rounded-xl bg-slate-800/50 px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-slate-400">{icon}</span>
                        <p className="text-sm font-semibold text-slate-200">{title}</p>
                      </div>
                      <p className="text-xs text-slate-400">{desc}</p>
                    </div>
                  ))}
                </div>
              )}

            </div>
          </div>
        </div>
      )}
    </main>
    </TermsOfServiceGate>
  );
}
