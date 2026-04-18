"use client";

import ReactMarkdown from "react-markdown";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PaperCharts } from "./charts";
import { supabase } from "@/lib/supabase/client";

const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const CONFIGURED_API_BASE = RAW_API_BASE.replace(/\/+$/, "");
let runtimeApiBase = CONFIGURED_API_BASE;

function normalizeBase(base: string) {
  return (base || "").replace(/\/+$/, "");
}

function buildApiUrl(path: string, baseOverride?: string) {
  if (!path.startsWith("/")) {
    throw new Error(`API path must start with "/": ${path}`);
  }
  const base = normalizeBase(baseOverride ?? runtimeApiBase);
  return base ? `${base}${path}` : path;
}

function getApiBaseCandidates() {
  const candidates: string[] = [];
  const push = (value: string) => {
    const normalized = normalizeBase(value);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  if (CONFIGURED_API_BASE) {
    // Explicit base is configured — only try it and same-host:8000.
    // Do NOT fall back to the relative-path ("") candidate: that would
    // hit the Next.js server which always returns 404 for /api/* routes
    // it doesn't own, producing a misleading "404" when the real problem
    // is that the Python backend is not reachable.
    push(CONFIGURED_API_BASE);
  } else {
    // No explicit base: try relative first, then auto-detect port 8000.
    push("");
  }

  if (typeof window !== "undefined") {
    const { protocol, hostname, port } = window.location;
    if (hostname) {
      const defaultPort = protocol === "https:" ? "443" : "80";
      if (port !== "8000") {
        push(`${protocol}//${hostname}:8000`);
      }
      if (port && port !== defaultPort) {
        push(`${protocol}//${hostname}`);
      }
    }
  }

  return candidates;
}

async function fetchWithApiFallback(path: string, init?: RequestInit, preferBlob = false) {
  const candidates = getApiBaseCandidates();
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const res = await fetch(buildApiUrl(path, candidate), init);
      if (res.ok) {
        runtimeApiBase = normalizeBase(candidate);
        return res;
      }
      lastResponse = res;
      if (res.status !== 404) {
        return res;
      }
    } catch (error) {
      lastError = error;
      // If a configured base is set and it throws a network error (backend
      // is down / connection refused), surface that error immediately rather
      // than silently falling through to other candidates that would return
      // misleading responses (e.g. Next.js returning its own 404 page).
      if (CONFIGURED_API_BASE && candidate === normalizeBase(CONFIGURED_API_BASE)) {
        throw lastError instanceof Error ? lastError : new Error("Request failed.");
      }
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error(preferBlob ? "Download failed." : "Request failed.");
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Always calls getSession() fresh so the token is never stale.
async function getAuthToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> | undefined ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function explainFetchError(error: unknown) {
  if (!(error instanceof Error)) return "Request failed.";
  const lowered = error.message.toLowerCase();
  if (
    lowered.includes("failed to fetch") ||
    lowered.includes("networkerror") ||
    lowered.includes("load failed") ||
    lowered.includes("connection refused") ||
    lowered.includes("econnrefused")
  ) {
    if (!CONFIGURED_API_BASE) {
      return "Cannot reach the backend. No NEXT_PUBLIC_API_BASE_URL is configured. Set it to your FastAPI service URL (e.g. http://localhost:8000) and restart the frontend.";
    }
    return `Cannot reach the backend at ${CONFIGURED_API_BASE}. Please start (or restart) the Python backend with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload`;
  }
  if (lowered.includes("404")) {
    if (!CONFIGURED_API_BASE) {
      return "The request returned 404. No NEXT_PUBLIC_API_BASE_URL is configured — set it to your FastAPI backend URL (e.g. http://localhost:8000), then restart the frontend.";
    }
    return `The request returned 404 from ${CONFIGURED_API_BASE}. The backend is reachable but the route is missing — make sure you are running the latest version of main.py and that the backend was restarted after any code changes.`;
  }
  return error.message;
}

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
  researcher?: AgentPayload;
  theorist?: AgentPayload;
  methodologist?: AgentPayload;
  critic?: AgentPayload;
  gap_analyst?: AgentPayload;
  verifier?: AgentPayload;
  editor_error?: string;
  final_search_query?: string;
  original_query?: string;
  settings?: Record<string, unknown>;
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

type DragTarget = "left" | "center" | null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
};
type QueryDirectionsResponse = {
  original_query?: string;
  directions: QueryDirection[];
  recommended_direction?: number;
  recommended_sub?: number;
  error?: string;
};

function scoreChip(score: number | undefined | null): { label: string; cls: string } {
  const s = score ?? 0;
  if (s >= 75) return { label: "Strong match", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"  };
  if (s >= 65) return { label: "Good match",   cls: "border-blue-400/50   bg-blue-400/10   text-blue-300"      };
  if (s >= 40) return { label: "Moderate",     cls: "border-amber-700/50  bg-amber-900/20  text-amber-500/80"  };
  return             { label: "Weak match",    cls: "border-rose-500/40   bg-rose-500/10   text-rose-300"      };
}

// ── Announcement marquee ticker ───────────────────────────────────────────────
const TICKER_ITEMS = [
  <>👋 Hi everyone! I&apos;m Zest, the developer. Together with my team β lyrea, we built Academic ATS to empower researchers.</>,
  <>🎓 Our goal is to improve efficiency and output quality throughout the academic research process — from literature discovery to deep analysis.</>,
  <>💌 Feedback is always welcome! Email <a href="mailto:jy1529098645@gmail.com" className="underline underline-offset-2 decoration-blue-400/60 text-blue-400 hover:text-blue-300 transition-colors">jy1529098645@gmail.com</a> or leave a message below. Thank you! 🙏</>,
];

// Join ticker items with a separator for the continuous scroll
function TickerTrack() {
  // Render the track twice (side-by-side) so the loop is seamless
  const segment = (
    <span className="inline-flex items-center gap-0">
      {TICKER_ITEMS.map((item, i) => (
        <span key={i} className="inline-block shrink-0 pr-16 text-xs leading-relaxed text-slate-300">
          {item}
        </span>
      ))}
    </span>
  );
  return (
    <div className="flex overflow-hidden" style={{ maskImage: "linear-gradient(to right, transparent 0%, black 4%, black 96%, transparent 100%)" }}>
      <div
        className="flex shrink-0 whitespace-nowrap"
        style={{ animation: "ticker 38s linear infinite" }}
      >
        {segment}{segment}
      </div>
    </div>
  );
}

// ── Danmu message shape ──────────────────────────────────────────────────────
type DanmuMsg = { id: string; text: string; y: number; speed: number; delay: number; color: string };

function makeMsg(text: string, idx: number): DanmuMsg {
  const colors = ["#60a5fa","#a78bfa","#34d399","#fb923c","#f472b6","#38bdf8","#facc15"];
  const h = (Math.imul(idx + 1, 2654435761) >>> 0);
  return {
    id: `msg-${idx}-${Date.now()}`,
    text,
    y: 6 + (h % 72),               // 6 % – 78 % vertical
    speed: 35 + ((h >> 8) % 10),   // 35 s – 45 s  (matches ticker ~38 s)
    color: colors[(h >> 4) % colors.length],
    delay: -(((h >> 12) % 20)),     // stagger starting positions
  };
}

// ── Announcement banner props ────────────────────────────────────────────────
type AnnouncementBannerProps = {
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  publicMsgs: DanmuMsg[];
  msgInput: string;
  setMsgInput: (v: string) => void;
  msgPublic: boolean;
  setMsgPublic: (v: boolean) => void;
  msgSending: boolean;
  msgSentOk: boolean;
  onSend: () => void;
};

function AnnouncementBanner({
  collapsed, onCollapse, onExpand,
  publicMsgs,
  msgInput, setMsgInput,
  msgPublic, setMsgPublic,
  msgSending, msgSentOk, onSend,
}: AnnouncementBannerProps) {
  if (collapsed) {
    return (
      <div className="h-full rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)] overflow-hidden flex flex-col">
        {/* Thin collapse bar — mirrors expanded layout: 📢 | line | ▼ button at right */}
        <div className="flex items-center gap-2 px-3 pr-10 shrink-0" style={{ height: "20px" }}>
          <span className="shrink-0 text-[10px] text-blue-400/60">📢</span>
          <div className="flex-1 h-px bg-gradient-to-r from-blue-500/25 via-purple-500/20 to-blue-500/25" />
          <button
            onClick={onExpand}
            title="Expand announcements"
            className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-[10px] text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 transition select-none"
          >▼</button>
        </div>
        {/* Danmu area */}
        <div className="relative flex-1 overflow-hidden">
          {publicMsgs.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-600 opacity-50 select-none pointer-events-none">
              Public messages will flow here as danmu ✦
            </div>
          ) : (
            publicMsgs.map((msg) => (
              <span
                key={msg.id}
                className="absolute whitespace-nowrap text-[11px] font-medium select-none pointer-events-none"
                style={{
                  top: `${msg.y}%`,
                  left: 0,
                  color: msg.color,
                  opacity: 0.82,
                  animation: `danmuFloat ${msg.speed}s linear infinite`,
                  animationDelay: `${msg.delay}s`,
                  textShadow: "0 1px 4px rgba(0,0,0,0.35)",
                }}
              >
                {msg.text}
              </span>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col justify-between overflow-hidden rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)]">
      {/* Ticker row */}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 pr-10">
        <span className="shrink-0 text-[13px] text-blue-400/70">📢</span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <TickerTrack />
        </div>
        <button
          onClick={onCollapse}
          title="Collapse announcements"
          className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-[10px] text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 transition select-none"
        >▲</button>
      </div>

      {/* Message input row */}
      <div className="flex items-center gap-1.5 border-t border-slate-800/50 px-3 py-1.5">
        {/* Public / Private toggle */}
        <button
          onClick={() => setMsgPublic(!msgPublic)}
          title={msgPublic ? "Public — will appear as danmu" : "Private — only emailed to developer"}
          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide transition select-none ${
            msgPublic
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
              : "bg-slate-700/30 text-slate-500 border border-slate-700/40"
          }`}
        >
          {msgPublic ? "PUBLIC" : "PRIVATE"}
        </button>
        <span className="shrink-0 text-[11px] text-slate-600">💬</span>
        <input
          type="text"
          value={msgInput}
          onChange={(e) => setMsgInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !msgSending) void onSend(); }}
          placeholder="Leave a message for the team…"
          className="min-w-0 flex-1 bg-transparent py-0.5 text-xs text-slate-300 outline-none placeholder:text-slate-700"
        />
        <button
          onClick={() => void onSend()}
          disabled={!msgInput.trim() || msgSending}
          className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
            msgSentOk
              ? "border-emerald-500/40 text-emerald-400"
              : "border-slate-700/50 text-slate-500 hover:border-blue-500/40 hover:text-blue-400"
          }`}
        >
          {msgSentOk ? "✓ Sent" : msgSending ? "…" : "Send"}
        </button>
      </div>
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
          <span className="ml-auto text-xs font-normal text-emerald-400">✓ done</span>
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
  sectionRef,
}: {
  onResizeStart: () => void;
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

  return (
    <div
      ref={trackRef}
      onMouseDown={onResizeStart}
      className="relative self-stretch cursor-col-resize flex-none select-none"
      style={{ width: "5px" }}
    >
      {/* Track */}
      <div className="absolute inset-0 rounded-full bg-white/5 transition-colors hover:bg-white/10" />
      {/* Scroll thumb */}
      {thumbHeight < 99 && (
        <div
          onMouseDown={handleThumbMouseDown}
          className="absolute left-[1px] right-[1px] rounded-full bg-slate-600/60 transition-colors hover:bg-blue-500/70 cursor-ns-resize"
          style={{ top: `${thumbTop}%`, height: `${thumbHeight}%` }}
        />
      )}
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

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [query, setQuery] = useState("");
  const [queryOptionsData, setQueryOptionsData] = useState<QueryOptionsResponse | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | null>(null);
  const [customQueryEnabled, setCustomQueryEnabled] = useState(false);
  const [customQueryValue, setCustomQueryValue] = useState("");
  const [directionData, setDirectionData] = useState<QueryDirectionsResponse | null>(null);
  const [understandOpen, setUnderstandOpen] = useState(true);
  const [selectedDirIndex, setSelectedDirIndex] = useState<number | null>(null);
  const [selectedSubIndex, setSelectedSubIndex] = useState<number | null>(null);

  const [fastMode, setFastMode] = useState(true);
  const [paperCount, setPaperCount] = useState(10);
  const [sortMode, setSortMode] = useState("Relevance score");
  const [preferAbstracts, setPreferAbstracts] = useState(true);
  const [strictCoreOnly, setStrictCoreOnly] = useState(false);
  const [openAccessOnly, setOpenAccessOnly] = useState(true);
  const [sourceFilters, setSourceFilters] = useState<string[]>(DEFAULT_SOURCES);
  const [useYearRange, setUseYearRange] = useState(false);
  const [yearStart, setYearStart] = useState(2018);
  const [yearEnd, setYearEnd] = useState(new Date().getFullYear());

  const [isUnderstanding, setIsUnderstanding] = useState(false);
  const [understandStatus, setUnderstandStatus] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [retrievalCount, setRetrievalCount] = useState<number | null>(null);
  const [candidateLimit, setCandidateLimit] = useState<number | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [briefStreamText, setBriefStreamText] = useState("");
  const [streamPapers, setStreamPapers] = useState<Paper[]>([]);
  const [streamAgents, setStreamAgents] = useState<Record<string, AgentPayload>>({});
  const [startedAgents, setStartedAgents] = useState<Set<string>>(new Set());
  const [rawProgressMsg, setRawProgressMsg] = useState("");
  const [uiError, setUiError] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());

  const [leftPct, setLeftPct] = useState(29);
  const [centerPct, setCenterPct] = useState(53);
  const rightPct = Math.max(100 - leftPct - centerPct, 12);
  const [analyticsVisible, setAnalyticsVisible] = useState(true);

  // ── Announcement / messaging state ─────────────────────────────────────────
  const [announcementCollapsed, setAnnouncementCollapsed] = useState(false);
  const [msgInput, setMsgInput] = useState("");
  const [msgPublic, setMsgPublic] = useState(true);
  const [publicMsgs, setPublicMsgs] = useState<DanmuMsg[]>([]);
  const [msgSending, setMsgSending] = useState(false);
  const [msgSentOk, setMsgSentOk] = useState(false);

  // ── Workspace collapsible panel state ─────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Right panel tabs: Analytics | Synthesis Lab ────────────────────────────
  const [rightTab, setRightTab] = useState<"analytics" | "lab">("analytics");
  // Delay grid expansion until the aside slide-out finishes → eliminates the
  // fr→px interpolation artefact that wobbled the workspace left edge.
  const [gridRightCollapsed, setGridRightCollapsed] = useState(false);

  // ── Synthesis Lab (✍️) state ───────────────────────────────────────────────
  const [labRefs,       setLabRefs]       = useState<{ key: string; paper: Paper }[]>([]);
  const [labCoreArg,    setLabCoreArg]    = useState("");
  const [labPoints,     setLabPoints]     = useState<string[]>([""]);
  const [labOutputType,     setLabOutputType]     = useState("literature_review");
  const [labCitationFormat, setLabCitationFormat] = useState("APA 7th Edition");
  const [labLanguage,       setLabLanguage]       = useState("English");
  const [labTargetPages,    setLabTargetPages]    = useState(2);
  const [labGenerating, setLabGenerating] = useState(false);
  const [labResult,     setLabResult]     = useState("");
  const [labStatus,     setLabStatus]     = useState("");
  const [labError,      setLabError]      = useState("");
  const [labAgentLog,   setLabAgentLog]   = useState<{name: string; msg: string; done: boolean; error: boolean; revision: boolean}[]>([]);
  const [labDownloadFormat, setLabDownloadFormat] = useState<"pdf"|"html"|"txt"|"md">("pdf");
  const [briefDownloadFmt, setBriefDownloadFmt]   = useState<"pdf"|"html"|"txt"|"md">("pdf");
  const [labAgentLogOpen,   setLabAgentLogOpen]   = useState(true);
  const [labReviewerNotes,  setLabReviewerNotes]  = useState<{citation_gaps:string[];data_suggestions:string[];argument_suggestions:string[];supporting_points:string[]} | null>(null);
  const [labNotesOpen,      setLabNotesOpen]      = useState(true);
  const [labUserFiles,      setLabUserFiles]      = useState<File[]>([]);
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
  const [userPanel, setUserPanel] = useState<"profile" | "settings" | "subscription" | "help" | "accounts" | null>(null);

  // ── Role & multi-account management ───────────────────────────────────────
  // Single source of truth for developer emails — used for role checks everywhere.
  const DEV_ACCTS = ["dev01@academicats.com", "dev02@academicats.com", "dev03@academicats.com"];
  const DEV_PWD   = process.env.NEXT_PUBLIC_DEV_PASSWORD ?? "";
  // userRole: "guest" | "user" | "dev"
  const userRole = !authUser ? "guest" : DEV_ACCTS.includes(authUser.email ?? "") ? "dev" : "user";
  const isDeveloper = userRole === "dev";
  type SavedAccount = { email: string; type: "dev" | "otp" };
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
  const addSavedAccount = () => {
    const email = addAcctInput.trim().toLowerCase();
    if (!email || savedAccounts.some(a => a.email === email)) { setAddAcctInput(""); return; }
    const type: SavedAccount["type"] = DEV_ACCTS.includes(email) ? "dev" : "otp";
    persistAccounts([...savedAccounts, { email, type }]);
    setAddAcctInput("");
  };
  const removeSavedAccount = (email: string) => persistAccounts(savedAccounts.filter(a => a.email !== email));

  const handleGoogleLogin = async () => {
    const redirectTo = typeof window !== 'undefined' ? `${window.location.origin}/` : 'http://localhost:3000/';
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  };

  const switchToAccount = async (acct: SavedAccount) => {
    setAcctSwitchMsg(null);
    setAcctSwitching(acct.email);
    try {
      if (acct.type === "dev") {
        const { error } = await supabase.auth.signInWithPassword({ email: acct.email, password: DEV_PWD });
        if (error) { setAcctSwitchMsg({ text: error.message, error: true }); }
        else { setUserPanel(null); setUserMenuOpen(false); }
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
  const [historyPanelHeight, setHistoryPanelHeight] = useState(150);
  type HistoryEntry = { id: string; title: string; updated_at: string; result?: SearchResponse | null; directionData?: QueryDirectionsResponse | null; entryType?: "understand" | "search"; usedUnderstand?: boolean };
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

  const clearAllHistory = useCallback(() => {
    if (authUser?.email) localStorage.removeItem(_hKey(authUser.email));
    setHistoryList([]);
    setActiveHistoryId(null);
  }, [authUser?.email]);

  const deleteHistoryEntry = useCallback((id: string) => {
    setHistoryList(prev => {
      const next = prev.filter(e => e.id !== id);
      if (authUser?.email) localStorage.setItem(_hKey(authUser.email), JSON.stringify(next));
      return next;
    });
  }, []);

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
      setJob({ status: "done", progress: 100, result: item.result, finished_at: Date.now() / 1000, message: "✅ Finished.", workflow: [] } as any);
    }
  }, []);
  const authTokenRef = useRef<string | null>(null);
  const briefTextRef = useRef("");          // mirrors briefStreamText for use inside closures
  const briefClearedRef = useRef(false);    // guards: clear old brief only on first chunk of new search
  const router = useRouter();


  // Timer — ticks while search is running AND the progress bar hasn't hit 100 yet.
  // "Bar at 100" mirrors the displayProgress useMemo logic but computed inline here
  // (using only state values declared above) to avoid a TDZ reference error.
  const _timerBarFull = !isSubmitting
    || (job?.status === "done")
    || (!fastMode && (streamPapers.length > 0 || job?.status === "done"))
    || (fastMode && Math.min(100, job?.progress ?? 0) >= 100);
  useEffect(() => {
    if (_timerBarFull) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [_timerBarFull]);

  // ── Auth: load current session + subscribe to changes ─────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      authTokenRef.current = session?.access_token ?? null;
      setAuthUser(session?.user ?? null);
      console.log("[auth] getSession →", session?.user?.email ?? "no session", "| token:", session?.access_token ? "✓" : "✗");
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      authTokenRef.current = session?.access_token ?? null;
      setAuthUser(session?.user ?? null);
      console.log("[auth] onAuthStateChange →", session?.user?.email ?? "signed out", "| token:", session?.access_token ? "✓" : "✗");
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── Per-user localStorage key helpers ────────────────────────────────────
  const _hKey = (email: string) => `ats-search-history::${email}`;
  const _fKey = (email: string) => `ats-history-favorites::${email}`;

  // Load / reload history + favorites whenever the logged-in user changes
  useEffect(() => {
    const email = authUser?.email;
    if (!email) { setHistoryList([]); setFavoritedIds(new Set()); return; }

    // One-time migration: move legacy unscoped data → dev01's bucket
    const LEGACY_H = "ats-search-history";
    const LEGACY_F = "ats-history-favorites";
    const DEV01 = "dev01@academicats.com";
    if (email === DEV01) {
      const legacy = localStorage.getItem(LEGACY_H);
      if (legacy) { if (!localStorage.getItem(_hKey(DEV01))) localStorage.setItem(_hKey(DEV01), legacy); localStorage.removeItem(LEGACY_H); }
      const legacyF = localStorage.getItem(LEGACY_F);
      if (legacyF) { if (!localStorage.getItem(_fKey(DEV01))) localStorage.setItem(_fKey(DEV01), legacyF); localStorage.removeItem(LEGACY_F); }
    }

    // Always load localStorage first for instant display
    let localItems: HistoryEntry[] = [];
    try { localItems = JSON.parse(localStorage.getItem(_hKey(email)) || "[]"); } catch { /* ignore */ }
    setHistoryList(localItems);

    // Favorites
    try { setFavoritedIds(new Set(JSON.parse(localStorage.getItem(_fKey(email)) || "[]"))); } catch { setFavoritedIds(new Set()); }

    // If user has a real Supabase token, also fetch from cloud and merge
    const API = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
    getAuthToken().then(token => {
      console.log("[history] getAuthToken →", token ? `✓ (${token.slice(0, 20)}…)` : "✗ no token — skip cloud fetch");
      if (!token) return;
      console.log("[history] fetching /api/history with Bearer token");
      fetch(`${API}/api/history?limit=50`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => { console.log("[history] /api/history response status:", r.status); return r.ok ? r.json() : Promise.reject(r.status); })
        .then((cloudItems: HistoryEntry[]) => {
          console.log("[history] cloud items received:", cloudItems.length);
          // Merge: local items take precedence (have more data like directionData/usedUnderstand)
          // Cloud items fill in anything not already in local by id
          const localIds = new Set(localItems.map(e => e.id));
          const merged = [
            ...localItems,
            ...cloudItems.filter(c => !localIds.has(c.id)),
          ].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
            .slice(0, 50);
          setHistoryList(merged);
          // Persist merged list locally so next load is fast
          try { localStorage.setItem(_hKey(email), JSON.stringify(merged)); } catch { /* ignore */ }
        })
        .catch((err) => { console.warn("[history] cloud fetch failed:", err, "— falling back to local"); });
    });
  }, [authUser?.email]);

  // Load persisted public danmu messages from localStorage on first mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ats-public-msgs");
      if (saved) {
        const texts: string[] = JSON.parse(saved);
        setPublicMsgs(texts.map((t, i) => makeMsg(t, i)));
      }
    } catch { /* ignore */ }
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
      // Best-effort API call — silently continues if endpoint is not configured
      await fetch("/api/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, isPublic: msgPublic }),
      }).catch(() => {/* no email config — that's OK */});

      if (msgPublic) {
        setPublicMsgs((prev) => {
          const updated = [...prev, makeMsg(text, prev.length)].slice(-60);
          try {
            localStorage.setItem("ats-public-msgs", JSON.stringify(updated.map((m) => m.text)));
          } catch { /* ignore */ }
          return updated;
        });
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

      if (dragRef.current === "left") {
        const newLeft = clamp(pct, 18, 55);
        const remainingForCenterAndRight = 100 - newLeft;
        const adjustedCenter = clamp(centerPct, 22, remainingForCenterAndRight - 12);
        setLeftPct(newLeft);
        setCenterPct(adjustedCenter);
      }

      if (dragRef.current === "center") {
        // No hard restriction on analytics width — only enforce minimum workspace size
        const minBoundary = leftPct + 22;
        const newBoundary = clamp(pct, minBoundary, 88);
        const newCenter = newBoundary - leftPct;
        setCenterPct(clamp(newCenter, 22, 65));
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

  // ── Grid animation: decouple grid-template from the aside slide animation ──
  // When hiding: wait 370 ms (slide-out duration) before collapsing the column.
  // When showing: restore the column immediately so workspace snaps before slide-in.
  // This prevents the fr ↔ px unit-mismatch wobble on the workspace left edge.
  useEffect(() => {
    if (!analyticsVisible) {
      const t = setTimeout(() => setGridRightCollapsed(true), 370);
      return () => clearTimeout(t);
    } else {
      setGridRightCollapsed(false);
    }
  }, [analyticsVisible]);

  // Cascade agent "started" state based on which agents have completed.
  // Wave 1 (researcher/theorist/methodologist) is triggered from the "papers" SSE event.
  // Wave 2 (critic) starts when all wave-1 agents have results.
  // Wave 3 (gap_analyst/verifier) starts when critic has results.
  useEffect(() => {
    if (fastMode || !isSubmitting) return;
    setStartedAgents(prev => {
      const s = new Set(prev);
      if (["researcher", "theorist", "methodologist"].every(a => a in streamAgents)) s.add("critic");
      if ("critic" in streamAgents) { s.add("gap_analyst"); s.add("verifier"); }
      return s;
    });
  }, [streamAgents, fastMode, isSubmitting]);

  const options = queryOptionsData?.options || [];
  const recommendedIndex = typeof queryOptionsData?.recommended_index === "number" ? queryOptionsData.recommended_index : 0;
  const effectiveSelectedIndex = selectedOptionIndex !== null ? selectedOptionIndex : options.length > 0 ? recommendedIndex : null;

  const selectedOption = useMemo((): QueryOption | null => {
    if (directionData?.directions?.length) {
      const dirIdx = selectedDirIndex ?? (directionData.recommended_direction ?? 0);
      const dir = directionData.directions[dirIdx];
      if (dir?.sub_options?.length) {
        const subIdx = selectedSubIndex ?? (selectedDirIndex === null ? (directionData.recommended_sub ?? 0) : 0);
        const sub = dir.sub_options[subIdx] ?? dir.sub_options[0];
        if (sub) return { label: sub.label, search_query: sub.search_query, reason: sub.reason, intent_profile: sub.intent_profile };
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
    "Research Gaps": true, "What This Means for Your Query": true,
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
  const researchBriefMarkdown = formatBriefAsMarkdown(briefStreamText || result?.brief || "");

  // Stable ReactMarkdown component map — empty deps array means this object is created ONCE
  // and never replaced, so ReactMarkdown never unmounts/remounts its subtree when other state
  // changes (that was the root cause of the post-SSE "twitch").
  // New DOM nodes added during streaming still play fade-in on first mount. ✓
  const mdComponents = useMemo(() => ({
    h2: ({ children }: { children?: React.ReactNode }) => (
      <h2 className="fade-in mt-5 mb-2 pb-1 text-[0.78rem] font-extrabold tracking-wider uppercase text-blue-400 border-b border-blue-500/25 not-italic">{children}</h2>
    ),
    h3: ({ children }: { children?: React.ReactNode }) => (
      <h3 className="fade-in mt-3 mb-1 text-[0.72rem] font-bold text-sky-300">{children}</h3>
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

  // Agents: merge streamed results with final result (stream takes live priority)
  const agentData = {
    researcher:    (streamAgents.researcher    ?? result?.researcher)    as AgentPayload | undefined,
    theorist:      (streamAgents.theorist      ?? result?.theorist)      as AgentPayload | undefined,
    methodologist: (streamAgents.methodologist ?? result?.methodologist) as AgentPayload | undefined,
    critic:        (streamAgents.critic        ?? result?.critic)        as AgentPayload | undefined,
    gap_analyst:   (streamAgents.gap_analyst   ?? result?.gap_analyst)   as AgentPayload | undefined,
    verifier:      (streamAgents.verifier      ?? result?.verifier)      as AgentPayload | undefined,
  };

  const toBackendPaper = (paper: Paper) => (paper.raw && typeof paper.raw === "object" ? paper.raw : paper);
  const hasDownloadSource = (paper: Paper) => {
    const backendPaper = toBackendPaper(paper);
    return Boolean(backendPaper.pdf_url || backendPaper.oa_url || backendPaper.url);
  };

  const triggerDownload = async (url: string, body: Record<string, any>, fallbackFilename: string, key: string) => {
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
          }, true)
        : await fetch(pathOrUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
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

  async function handleUnderstand() {
    if (!authUser) { router.push("/login"); return; }
    const trimmed = query.trim();
    if (!trimmed || isUnderstanding) return;
    setUiError("");
    setUnderstandStatus("Searching preview results\u2026");
    setIsUnderstanding(true);
    setDirectionData(null);
    setSelectedDirIndex(null);
    setSelectedSubIndex(null);

    const applyResult = (data: QueryDirectionsResponse) => {
      setDirectionData(data);
      setUnderstandOpen(true);
      setSelectedDirIndex(data.recommended_direction ?? 0);
      setSelectedSubIndex(data.recommended_sub ?? 0);
      setCustomQueryEnabled(false);
      setCustomQueryValue("");
      // Save understand result to history
      try {
        const _id = `u-${Date.now()}`;
        const _entry: HistoryEntry = { id: _id, title: trimmed, updated_at: new Date().toISOString(), entryType: "understand", directionData: data };
        const _key = authUser?.email ? _hKey(authUser.email) : null;
        const _prev: HistoryEntry[] = JSON.parse((_key && localStorage.getItem(_key)) || "[]");
        const _next = [_entry, ..._prev].slice(0, 20);
        if (_key) localStorage.setItem(_key, JSON.stringify(_next));
        setHistoryList(_next);
        setActiveHistoryId(_id);
      } catch { /* ignore */ }
    };

    try {
      // Try the streaming endpoint first; fall back to the plain JSON endpoint
      // if the backend hasn't been restarted yet (returns 404).
      const res = await fetchWithApiFallback("/api/query-directions/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });

      if (res.status === 404) {
        // Backend hasn't picked up the new route yet — use the original blocking endpoint.
        setUnderstandStatus("Analysing research directions\u2026");
        const res2 = await fetchWithApiFallback("/api/query-directions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed }),
        });
        if (!res2.ok) throw new Error(`Failed to understand query: ${res2.status}`);
        const data: QueryDirectionsResponse = await res2.json();
        applyResult(data);
        return;
      }

      if (!res.ok) throw new Error(`Failed to understand query: ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sseEvent = "";
      let sseData = "";

      try {
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("event: ")) { sseEvent = line.slice(7).trim(); }
            else if (line.startsWith("data: ")) { sseData = line.slice(6).trim(); }
            else if (line === "") {
              if (!sseEvent || !sseData) { sseEvent = ""; sseData = ""; continue; }
              try {
                const obj = JSON.parse(sseData) as Record<string, unknown>;
                if (sseEvent === "status") {
                  setUnderstandStatus(String(obj.message ?? ""));
                } else if (sseEvent === "result") {
                  applyResult(obj as QueryDirectionsResponse);
                  break outer;
                } else if (sseEvent === "error") {
                  setUiError(String(obj.error ?? "Query understanding failed."));
                  break outer;
                }
              } catch { /* ignore malformed */ }
              sseEvent = ""; sseData = "";
            }
          }
        }
      } finally {
        // Always release the stream — prevents ERR_INCOMPLETE_CHUNKED_ENCODING
        reader.cancel().catch(() => {});
      }
    } catch (error) {
      setUiError(explainFetchError(error));
    } finally {
      setIsUnderstanding(false);
      setUnderstandStatus("");
    }
  }

  async function handleSearch() {
    if (!authUser) { router.push("/login"); return; }
    const trimmed = query.trim();
    if (!trimmed || isSubmitting) return;
    if (!sourceFilters.length) {
      setUiError("Please select at least one source.");
      return;
    }

    const _usedUnderstand = directionData !== null;
    abortRef.current = new AbortController();
    setIsSubmitting(true);
    setUiError("");
    setJob(null);
    briefClearedRef.current = false;  // will clear on first brief_chunk of the new search
    setStreamPapers([]);
    setStreamAgents({});
    setStartedAgents(new Set());
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
      setJob({ status: "running", progress: 0, message: "⚙️ Initializing...", workflow: [], started_at: Date.now() / 1000, finished_at: null });

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
            if (!briefClearedRef.current) {
              briefClearedRef.current = true;
              briefTextRef.current = "";
              setBriefStreamText("");
            }
            const chunk = data.text ?? "";
            briefTextRef.current += chunk;
            setBriefStreamText((prev) => prev + chunk);
          } else if (sseEvent === "papers") {
            if (Array.isArray(data.papers)) {
              setStreamPapers(data.papers);
              // All analysis agents start as soon as papers are retrieved
              if (!fastMode) {
                setStartedAgents(prev => {
                  const s = new Set(prev);
                  s.add("researcher"); s.add("theorist"); s.add("methodologist");
                  s.add("critic"); s.add("gap_analyst"); s.add("verifier");
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
            setJob((prev) => ({
              ...prev,
              status: "done",
              progress: 100,
              result: data.result ?? null,
              finished_at: Date.now() / 1000,
            }));
            // ── Auto-save to local history ──────────────────────────────────
            const _slim = data.result ? {
              ...data.result,
              // Prefer streamed brief (briefTextRef) over result.brief — they should match,
              // but the streamed version is guaranteed to be complete even if backend omits it from result.
              brief: data.result.brief || briefTextRef.current || undefined,
              papers: (data.result.papers || []).map((p: Paper) => { const { raw: _r, ...rest } = p as any; return rest; }),
            } : null;
            const _histTitle = _slim?.final_search_query || _slim?.original_query || query.trim();
            const _histId = `${Date.now()}`;
            const _histEntry: HistoryEntry = { id: _histId, title: _histTitle, updated_at: new Date().toISOString(), entryType: "search", usedUnderstand: _usedUnderstand, result: _slim };
            try {
              const _key = authUser?.email ? _hKey(authUser.email) : null;
              const _prev: HistoryEntry[] = JSON.parse((_key && localStorage.getItem(_key)) || "[]");
              const _next = [_histEntry, ..._prev].slice(0, 20);
              if (_key) localStorage.setItem(_key, JSON.stringify(_next));
              setHistoryList(_next);
              setActiveHistoryId(_histId);
            } catch { /* ignore */ }
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

  function handleStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsSubmitting(false);
  }

  // ── Synthesis Lab helpers ─────────────────────────────────────────────────
  const addToLab = useCallback((paper: Paper, key: string) => {
    setLabRefs(prev => prev.some(r => r.key === key) ? prev : [...prev, { key, paper }]);
    setRightTab("lab");
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
    const ac = new AbortController();
    labAbortRef.current = ac;
    setLabGenerating(true);
    setLabResult("");
    setLabStatus("Starting synthesis…");
    setLabError("");
    setLabAgentLog([]);
    setLabReviewerNotes(null);
    try {
      const res = await fetchWithApiFallback("/api/forge/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          papers:            labRefs.map(r => toBackendPaper(r.paper)),
          core_argument:     labCoreArg,
          supporting_points: labPoints.filter(p => p.trim()),
          output_type:       labOutputType,
          citation_format:   labCitationFormat,
          language:          labLanguage,
          target_pages:      labTargetPages,
          writing_model:     labWritingModel,
        }),
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
    }
  }

  async function runDeepRead(paper: Paper, paperKey: string) {
    setDeepReadLoading((prev) => ({ ...prev, [paperKey]: true }));
    setDeepReadErrors((prev) => ({ ...prev, [paperKey]: "" }));
    try {
      const res = await fetchWithApiFallback("/api/papers/deep-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper: toBackendPaper(paper), user_query: selectedSearchQuery || query }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, `Deep read failed: ${res.status}`));
      const data = await res.json();
      setDeepReadResults((prev) => ({ ...prev, [paperKey]: data || {} }));
    } catch (error) {
      setDeepReadErrors((prev) => ({
        ...prev,
        [paperKey]: explainFetchError(error),
      }));
    } finally {
      setDeepReadLoading((prev) => ({ ...prev, [paperKey]: false }));
    }
  }

  return (
    <main data-theme={theme} className="h-screen overflow-hidden flex flex-col bg-[var(--ats-bg-base)] text-slate-100 transition-colors duration-300">
      {/* Theme toggle */}
      <button
        onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
        title={theme === "dark" ? "Switch to Light mode" : "Switch to Dark mode"}
        className={`fixed top-4 right-4 z-50 flex h-9 w-9 items-center justify-center rounded-full border shadow-lg backdrop-blur-sm transition-all duration-200 hover:shadow-blue-500/20 ${
          theme === "dark"
            ? "border-slate-700/60 bg-slate-900/80 text-slate-300 hover:border-blue-500/50 hover:text-blue-400"
            : "border-slate-300/70 bg-white/90 text-slate-600 hover:border-blue-400/60 hover:text-blue-500"
        }`}
      >
        {theme === "dark" ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
        )}
      </button>

      <div className="flex flex-col flex-1 min-h-0 px-3 pt-3 pb-2 gap-2">
        {/* ── Top bar: title + announcement side-by-side ── */}
        <div className="flex-none flex items-stretch gap-4">
          {/* Title block */}
          <div className="shrink-0 flex flex-col justify-center py-1">
            <div className="text-5xl font-black tracking-tight">
              <span className="text-slate-100">Academi</span>
              <span className="text-blue-500">Cats</span>
            </div>
            <p className="mt-1.5 text-base text-slate-400">AI-powered academic research assistant <span className="text-xs text-slate-600">v1.5.0-Alpha</span></p>
          </div>
          {/* Announcement banner – fills remaining width */}
          <div className="min-w-0 flex-1">
            <AnnouncementBanner
              collapsed={announcementCollapsed}
              onCollapse={() => setAnnouncementCollapsed(true)}
              onExpand={() => setAnnouncementCollapsed(false)}
              publicMsgs={publicMsgs}
              msgInput={msgInput}
              setMsgInput={setMsgInput}
              msgPublic={msgPublic}
              setMsgPublic={setMsgPublic}
              msgSending={msgSending}
              msgSentOk={msgSentOk}
              onSend={handleSendMessage}
            />
          </div>
        </div>

        {(uiError || (job?.status === "error" && job?.error)) && (
          <div className="mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-3 flex-wrap">
            <span className="flex-1 min-w-0">{uiError || (job?.status === "error" && `Search failed: ${job.error}`)}</span>
            <button
              onClick={() => { setUiError(""); void handleSearch(); }}
              className="shrink-0 rounded-lg border border-red-400/40 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/20 transition-colors"
            >↺ Retry</button>
          </div>
        )}

        <div
          ref={gridRef}
          className="relative grid flex-1 min-h-0"
          style={{
            // Grid expands/collapses as a SNAP — decoupled from the aside slide-out
            // (which handles its own 0.35 s CSS transition).  Removing the fr↔px
            // mixed-unit grid-template transition eliminates the left-edge wobble.
            gridTemplateColumns: gridRightCollapsed
              ? `${leftPct}fr 5px ${centerPct + rightPct}fr 0px 6px`
              : `${leftPct}fr 5px ${centerPct}fr 5px ${rightPct}fr`,
            columnGap: 0,
            rowGap: 0,
          }}
        >
          <section ref={leftSectionRef} className="min-w-0 h-full overflow-y-auto no-scrollbar rounded-xl bg-[var(--ats-bg-section)] p-5 transition-[width] duration-200">
            <div className="mb-5 text-2xl font-bold flex items-baseline gap-2 flex-wrap">
              📄 {!fastMode && isSubmitting && !result ? "Preliminary Research Brief" : "Research Brief"}
              {!fastMode && isSubmitting && !result && researchBriefMarkdown && (
                <span className="text-xs font-normal text-amber-400/80">· preliminary · updates after deep analysis</span>
              )}
            </div>

            {/* Brief — writing indicator before first token arrives */}
            {isSubmitting && !researchBriefMarkdown && (
              <div className="mb-4 flex items-center gap-2 rounded-2xl border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm font-medium text-blue-300 animate-pulse shadow-[0_0_16px_rgba(59,130,246,0.25)]">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-400" />
                Writing research brief…
              </div>
            )}

            {researchBriefMarkdown ? (
              <>
                <div className="fade-in prose prose-invert max-w-none break-words
                  prose-p:text-[0.63rem] prose-p:leading-[1.55] prose-p:my-0.5 prose-p:text-slate-300
                  prose-strong:text-slate-100 prose-strong:font-semibold
                  prose-li:text-[0.63rem] prose-li:text-slate-300 prose-li:my-0
                  prose-ul:my-1 prose-ol:my-1 prose-ul:pl-4 prose-ol:pl-4">
                  <ReactMarkdown components={mdComponents}>{researchBriefMarkdown}</ReactMarkdown>
                  {isStreamingBrief && (
                    <span className="inline-block h-[1.1em] w-[2px] animate-pulse rounded-sm bg-blue-400 align-text-bottom ml-0.5" />
                  )}
                </div>
                {!isStreamingBrief && result?.brief && (
                  <div className="mt-6 flex items-center gap-2 flex-wrap">
                    {/* Quick copy */}
                    <button
                      onClick={() => void navigator.clipboard.writeText(result?.brief || "")}
                      className="rounded-xl border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-400 hover:text-blue-300 hover:border-blue-500/50 transition-colors"
                    >📋 Copy Brief</button>
                    {/* Format download */}
                    <div className="flex items-center gap-1.5">
                      <select
                        value={briefDownloadFmt}
                        onChange={e => setBriefDownloadFmt(e.target.value as "pdf"|"html"|"txt"|"md")}
                        className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm text-slate-400 focus:outline-none focus:border-blue-500/60"
                      >
                        <option value="pdf">PDF</option>
                        <option value="html">HTML</option>
                        <option value="md">Markdown</option>
                        <option value="txt">TXT</option>
                      </select>
                      <button
                        onClick={() => {
                          const slug = (result?.original_query || query || "brief").replace(/\s+/g, "_").replace(/[^\w_]/g, "").slice(0, 40);
                          if (briefDownloadFmt === "pdf") {
                            void triggerDownload(buildApiUrl("/api/brief/download"), {
                              brief_text: result?.brief || "",
                              original_query: result?.original_query || query,
                              final_search_query: result?.final_search_query || query,
                            }, `research_brief_${slug}.pdf`, "brief-download");
                          } else {
                            downloadTextAs(result?.brief || "", `research_brief_${slug}`, briefDownloadFmt as "html"|"txt"|"md");
                          }
                        }}
                        className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 transition-colors"
                      >⬇ Download Brief</button>
                    </div>
                  </div>
                )}
              </>
            ) : !isSubmitting ? (
              <div className="rounded-2xl bg-slate-900/40 p-4 text-sm text-slate-400">
                Run Search & Analysis to see the final Research Brief here.
              </div>
            ) : null}

            <div className="mt-6 space-y-4">
              <div className="rounded-3xl bg-slate-950/40 p-4">
                <div className="mb-2 text-2xl font-bold">🧠 Analytical Trace</div>
                <p className="mb-4 text-sm text-slate-400">The full multi-agent reasoning breakdown.</p>
                <div className="space-y-3">
                  <AgentSection title="Query Planner" payload={result?.query_planner ? Object.fromEntries(Object.entries(result.query_planner).filter(([k]) => !["query_type","search_focus","theorist_needed","critic_needed","verifier_needed"].includes(k))) as AgentPayload : undefined} />
                  <AgentSection title="🔬 Researcher"    payload={agentData.researcher}    running={isSubmitting && !fastMode && startedAgents.has("researcher")} />
                  <AgentSection title="💡 Theorist"      payload={agentData.theorist}      running={isSubmitting && !fastMode && startedAgents.has("theorist")} />
                  <AgentSection title="🔧 Methodologist" payload={agentData.methodologist} running={isSubmitting && !fastMode && startedAgents.has("methodologist")} />
                  <AgentSection title="⚠️ Critic"        payload={agentData.critic}        running={isSubmitting && !fastMode && startedAgents.has("critic")} />
                  <AgentSection title="🕳️ Gap Analyst"   payload={agentData.gap_analyst}   running={isSubmitting && !fastMode && startedAgents.has("gap_analyst")} />
                  <AgentSection title="✅ Verifier"      payload={agentData.verifier}      running={isSubmitting && !fastMode && startedAgents.has("verifier")} />
                </div>
              </div>

              <div className="rounded-3xl bg-[var(--ats-bg-emerald)] p-4">
                <div className="mb-2 text-2xl font-bold">🧭 Retrieval Strategy Summary</div>
                <p className="mb-4 text-sm text-slate-400">How the search was run, screened, and selected.</p>
                {result?.strategy_summary ? (
                  <div className="space-y-2 text-xs text-slate-300">
                    {Array.isArray(result.strategy_summary.strategy_points) &&
                      result.strategy_summary.strategy_points.map((item: any, idx: number) => (
                        <div key={idx} className="break-words">• {String(item)}</div>
                      ))}
                  </div>
                ) : (
                  <div className="rounded-2xl bg-slate-900/30 p-4 text-sm text-slate-500">
                    Run Search & Analysis to see the retrieval strategy summary here.
                  </div>
                )}
              </div>
            </div>
          </section>

          <DividerScrollbar onResizeStart={() => startDrag("left")} sectionRef={leftSectionRef} />

          <section ref={centerSectionRef} className={`min-w-0 h-full overflow-y-auto ${analyticsVisible ? "no-scrollbar" : "thin-scrollbar"} rounded-xl bg-[var(--ats-bg-section)] p-5 transition-[width] duration-200`}>
            <div className="mb-4 text-2xl font-bold">🧠 Workspace</div>

            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter your research topic..."
              rows={1}
              className="w-full resize-y rounded-xl border border-blue-500/15 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-blue-500"
            />

            {/* Selected search query — shown above buttons once a direction is chosen */}
            {selectedSearchQuery && (
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/8 px-3 py-1.5">
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-blue-400">Query</span>
                <span className="flex-1 min-w-0 text-xs font-semibold text-slate-100 break-words leading-snug">{selectedSearchQuery}</span>
              </div>
            )}

            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <button onClick={() => void handleUnderstand()} disabled={!query.trim() || isUnderstanding} className="rounded-xl border border-blue-500/20 bg-slate-900/30 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                {isUnderstanding ? (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                    {understandStatus.toLowerCase().includes("analysing") || understandStatus.toLowerCase().includes("analyzing") || understandStatus.toLowerCase().includes("found")
                      ? "Analysing directions\u2026"
                      : "Thinking\u2026"}
                  </span>
                ) : "🔍 Understand Query"}
              </button>
              {isSubmitting ? (
                <button onClick={handleStop} className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/20">
                  ⏹ Stop Run
                </button>
              ) : (
                <button onClick={() => void handleSearch()} disabled={!query.trim() || isSubmitting} className="rounded-xl bg-blue-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60">
                  🚀 Run Search
                </button>
              )}
            </div>

            {isUnderstanding && (() => {
              const pct = understandStatus.toLowerCase().includes("analysing") || understandStatus.toLowerCase().includes("analyzing")
                ? 75
                : understandStatus.toLowerCase().includes("found")
                  ? 45
                  : 15;
              return (
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-700"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              );
            })()}

            <div className="mt-2 flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-900/60 p-1">
              <button
                onClick={() => setFastMode(true)}
                className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition ${fastMode ? "bg-blue-500 text-white shadow" : "text-slate-400 hover:text-slate-200"}`}
              >
                ⚡ Quick Search
              </button>
              <button
                onClick={() => setFastMode(false)}
                className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition ${!fastMode ? "bg-blue-500 text-white shadow" : "text-slate-400 hover:text-slate-200"}`}
              >
                🧠 Curated Analysis
              </button>
            </div>
            <p className="mt-1 px-1 text-xs text-slate-500">
              {fastMode
                ? "Get results in seconds with smart ranking. Great for rapid literature scanning."
                : "Deep AI curation with adversarial screening and 6-agent analysis. Best for thorough research."}
            </p>

            <details
              className="mt-4 rounded-2xl bg-slate-950/40 px-4 py-3"
              open={settingsOpen}
              onToggle={(e) => setSettingsOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer select-none text-sm font-semibold text-slate-200">⚙️ Settings & Controls</summary>
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
                  >🗑 Clear Cache</button>
                  <span className="text-xs text-slate-600">Clears in-memory backend cache</span>
                </div>
              </div>
            </details>

            <details className="mt-3 rounded-2xl bg-slate-950/40 px-3 py-2.5" open={Boolean(directionData?.directions?.length) && understandOpen} onToggle={e => setUnderstandOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer select-none text-sm font-semibold text-slate-200">🔍 Query Understanding</summary>
              <div className="mt-3">
                {directionData?.directions?.length ? (
                  <>
                    {/* 6 direction cards — 2-column grid */}
                    <div className="grid grid-cols-2 gap-2">
                      {directionData.directions.map((dir, di) => {
                        const isSelDir = (selectedDirIndex ?? directionData.recommended_direction ?? 0) === di;
                        return (
                          <div key={di} className={`rounded-xl border p-2 cursor-pointer transition-all ${isSelDir ? "border-blue-500/50 bg-blue-500/8 col-span-2" : "border-slate-800 bg-slate-900/30 hover:border-slate-700"}`}
                            onClick={() => { setSelectedDirIndex(di); setSelectedSubIndex(0); setCustomQueryEnabled(false); }}>
                            <div className={`text-xs font-semibold leading-snug ${isSelDir ? "text-blue-300" : "text-slate-300"}`}>
                              {di === (directionData.recommended_direction ?? 0) && <span className="mr-1 text-amber-400">⭐</span>}
                              {dir.label}
                            </div>
                            {dir.description && <div className="mt-0.5 text-[10px] leading-tight text-slate-500 line-clamp-2">{dir.description}</div>}
                            {/* Sub-options — only visible when this direction is selected */}
                            {isSelDir && dir.sub_options?.length > 0 && (
                              <div className="mt-2 space-y-1">
                                {dir.sub_options.map((sub, si) => {
                                  const isSelSub = (selectedSubIndex ?? 0) === si && !customQueryEnabled;
                                  return (
                                    <label key={si}
                                      className={`flex items-start gap-1.5 rounded-lg border px-2 py-1 cursor-pointer transition-all ${isSelSub ? "border-blue-400/40 bg-blue-400/10" : "border-slate-700/60 bg-slate-900/40 hover:border-slate-600"}`}
                                      onClick={(e) => { e.stopPropagation(); setSelectedSubIndex(si); setCustomQueryEnabled(false); }}>
                                      <input type="radio" name="sub-option" checked={isSelSub} onChange={() => { setSelectedSubIndex(si); setCustomQueryEnabled(false); }} className="mt-0.5 shrink-0" />
                                      <div className="min-w-0">
                                        <div className={`text-[11px] font-semibold leading-snug ${isSelSub ? "text-blue-200" : "text-slate-300"}`}>{sub.label}</div>
                                        {sub.reason && <div className="mt-0.5 text-[10px] leading-tight text-slate-500">{sub.reason}</div>}
                                      </div>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {/* Custom query option */}
                    <label className={`mt-2 flex items-start gap-2 rounded-xl border p-2 cursor-pointer transition-all ${customQueryEnabled ? "border-blue-500/50 bg-blue-500/8" : "border-slate-800 bg-slate-900/20 hover:border-slate-700"}`}>
                      <input type="radio" name="sub-option" checked={customQueryEnabled} onChange={() => setCustomQueryEnabled(true)} className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-slate-300">Custom query</div>
                        <input value={customQueryValue} onChange={(e) => { setCustomQueryValue(e.target.value); setCustomQueryEnabled(true); }} placeholder="Enter your own search query..." className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-2 py-1 text-xs text-slate-100 outline-none focus:border-blue-500" />
                      </div>
                    </label>
                  </>
                ) : (
                  <div className="text-xs text-slate-500">Click &ldquo;Understand Query&rdquo; to explore 6 research directions before searching.</div>
                )}
              </div>
            </details>

            <div className={`mt-3 rounded-3xl border p-5 transition-colors duration-300 ${isSubmitting ? "border-blue-500/40 bg-[#0a1a35]" : "border-blue-500/20 bg-[#09162d]"}`}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className={`flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] ${job?.status === "error" ? "text-red-400" : "text-blue-400"}`}>
                    {isSubmitting && job?.status !== "error" && (
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
                    )}
                    {job?.status === "done" ? "Search complete" : job?.status === "error" ? "Search failed" : "Current run"}
                  </div>
                  <div className={`mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-slate-100 ${isSubmitting ? "animate-pulse" : ""}`}>
                    <span>{job?.message || "Waiting for backend…"}</span>
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
                      className="shrink-0 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 transition hover:bg-red-500/20"
                    >
                      ⏹ Stop
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
                const completedAgents = (["researcher","theorist","methodologist","critic","gap_analyst","verifier"] as const)
                  .filter(k => agentData[k]);
                if (completedAgents.length === 0) return null;
                const agentLabels: Record<string,string> = {
                  researcher:"Researcher", theorist:"Theorist", methodologist:"Methodologist",
                  critic:"Critic", gap_analyst:"Gap Analyst", verifier:"Verifier"
                };
                return (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 px-0.5">
                    {completedAgents.map(key => (
                      <span key={key} className="flex items-center gap-1 text-[10px] text-emerald-400">
                        <span>✓</span><span>{agentLabels[key]}</span>
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div className="mt-6 border-t border-slate-800 pt-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="text-3xl font-black">📚 Retrieved Papers</span>
                {papersAreStreaming && (
                  <span className="flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-400">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                    Deep analysis running…
                  </span>
                )}
                {displayedPapers.length > 0 && (
                  <span className="text-sm text-slate-500">{displayedPapers.length} papers</span>
                )}
              </div>
              {papersAreStreaming && (
                <div className="mb-3 rounded-2xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="flex items-center gap-1.5 text-blue-300 font-semibold">
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400 shrink-0" />
                      Deep analysis in progress
                    </span>
                    <span className="text-slate-500 tabular-nums">{progress}%</span>
                  </div>
                  <div className="h-1 w-full rounded-full bg-slate-800 overflow-hidden mb-1.5">
                    <div
                      className="h-full rounded-full bg-blue-500/70 transition-all duration-700"
                      style={{ width: `${Math.max(progress, 5)}%` }}
                    />
                  </div>
                  {/* Raw backend message — shows exact step (e.g. adversarial batch X/Y) */}
                  <div className="text-[11px] text-slate-400 leading-snug">
                    {rawProgressMsg || "Initialising deep validation…"}
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
                                title={inLab ? "Remove from Synthesis Lab" : "Add to Synthesis Lab"}
                                className={`shrink-0 mt-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-all ${
                                  inLab
                                    ? "border-violet-500/50 bg-violet-500/10 text-violet-400 hover:border-rose-500/50 hover:text-rose-400 hover:bg-rose-500/10"
                                    : "border-slate-700 bg-slate-900/50 text-slate-500 hover:border-violet-500/50 hover:text-violet-400 hover:bg-violet-500/10"
                                }`}
                              ><span key={inLab ? "in" : "out"}>{inLab ? "✓ Lab" : "+ Lab"}</span></button>
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
                          <div className="mt-1.5 border-l-2 border-slate-700 pl-3 text-xs text-slate-400 break-words leading-[1.35]">
                            💡 {paper.recommendation_reason}
                          </div>
                        )}

                        {/* Action buttons */}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {/* Open Paper */}
                          {paper.url && (
                            <a href={paper.url} target="_blank" rel="noreferrer"
                               className="rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 transition-all">
                              🔗 Open Paper
                            </a>
                          )}
                          {/* Deep Read */}
                          <button
                            onClick={() => void runDeepRead(paper, paperKey)}
                            disabled={!hasDownloadSource(paper) || deepReadLoading[paperKey]}
                            className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all disabled:cursor-not-allowed ${
                              deepReadLoading[paperKey]
                                ? "border-blue-500/60 bg-blue-500/15 text-blue-300 animate-pulse"
                                : "border-slate-700 bg-slate-900/50 text-white hover:bg-slate-800 disabled:opacity-50"
                            }`}
                          >
                            {deepReadLoading[paperKey] ? "🔬 Running…" : "🔬 Deep Read"}
                          </button>
                          {/* Download PDF */}
                          <button
                            onClick={() => void triggerDownload(buildApiUrl("/api/papers/download-original"), { paper: toBackendPaper(paper) }, `${paper.title || "paper"}.pdf`, `${paperKey}-original`)}
                            disabled={!hasDownloadSource(paper) || originalLoading[`${paperKey}-original`]}
                            className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all disabled:cursor-not-allowed ${
                              originalLoading[`${paperKey}-original`]
                                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300 animate-pulse"
                                : "border-slate-700 bg-slate-900/50 text-white hover:bg-slate-800 disabled:opacity-50"
                            }`}
                          >
                            {originalLoading[`${paperKey}-original`] ? "⬇ Downloading…" : "⬇ Download PDF"}
                          </button>
                          {/* Translate PDF + inline language selector */}
                          <button
                            onClick={() => void triggerDownload(buildApiUrl("/api/papers/translate-pdf"), { paper: toBackendPaper(paper), target_languages: langs }, `${paper.title || "paper"}_${(langs[0] || "translated").replace(/\s*\(.*?\)/g, "").trim()}.pdf`, `${paperKey}-translate`)}
                            disabled={!hasDownloadSource(paper) || translateLoading[`${paperKey}-translate`]}
                            className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all disabled:cursor-not-allowed ${
                              translateLoading[`${paperKey}-translate`]
                                ? "border-purple-500/60 bg-purple-500/10 text-purple-300 animate-pulse"
                                : "border-slate-700 bg-slate-900/50 text-white hover:bg-slate-800 disabled:opacity-50"
                            }`}
                          >
                            {translateLoading[`${paperKey}-translate`] ? "🌐 Translating…" : "🌐 Translate PDF"}
                          </button>
                          <select
                            value={langs[0] ?? "Chinese (Simplified)"}
                            onChange={(e) => setTranslationLanguages((prev) => ({ ...prev, [paperKey]: [e.target.value] }))}
                            className="rounded-xl border border-slate-700 bg-slate-900/50 px-2 py-1.5 text-xs text-slate-400 outline-none focus:border-purple-500/50 cursor-pointer"
                          >
                            {["Chinese (Simplified)","Chinese (Traditional)","English","Japanese","Korean","Spanish","French","German","Indonesian"].map((lang) => (
                              <option key={lang} value={lang}>{lang}</option>
                            ))}
                          </select>
                        </div>

                        {/* Error messages */}
                        {deepReadErrors[paperKey] && <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{deepReadErrors[paperKey]}</div>}
                        {originalErrors[paperKey] && <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{originalErrors[paperKey]}</div>}
                        {translateErrors[paperKey] && <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{translateErrors[paperKey]}</div>}

                        {/* Abstract — collapsed by default */}
                        {paper.summary && (
                          <details className="mt-3 rounded-xl bg-slate-950/20">
                            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors">Abstract</summary>
                            <p className="px-3 pb-3 pt-1 whitespace-pre-wrap break-words text-sm leading-7 text-slate-300">{paper.summary}</p>
                          </details>
                        )}


                        {/* Deep Reading result — collapsible */}
                        {deepRead && (
                          <details className="mt-3 rounded-xl bg-blue-500/5" open>
                            <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-bold text-slate-200 hover:text-white transition-colors">🔬 Deep Reading Report</summary>
                            <div className="px-4 pb-4 pt-1">
                              {deepRead.academic_summary && <div className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-300">{deepRead.academic_summary}</div>}
                              {Array.isArray(deepRead.key_findings) && deepRead.key_findings.length > 0 && (
                                <div className="mt-3">
                                  <div className="mb-2 text-sm font-semibold text-slate-100">Key findings</div>
                                  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                                    {deepRead.key_findings.map((item: string, idx: number) => <li key={idx}>{item}</li>)}
                                  </ul>
                                </div>
                              )}
                              {/* Download deep read report */}
                              <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                                <button
                                  onClick={() => {
                                    const text = [
                                      deepRead.academic_summary || "",
                                      deepRead.key_findings?.length
                                        ? "\nKey Findings:\n" + deepRead.key_findings.map((f: string, i: number) => `${i+1}. ${f}`).join("\n")
                                        : "",
                                    ].join("\n");
                                    void navigator.clipboard.writeText(text);
                                  }}
                                  className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-500 hover:text-blue-400 hover:border-blue-500/50 transition-colors"
                                >📋 Copy</button>
                                <select
                                  id={`deepread-fmt-${paperKey}`}
                                  defaultValue="html"
                                  className="rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs text-slate-400 focus:outline-none"
                                >
                                  <option value="html">HTML</option>
                                  <option value="txt">TXT</option>
                                  <option value="md">Markdown</option>
                                </select>
                                <button
                                  onClick={() => {
                                    const fmt = (document.getElementById(`deepread-fmt-${paperKey}`) as HTMLSelectElement)?.value as "html"|"txt"|"md" ?? "html";
                                    const text = [
                                      `# Deep Reading: ${paper.title || "Paper"}\n`,
                                      deepRead.academic_summary || "",
                                      deepRead.key_findings?.length
                                        ? "\n## Key Findings\n" + deepRead.key_findings.map((f: string, i: number) => `${i+1}. ${f}`).join("\n")
                                        : "",
                                    ].join("\n");
                                    const slug = (paper.title || "deep_read").replace(/\s+/g, "_").replace(/[^\w_]/g, "").slice(0, 50);
                                    downloadTextAs(text, `DeepRead_${slug}`, fmt);
                                  }}
                                  className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-500 hover:text-emerald-400 hover:border-emerald-500/50 transition-colors"
                                >⬇ Download</button>
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
          </section>

          <DividerScrollbar onResizeStart={() => startDrag("center")} sectionRef={centerSectionRef} />

          {/* Analytics column — slides in/out to the right */}
          <div className="relative min-w-0 h-full overflow-hidden rounded-xl">
            {/* Re-open strip — fills the entire 16 px column when analytics is hidden */}
            <button
              onClick={() => setAnalyticsVisible(true)}
              title="Show Analytics"
              style={{
                opacity: analyticsVisible ? 0 : 1,
                pointerEvents: analyticsVisible ? "none" : "auto",
                transition: "opacity 0.15s 0.15s ease",
              }}
              className="absolute inset-0 z-20 flex items-center justify-center rounded-xl border border-slate-700/60 bg-[var(--ats-bg-section)] text-[10px] text-slate-500 hover:text-blue-400 hover:border-blue-500/50 transition-colors"
            >‹</button>
            {/* ── Right panel: Analytics | Synthesis Lab ── */}
            <aside
              className="absolute inset-0 flex flex-col rounded-xl bg-[var(--ats-bg-section)] overflow-hidden"
              style={{
                transform: analyticsVisible ? "translateX(0)" : "translateX(105%)",
                transition: "transform 0.35s cubic-bezier(0.4,0,0.2,1)",
              }}
            >
              {/* Tab bar */}
              <div className="shrink-0 flex items-center gap-1 border-b border-slate-800/80 px-3 pt-3">
                <button
                  onClick={() => setRightTab("analytics")}
                  className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-2xl font-bold transition-colors ${
                    rightTab === "analytics"
                      ? "bg-slate-900/70 text-slate-100 border-b-2 border-blue-500 -mb-px"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >📊 Analytics</button>
                <button
                  onClick={() => setRightTab("lab")}
                  className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-2xl font-bold transition-colors ${
                    rightTab === "lab"
                      ? "bg-slate-900/70 text-slate-100 border-b-2 border-violet-500 -mb-px"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  ✍️ Synthesis Lab
                  {labRefs.length > 0 && (
                    <span className="ml-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-xs text-violet-400 font-bold">{labRefs.length}</span>
                  )}
                </button>
                <button
                  onClick={() => setAnalyticsVisible(false)}
                  title="Hide panel"
                  className="ml-auto mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-slate-700/60 bg-slate-900/40 text-xs text-slate-500 hover:border-blue-500/50 hover:text-blue-400 transition-all"
                >›</button>
              </div>

              {/* ── Analytics content ── */}
              <div className={`flex-1 min-h-0 overflow-y-auto thin-scrollbar ${rightTab === "analytics" ? "" : "hidden"}`}>
                <div className="px-4 pt-3 pb-1">
                  <div className="text-xs text-slate-500">
                    {displayedPapers.length > 0
                      ? `${displayedPapers.length} paper${displayedPapers.length !== 1 ? "s" : ""} · ${fastMode ? "Fast" : "Deep"} mode`
                      : "Run a search to populate charts"}
                  </div>
                </div>
                <div className="px-4 pb-4">
                  <PaperCharts papers={displayedPapers} wide={rightPct > 50} />
                </div>
              </div>

              {/* ── Synthesis Lab content ── */}
              <div className={`flex-1 min-h-0 overflow-y-auto thin-scrollbar ${rightTab === "lab" ? "" : "hidden"}`}>
                <div className="px-4 py-4 space-y-4">

                  {/* References */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-semibold text-slate-200">📚 References</span>
                      <span className="text-xs text-slate-500">{labRefs.length} added</span>
                    </div>
                    {labRefs.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-700 py-4 text-center text-xs text-slate-600 leading-6">
                        Click <span className="text-violet-400 font-semibold">+ Lab</span> on any<br/>paper in the list to add it
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {labRefs.map(({ key, paper }) => (
                          <div key={key} className="flex items-start gap-2 rounded-lg border border-slate-800/60 bg-slate-900/50 px-3 py-2">
                            <span className="flex-1 text-xs text-slate-300 leading-5 break-words line-clamp-2">{paper.title}</span>
                            <button onClick={() => removeFromLab(key)} className="shrink-0 mt-0.5 text-slate-600 hover:text-rose-400 transition-colors text-xs">✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="h-px bg-slate-800" />

                  {/* User file upload */}
                  <div>
                    <label className="text-sm font-semibold text-slate-200">📎 Upload Your Files</label>
                    <p className="mt-0.5 text-xs text-slate-500">PDF, TXT, MD — drag & drop or click</p>
                    <label
                      className="mt-2 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-3 py-4 text-xs text-slate-500 transition hover:border-violet-500/50 hover:text-violet-400"
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
                      <span className="text-lg">📂</span>
                      <span>Drop files here or click to choose</span>
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

                  <div className="h-px bg-slate-800" />

                  {/* Core argument */}
                  <div>
                    <label className="text-sm font-semibold text-slate-200">✏️ Core Argument</label>
                    <textarea
                      value={labCoreArg}
                      onChange={e => setLabCoreArg(e.target.value)}
                      placeholder="State your main thesis or research question…"
                      rows={3}
                      className="mt-2 w-full resize-y rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-violet-500 placeholder:text-slate-600"
                    />
                  </div>

                  {/* Supporting points */}
                  <div>
                    <label className="text-sm font-semibold text-slate-200">📌 Supporting Points</label>
                    <div className="mt-2 space-y-2">
                      {labPoints.map((pt, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <input
                            value={pt}
                            onChange={e => setLabPoints(prev => prev.map((p, j) => j === i ? e.target.value : p))}
                            placeholder={`Point ${i + 1}…`}
                            className="flex-1 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500 placeholder:text-slate-600"
                          />
                          {labPoints.length > 1 && (
                            <button onClick={() => setLabPoints(prev => prev.filter((_, j) => j !== i))} className="shrink-0 text-slate-600 hover:text-rose-400 transition-colors">✕</button>
                          )}
                        </div>
                      ))}
                      <button onClick={() => setLabPoints(prev => [...prev, ""])} className="text-xs text-slate-500 hover:text-violet-400 transition-colors">+ Add Point</button>
                    </div>
                  </div>

                  <div className="h-px bg-slate-800" />

                  {/* Output type */}
                  <div>
                    <label className="text-sm font-semibold text-slate-200">📄 Output Type</label>
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

                  {/* Target pages */}
                  <div>
                    <label className="text-sm font-semibold text-slate-200">📏 Target Length</label>
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

                  {/* Citation format */}
                  <div>
                    <label className="text-sm font-semibold text-slate-200">📑 Citation Format</label>
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
                    <label className="text-sm font-semibold text-slate-200">🌐 Output Language</label>
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

                  {/* Generate / Stop row */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => void handleSynthesize()}
                      disabled={labRefs.length === 0 || labGenerating}
                      className={`flex-1 rounded-xl px-4 py-3 text-sm font-bold transition-all disabled:cursor-not-allowed ${
                        labGenerating
                          ? "border border-violet-500/40 bg-violet-500/10 text-violet-300 animate-pulse"
                          : "bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40"
                      }`}
                    >{labGenerating ? "🔮 Composing…" : "🔮 Generate Academic Text"}</button>
                    {labGenerating && (
                      <button
                        onClick={handleLabStop}
                        className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-3 text-sm font-bold text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-all"
                        title="Stop generation"
                      >⏹ Stop</button>
                    )}
                  </div>

                  {/* Writing model selector (collapsible) */}
                  <div>
                    <button
                      onClick={() => setLabModelOpen(o => !o)}
                      className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      <span>{labModelOpen ? "▾" : "▸"}</span>
                      <span>Writing model: <span className="text-violet-400 font-semibold">{labWritingModel === "claude" ? "Claude Sonnet" : labWritingModel}</span></span>
                    </button>
                    {labModelOpen && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {[
                          { id: "gpt-4o-mini", label: "GPT-4o mini", desc: "Fast · default" },
                          { id: "gpt-4o",      label: "GPT-4o",      desc: "Powerful · slower" },
                          { id: "claude",      label: "Claude Sonnet", desc: "Anthropic" },
                        ].map(m => (
                          <button
                            key={m.id}
                            onClick={() => setLabWritingModel(m.id)}
                            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all ${labWritingModel === m.id ? "border-violet-500/60 bg-violet-500/15 text-violet-300" : "border-slate-700 bg-slate-900/40 text-slate-400 hover:border-slate-600 hover:text-slate-200"}`}
                          >
                            {m.label}
                            <span className="ml-1 font-normal text-slate-500">{m.desc}</span>
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

                  {/* Agent activity panel */}
                  {(labGenerating || labAgentLog.length > 0) && (
                    <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 px-3 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <button
                          onClick={() => setLabAgentLogOpen(o => !o)}
                          className="flex items-center gap-1.5 text-xs font-bold text-violet-400 hover:text-violet-300 transition-colors"
                        >
                          <span>{labAgentLogOpen ? "▾" : "▸"}</span>
                          🤖 Agent Activity
                          {!labAgentLogOpen && labAgentLog.length > 0 && (
                            <span className="text-slate-500 font-normal">({labAgentLog.length} agents)</span>
                          )}
                        </button>
                        {labGenerating && (
                          <span className="text-xs text-slate-500 animate-pulse ml-1">{labStatus.replace(/^\[[^\]]+\]\s*/, "") || "Running…"}</span>
                        )}
                      </div>
                      {labAgentLogOpen && (
                      <div>
                      {labAgentLog.length === 0 && labGenerating && (
                        <div className="text-xs text-slate-600 animate-pulse">Initialising…</div>
                      )}
                      <div className="space-y-1 mt-1.5">
                        {labAgentLog.map(entry => {
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
                          const icon =
                            entry.done     ? "✓" :
                            entry.error    ? "✗" :
                            entry.revision ? (entry.msg.startsWith("↩") ? "↩" : "↺") :
                            <span className="inline-block animate-pulse">▶</span>;
                          return (
                            <div key={entry.name} className="flex items-start gap-2 py-0.5">
                              <span className={`shrink-0 text-xs mt-0.5 ${iconColor}`}>{icon}</span>
                              <div className="min-w-0">
                                <span className={`text-xs font-semibold ${nameColor}`}>{entry.name}</span>
                                <span className="text-xs text-slate-500 ml-1.5 break-words">
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
                  {labResult && (
                    <div>
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="text-sm font-semibold text-slate-200">Generated Text</span>
                        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                          {/* Quick copy */}
                          <button
                            onClick={() => void navigator.clipboard.writeText(labResult)}
                            className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-500 hover:text-blue-400 hover:border-blue-500/50 transition-colors"
                          >📋 Copy</button>
                          {/* Format selector */}
                          <select
                            value={labDownloadFormat}
                            onChange={e => setLabDownloadFormat(e.target.value as "pdf"|"html"|"txt"|"md")}
                            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-400 focus:outline-none focus:border-emerald-500/60"
                          >
                            <option value="pdf">PDF</option>
                            <option value="html">HTML</option>
                            <option value="md">Markdown</option>
                            <option value="txt">TXT</option>
                          </select>
                          {/* Download */}
                          {!labGenerating && (
                            <button
                              onClick={() => {
                                const outputLabel = ({
                                  literature_review:     "Literature_Review",
                                  theoretical_framework: "Theoretical_Framework",
                                  research_proposal:     "Research_Proposal",
                                  discussion:            "Discussion",
                                  introduction:          "Introduction",
                                  conclusion:            "Conclusion",
                                  abstract:              "Abstract",
                                  argumentative_essay:   "Academic_Essay",
                                } as Record<string,string>)[labOutputType] ?? "Output";
                                const slug = (labCoreArg || "synthesis").replace(/\s+/g, "_").replace(/[^\w_]/g, "").slice(0, 40);
                                const filename = `${outputLabel}_${slug}`;
                                if (labDownloadFormat === "pdf") {
                                  void triggerDownload(buildApiUrl("/api/text/to-pdf"), {
                                    text: labResult,
                                    title: outputLabel.replace(/_/g, " "),
                                  }, `${filename}.pdf`, "lab-download-pdf");
                                } else {
                                  downloadTextAs(labResult, filename, labDownloadFormat as "html"|"txt"|"md");
                                }
                              }}
                              className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-500 hover:text-emerald-400 hover:border-emerald-500/50 transition-colors"
                            >⬇ Download</button>
                          )}
                        </div>
                      </div>
                      <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 px-4 py-3 text-sm text-slate-200 leading-7 whitespace-pre-wrap break-words">
                        {labResult}
                        {labGenerating && <span className="inline-block ml-0.5 h-4 w-0.5 rounded-sm bg-violet-400 animate-pulse align-text-bottom" />}
                      </div>
                    </div>
                  )}

                  {/* Reviewer Notes — collapsible improvement feedback */}
                  {labReviewerNotes && (
                    <div className="rounded-xl border border-amber-500/25 bg-amber-500/5">
                      <button
                        onClick={() => setLabNotesOpen(o => !o)}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-bold text-amber-400 hover:text-amber-300 transition-colors"
                      >
                        <span>{labNotesOpen ? "▾" : "▸"}</span>
                        💡 Reviewer Improvement Notes
                        {!labNotesOpen && <span className="text-slate-500 font-normal">(click to expand)</span>}
                      </button>
                      {labNotesOpen && (
                        <div className="px-3 pb-3 space-y-2.5">
                          {labReviewerNotes.citation_gaps?.length > 0 && (
                            <div>
                              <div className="text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1">📌 Citation Gaps</div>
                              <ul className="space-y-1">
                                {labReviewerNotes.citation_gaps.map((note, i) => (
                                  <li key={i} className="text-xs text-slate-400 flex gap-1.5"><span className="text-amber-500 shrink-0">·</span>{note}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {labReviewerNotes.data_suggestions?.length > 0 && (
                            <div>
                              <div className="text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1">📊 Data &amp; Evidence</div>
                              <ul className="space-y-1">
                                {labReviewerNotes.data_suggestions.map((note, i) => (
                                  <li key={i} className="text-xs text-slate-400 flex gap-1.5"><span className="text-amber-500 shrink-0">·</span>{note}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {labReviewerNotes.argument_suggestions?.length > 0 && (
                            <div>
                              <div className="text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1">🎯 Core Argument</div>
                              <ul className="space-y-1">
                                {labReviewerNotes.argument_suggestions.map((note, i) => (
                                  <li key={i} className="text-xs text-slate-400 flex gap-1.5"><span className="text-amber-500 shrink-0">·</span>{note}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {labReviewerNotes.supporting_points?.length > 0 && (
                            <div>
                              <div className="text-[11px] font-semibold text-amber-400/80 uppercase tracking-wide mb-1">➕ Suggested Supporting Points</div>
                              <ul className="space-y-1">
                                {labReviewerNotes.supporting_points.map((note, i) => (
                                  <li key={i} className="text-xs text-slate-400 flex gap-1.5"><span className="text-amber-500 shrink-0">·</span>{note}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>

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
                          <p className="text-[10px] text-blue-400 mt-0.5">Alpha Member</p>
                        </div>
                      </div>
                    </div>

                    {/* Menu items */}
                    <div className="py-1.5">
                      {([
                        { key: "profile",      label: "Profile" },
                        { key: "accounts",     label: "Accounts" },
                        { key: "settings",     label: "Settings" },
                        { key: "subscription", label: "Subscription" },
                        { key: "help",         label: "Help" },
                      ] as const).map(({ key, label }) => (
                        <button
                          key={key}
                          onClick={() => { setUserPanel(key); setUserMenuOpen(false); }}
                          className="w-full flex items-center px-4 py-2 text-sm text-slate-300 hover:bg-slate-800/60 hover:text-slate-100 transition-colors text-left"
                        >
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
                        onClick={() => { supabase.auth.signOut(); setAuthUser(null); setUserMenuOpen(false); }}
                        className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors text-left"
                      >
                        <span className="text-base w-5 text-center">→</span>
                        Sign out
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* Avatar button + History button */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setUserMenuOpen(o => !o)}
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
                const next = Math.max(120, Math.min(window.innerHeight * 0.85, historyDragRef.current.startH + delta));
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
                    // Dot color: blue = newest (i===0), green = search with understand, amber = direct search or understand-only
                    const dotCls = i === 0
                      ? "border-blue-500 bg-blue-500/40"
                      : (item.entryType === "search" && item.usedUnderstand)
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

      {/* ── User panel modals ─────────────────────────────────────────────────── */}
      {userPanel && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" onClick={() => setUserPanel(null)}>
          <div className="w-full max-w-md rounded-2xl border border-slate-700/60 bg-slate-900 shadow-2xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50">
              <h2 className="text-base font-semibold text-slate-100">
                {userPanel === "profile"      && "Profile"}
                {userPanel === "accounts"     && "Accounts"}
                {userPanel === "settings"     && "Settings"}
                {userPanel === "subscription" && "Subscription"}
                {userPanel === "help"         && "Help"}
              </h2>
              <button onClick={() => setUserPanel(null)} className="text-slate-500 hover:text-slate-300 transition-colors text-lg leading-none">✕</button>
            </div>

            {/* Body */}
            <div className="px-6 py-5">

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
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl bg-slate-800/50 px-4 py-3">
                    <div>
                      <p className="text-sm text-slate-200">Theme</p>
                      <p className="text-xs text-slate-500 mt-0.5">Dark / Light mode</p>
                    </div>
                    <button
                      onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
                      className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-400 hover:border-blue-500/50 hover:text-blue-400 transition-colors"
                    >
                      {theme === "dark" ? "🌙 Dark" : "☀️ Light"}
                    </button>
                  </div>
                  <div className="flex items-center justify-between rounded-xl bg-slate-800/50 px-4 py-3">
                    <div>
                      <p className="text-sm text-slate-200">Default Paper Count</p>
                      <p className="text-xs text-slate-500 mt-0.5">Papers returned per search</p>
                    </div>
                    <span className="text-sm text-slate-300 font-mono">{paperCount}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-xl bg-slate-800/50 px-4 py-3">
                    <div>
                      <p className="text-sm text-slate-200">Fast Mode</p>
                      <p className="text-xs text-slate-500 mt-0.5">Quick results vs deep analysis</p>
                    </div>
                    <span className={`text-xs font-semibold px-2 py-1 rounded-full ${fastMode ? "bg-blue-500/20 text-blue-400" : "bg-slate-700 text-slate-400"}`}>
                      {fastMode ? "On" : "Off"}
                    </span>
                  </div>
                </div>
              )}

              {userPanel === "subscription" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-4">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-lg">💎</span>
                      <span className="text-sm font-bold text-blue-300">Alpha Access</span>
                    </div>
                    <p className="text-xs text-slate-400">You have full access to all features during the Alpha period.</p>
                  </div>
                  <div className="space-y-2 text-xs text-slate-400">
                    {["Unlimited searches", "Multi-agent deep analysis", "PDF export", "Synthesis Lab", "Early access to new features"].map(f => (
                      <div key={f} className="flex items-center gap-2">
                        <span className="text-green-400">✓</span>
                        {f}
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-600">Paid plans coming after Alpha. Your feedback shapes the pricing.</p>
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

                  {/* Saved accounts */}
                  {savedAccounts.length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-2">Saved accounts</p>
                      <div className="space-y-1.5">
                        {savedAccounts.map(acct => {
                          const isCurrent = acct.email === authUser?.email;
                          const isLoading = acctSwitching === acct.email;
                          return (
                            <div key={acct.email} className={`flex items-center gap-2 rounded-xl px-3 py-2 ${isCurrent ? "bg-blue-500/10 border border-blue-500/20" : "bg-slate-800/40"}`}>
                              <div className="h-6 w-6 rounded-full bg-slate-700 flex items-center justify-center text-slate-300 text-[10px] font-bold shrink-0">
                                {acct.email[0].toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-slate-200 truncate">{acct.email}</p>
                                <p className="text-[9px] text-slate-500">{acct.type === "dev" ? "Dev · password login" : "OTP · magic link"}</p>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {!isCurrent && (
                                  <button
                                    onClick={() => switchToAccount(acct)}
                                    disabled={acctSwitching !== null}
                                    className="text-[10px] text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors font-medium"
                                  >{isLoading ? "…" : "Switch"}</button>
                                )}
                                {isCurrent && <span className="text-[9px] text-blue-400">Active</span>}
                                <button
                                  onClick={() => removeSavedAccount(acct.email)}
                                  className="text-[10px] text-slate-600 hover:text-red-400 transition-colors ml-1"
                                  title="Remove"
                                >✕</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
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
                    <div className="flex gap-2 opacity-40 cursor-not-allowed">
                      <input
                        type="email"
                        disabled
                        placeholder="email@example.com"
                        className="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-1.5 text-xs text-slate-500 placeholder-slate-700 cursor-not-allowed"
                      />
                      <button
                        disabled
                        className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-600 cursor-not-allowed shrink-0"
                      >Add</button>
                    </div>
                    <p className="text-[9px] text-slate-600 mt-1.5">
                      Email login coming soon · use Google to sign in
                    </p>
                  </div>
                </div>
              )}

              {userPanel === "help" && (
                <div className="space-y-3">
                  {[
                    { icon: "📖", title: "How to search", desc: "Enter a research question and click Run Search or Quick Search." },
                    { icon: "🧪", title: "Synthesis Lab", desc: "Select papers from results, then generate a literature review or proposal." },
                    { icon: "📄", title: "Deep Read", desc: "Click Deep Read on any paper to get a full structured analysis." },
                    { icon: "✉️", title: "Contact us", desc: "Email jy1529098645@gmail.com for feedback or support." },
                  ].map(({ icon, title, desc }) => (
                    <div key={title} className="rounded-xl bg-slate-800/50 px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span>{icon}</span>
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
  );
}
