"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PaperReviewPanel — second module inside the right-panel Lab, parallel to
// the Synthesis Lab writer. Sends a user-submitted draft through the backend
// multi-agent peer review pipeline (paper_review_service.py) and renders:
//   · streaming agent activity log (same visual language as Synthesis Lab)
//   · the Chief Editor's review letter (Markdown, streamed in)
//   · a dashboard of specialist scores + cross-check top issues + verdict
//
// Theme: every colour resolves through --ats-* tokens (same system the rest
// of the app uses), so day / night / Morning Mint / Warm Paper / Daylight
// Blue all tint this panel automatically. Previously used hard-coded
// slate/violet/amber Tailwind classes which clashed with light themes.
//
// Shares its daily allowance with Synthesis Lab (both are heavy LLM flows).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Upload, FolderOpen, FileText, Sparkles, Square, Bot,
  ChevronDown, ChevronRight, ClipboardList, Check, X as XIcon, Play,
  Award, Gauge, AlertTriangle, Clock,
  ThumbsUp, Target, Globe, Lightbulb,
} from "lucide-react";
import { fetchWithApiFallback } from "@/lib/api";

type Severity = "low" | "medium" | "high";

type SpecialistIssue = {
  quote?:      string;
  location?:   string;
  problem?:    string;
  suggestion?: string;
  priority?:   Severity;
};

type SpecialistReview = {
  severity: Severity;
  score:    number;
  summary:  string;
  strengths: string[];
  issues:    SpecialistIssue[];
};

type TopIssue = {
  title:      string;
  lenses:     string[];
  problem:    string;
  suggestion: string;
  priority:   Severity;
};

type Scorecard = {
  dimensions: Record<string, { name: string; score: number; severity: Severity }>;
  overall_score:    number;
  verdict:          string;
  one_line_summary: string;
};

type ReviewBundle = {
  intake?: {
    paper_type?:   string;
    field?:        string;
    thesis?:       string;
    section_map?:  string[];
    audience?:     string;
    obvious_gaps?: string[];
  };
  reviews?:    Record<string, SpecialistReview>;
  crosscheck?: {
    top_issues?:          TopIssue[];
    contradictions?:      string[];
    consensus_strengths?: string[];
    priority_order?:      string[];
  };
  scorecard?: Scorecard;
};

type AgentLogEntry = {
  name:     string;
  msg:      string;
  done:     boolean;
  error:    boolean;
  revision: boolean;
};

const LANGUAGE_OPTIONS = [
  "English", "Chinese (Simplified)", "Chinese (Traditional)",
  "Japanese", "Korean", "Spanish", "French", "German",
  "Portuguese", "Arabic",
];

// Draft types drive the context the specialists use when reviewing. Each
// entry maps to a short hint that the intake agent + specialists fold into
// their prompts, so a research proposal gets different critique focus than
// an argumentative essay. Labels are plain-English — no jargon.
const DRAFT_TYPES: Array<{ id: string; label: string; hint: string }> = [
  { id: "auto",                 label: "Let reviewers infer",    hint: "" },
  { id: "research_paper",       label: "Research paper",         hint: "Full empirical / theoretical research paper — expect Methods, Results, Discussion." },
  { id: "literature_review",    label: "Literature review",      hint: "A synthesis of prior work. Weight the review of coverage + organisation." },
  { id: "research_proposal",    label: "Research proposal",      hint: "Proposal for future work. Weight research-question clarity + feasibility." },
  { id: "thesis_dissertation",  label: "Thesis / dissertation section", hint: "A chapter or section of a longer thesis — expect deeper scaffolding." },
  { id: "essay",                label: "Academic essay",         hint: "Argumentative essay. Weight thesis strength + paragraph-level logic." },
  { id: "abstract",             label: "Abstract",               hint: "A short (<= 300 word) abstract. Weight compression + information density." },
  { id: "introduction",         label: "Introduction section",   hint: "Opening section of a paper — weight gap statement + motivation." },
  { id: "discussion",           label: "Discussion section",     hint: "Discussion / interpretation section — weight alignment with evidence." },
  { id: "grant_application",    label: "Grant application",      hint: "Grant proposal — weight significance, innovation, feasibility." },
  { id: "conference_paper",     label: "Conference paper",       hint: "Short conference submission — tighter word budget than a journal paper." },
  { id: "other",                label: "Other / I'm not sure",   hint: "" },
];

const SEVERITY_STYLES: Record<Severity, { fg: string; bg: string; border: string; label: string }> = {
  low:    { fg: "var(--ats-fg-accent)", bg: "var(--ats-bg-accent-soft)", border: "var(--ats-border-accent)", label: "low" },
  medium: { fg: "#d97706",              bg: "rgba(217,119,6,0.10)",      border: "rgba(217,119,6,0.40)",      label: "medium" },
  high:   { fg: "#ef4444",              bg: "rgba(239,68,68,0.10)",      border: "rgba(239,68,68,0.40)",      label: "high" },
};

// Verdict colour is SCORE-DRIVEN, not verdict-string-driven. The backend
// still emits "Accept" / "Minor Revision" / "Major Revision" / "Reject" as
// verdict labels, but a user-facing insight the label alone doesn't give
// is HOW BAD inside a band. Score breakpoints at 4 / 6 / 8 map to four
// traffic-light tiers:
//
//   score <  4        → red      (serious rework needed)
//   4 ≤ score <  6    → orange   (material revision required)
//   6 ≤ score <  8    → blue     (a few targeted fixes)
//   score ≥ 8         → green    (strong, minor polish)
//
// Hexes are chosen in the 500-600 luminance band so they keep ≥ AA contrast
// against BOTH the day themes' near-white backgrounds and the night themes'
// deep navy. This mirrors how we handle notification badges — theme-
// invariant semantic colours sitting on top of theme-tinted surfaces. The
// 10% / 40% alpha tiers for bg / border follow the same pattern used by
// every other status chip in the product.

type ScoreStyle = { fg: string; bg: string; border: string };

function scoreStyle(score: number): ScoreStyle {
  if (!Number.isFinite(score)) {
    return { fg: "var(--ats-fg-muted)", bg: "var(--ats-bg-panel)", border: "var(--ats-border-subtle)" };
  }
  if (score < 4) {
    // red-600 — serious, can't ship
    return { fg: "#dc2626", bg: "rgba(220,38,38,0.10)", border: "rgba(220,38,38,0.40)" };
  }
  if (score < 6) {
    // orange-600 — material rework
    return { fg: "#ea580c", bg: "rgba(234,88,12,0.10)", border: "rgba(234,88,12,0.40)" };
  }
  if (score < 8) {
    // blue-600 — targeted fixes
    return { fg: "#2563eb", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.40)" };
  }
  // green-600 — strong
  return { fg: "#16a34a", bg: "rgba(22,163,74,0.10)", border: "rgba(22,163,74,0.40)" };
}

// Shared input classes — match the Synthesis Lab form fields so the two
// modules feel like siblings (same corners, padding, border, focus ring).
const INPUT_CLS =
  "w-full rounded-xl border px-3 py-2 text-sm outline-none transition-colors";
const INPUT_STYLE: React.CSSProperties = {
  borderColor:     "var(--ats-border-subtle)",
  backgroundColor: "var(--ats-bg-input)",
  color:           "var(--ats-fg-primary)",
};

export function PaperReviewPanel() {
  const [paperText,    setPaperText]    = useState("");
  const [contextHint,  setContextHint]  = useState("");
  const [draftType,    setDraftType]    = useState("auto");
  const [language,     setLanguage]     = useState("English");
  const [fileName,     setFileName]     = useState("");
  const [extractBusy,  setExtractBusy]  = useState(false);
  const [extractError, setExtractError] = useState("");

  const [generating, setGenerating] = useState(false);
  const [status,     setStatus]     = useState("");
  const [result,     setResult]     = useState("");
  const [bundle,     setBundle]     = useState<ReviewBundle | null>(null);
  const [error,      setError]      = useState("");
  // 429 is special: shown as a friendlier callout with a "Sign in" nudge
  // when anonymous. Distinct from `error` so the shape/copy can diverge.
  const [quotaBlocked, setQuotaBlocked] = useState<{ message: string } | null>(null);
  const [agentLog,   setAgentLog]   = useState<AgentLogEntry[]>([]);
  const [copied,     setCopied]     = useState(false);
  const [agentLogOpen, setAgentLogOpen] = useState(true);

  const abortRef = useRef<AbortController | null>(null);

  // ── File extraction ────────────────────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    if (!/\.(pdf|txt|md)$/i.test(file.name)) {
      setExtractError("Only .pdf, .txt, and .md files are supported.");
      return;
    }
    setExtractBusy(true);
    setExtractError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetchWithApiFallback("/api/forge/review-paper/extract-text", {
        method: "POST",
        body:   fd,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json() as { text: string; filename: string; char_count: number };
      setPaperText(data.text);
      setFileName(data.filename);
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtractBusy(false);
    }
  }, []);

  // ── Run review ─────────────────────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    const text = paperText.trim();
    if (!text) {
      setError("Paste a draft or upload a file first.");
      return;
    }
    if (generating) return;

    // Fold the selected draft type into the context hint so the backend
    // intake agent + specialists anchor to the right rubric. User-entered
    // context still wins; the type hint is appended only if room is left.
    const typeMeta = DRAFT_TYPES.find(t => t.id === draftType);
    const effectiveContext = [
      typeMeta && typeMeta.id !== "auto" && typeMeta.id !== "other"
        ? `Draft type: ${typeMeta.label}. ${typeMeta.hint}`
        : "",
      contextHint.trim(),
    ].filter(Boolean).join(" ").slice(0, 1800);

    const ac = new AbortController();
    abortRef.current = ac;
    setGenerating(true);
    setResult("");
    setBundle(null);
    setAgentLog([]);
    setError("");
    setQuotaBlocked(null);
    setStatus("Starting review…");

    try {
      const res = await fetchWithApiFallback("/api/forge/review-paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal:  ac.signal,
        body:    JSON.stringify({ paper_text: text, context_hint: effectiveContext, language }),
      });
      if (res.status === 429) {
        // Quota exhausted — parse the server's friendly explanation
        // and show a sign-in nudge rather than a raw HTTP error.
        let detail = "Daily allowance reached.";
        try {
          const body = await res.json() as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch { /* body wasn't JSON */ }
        setQuotaBlocked({ message: detail });
        return;
      }
      if (!res.ok || !res.body) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const reader  = res.body.getReader();
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
            if (obj.chunk) setResult(prev => prev + obj.chunk);
            if (obj.error) setError(obj.error);
            if (obj.status) {
              setStatus(obj.status);
              const m = obj.status.match(/^\[([^\]]+)\]\s*(.*)/);
              if (m) {
                const name = m[1];
                const msg  = m[2];
                if (name === "FinalReview" && !msg.startsWith("✓") && !msg.startsWith("✗")) {
                  try {
                    setBundle(JSON.parse(msg) as ReviewBundle);
                  } catch { /* ignore */ }
                } else {
                  const isDone     = msg.startsWith("✓");
                  const isError    = msg.startsWith("✗");
                  const isRevision = msg.startsWith("↩") || msg.startsWith("↺");
                  setAgentLog(prev => {
                    const idx = prev.findIndex(e => e.name === name);
                    const entry: AgentLogEntry = {
                      name, msg, done: isDone, error: isError, revision: isRevision,
                    };
                    return idx >= 0
                      ? prev.map((e, i) => i === idx ? entry : e)
                      : [...prev, entry];
                  });
                }
              }
            }
          } catch { /* malformed SSE line — skip */ }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setStatus("Stopped.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      setGenerating(false);
      setStatus("");
    }
  }, [paperText, contextHint, draftType, language, generating]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  // Layout matches the Synthesis Lab spacing / section rhythm so switching
  // between the two tabs feels consistent — same gap between blocks, same
  // divider pattern, same button styling.
  return (
    <div className="px-4 py-4 space-y-4" style={{ color: "var(--ats-fg-primary)" }}>
      {/* ── Upload ────────────────────────────────────────────────────────── */}
      <div>
        <label className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
          <Upload size={14} /><span>Upload your draft</span>
        </label>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>PDF, TXT, or Markdown. Drag-and-drop works too.</p>
        <label
          className="mt-1.5 flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed px-3 py-2.5 text-xs transition"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-input)",
            color:           "var(--ats-fg-muted)",
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.style.borderColor = "var(--ats-border-accent)";
            e.currentTarget.style.backgroundColor = "var(--ats-bg-accent-soft)";
          }}
          onDragLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--ats-border-subtle)";
            e.currentTarget.style.backgroundColor = "var(--ats-bg-input)";
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.style.borderColor = "var(--ats-border-subtle)";
            e.currentTarget.style.backgroundColor = "var(--ats-bg-input)";
            const f = e.dataTransfer.files[0];
            if (f) void handleFile(f);
          }}
        >
          <FolderOpen size={18} style={{ color: "var(--ats-fg-secondary)" }} />
          <span>{extractBusy ? "Reading file…" : (fileName || "Drop a file or click to choose")}</span>
          <input
            type="file"
            accept=".pdf,.txt,.md"
            className="hidden"
            disabled={extractBusy || generating}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
          />
        </label>
        {extractError && (
          <div className="mt-1.5 text-[11px]" style={{ color: "#ef4444" }}>{extractError}</div>
        )}
      </div>

      <div className="h-px" style={{ backgroundColor: "var(--ats-border-subtle)" }} />

      {/* ── Text area ────────────────────────────────────────────────────── */}
      <div>
        <label className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
          <FileText size={14} /><span>Or paste your draft</span>
        </label>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>
          {paperText.length > 0 && `${paperText.length.toLocaleString()} chars · `}
          Uploading a file replaces the contents.
        </p>
        <textarea
          value={paperText}
          onChange={e => setPaperText(e.target.value)}
          placeholder="Paste the full text of your paper, essay, or draft section here…"
          rows={10}
          disabled={generating}
          className={`${INPUT_CLS} mt-2 resize-y hairline-scrollbar disabled:opacity-70`}
          style={INPUT_STYLE}
        />
      </div>

      {/* ── Draft type ───────────────────────────────────────────────────── */}
      <div>
        <label className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
          <Lightbulb size={14} /><span>What kind of draft is this?</span>
        </label>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>
          Different kinds of writing get reviewed with different priorities.
        </p>
        <select
          value={draftType}
          onChange={e => setDraftType(e.target.value)}
          disabled={generating}
          className={`${INPUT_CLS} mt-2`}
          style={INPUT_STYLE}
        >
          {DRAFT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      {/* ── Context hint ─────────────────────────────────────────────────── */}
      <div>
        <label className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
          <Target size={14} /><span>Anything else we should know?</span>
        </label>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>Field, target venue, specific concerns — optional.</p>
        <input
          value={contextHint}
          onChange={e => setContextHint(e.target.value)}
          placeholder="e.g. computational linguistics, aiming for ACL short paper"
          disabled={generating}
          className={`${INPUT_CLS} mt-2 disabled:opacity-70`}
          style={INPUT_STYLE}
        />
      </div>

      {/* ── Language ─────────────────────────────────────────────────────── */}
      <div>
        <label className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
          <Globe size={14} /><span>Feedback language</span>
        </label>
        <select
          value={language}
          onChange={e => setLanguage(e.target.value)}
          disabled={generating}
          className={`${INPUT_CLS} mt-2`}
          style={INPUT_STYLE}
        >
          {LANGUAGE_OPTIONS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>

      {/* ── Run / Stop ───────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <button
          onClick={() => void handleRun()}
          disabled={!paperText.trim() || generating}
          title="Shares your daily allowance with the Synthesis Lab writer."
          className="relative flex-1 rounded-xl px-4 py-3 text-sm font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden"
          style={{
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor:     generating ? "var(--ats-border-accent)" : "transparent",
            backgroundColor: generating ? "var(--ats-bg-accent-soft)" : "var(--ats-fg-accent)",
            color:           generating ? "var(--ats-fg-accent)" : "var(--ats-bg-panel)",
          }}
        >
          <span className="flex items-center justify-center gap-1.5">
            <Sparkles size={14} className={generating ? "animate-spin" : ""} />
            {generating ? "Reviewing…" : "Run peer review"}
          </span>
          {/* Sliding indeterminate strip — same `progress-slide` keyframe
              as ProgressStrip in page.tsx. Gives immediate "not frozen"
              feedback the moment the button enters its generating state,
              even before the first agent-log entry arrives. */}
          {generating && (
            <span
              aria-hidden
              className="pointer-events-none absolute left-0 bottom-0 h-[2px] w-full overflow-hidden"
            >
              <span
                className="block h-full w-1/3 rounded-full"
                style={{
                  backgroundColor: "var(--ats-fg-accent)",
                  animation: "progress-slide 1.2s ease-in-out infinite",
                }}
              />
            </span>
          )}
        </button>
        {generating && (
          <button
            onClick={handleStop}
            title="Stop review"
            className="rounded-xl border px-3 py-3 text-sm font-bold transition-all"
            style={{
              borderColor:     "rgba(239,68,68,0.40)",
              backgroundColor: "rgba(239,68,68,0.10)",
              color:           "#ef4444",
            }}
          ><span className="flex items-center gap-1.5"><Square size={14} />Stop</span></button>
        )}
      </div>

      {/* ── Progress bar ─────────────────────────────────────────────────────
          Two layers of reassurance while a review is in flight, matching the
          pattern used in the Synthesis Lab so both tabs feel the same:

          1. The sliding strip on the Run button gives instant "not frozen"
             feedback the moment the user clicks — even before any agent
             status arrives (the first LLM round trip can take 1-3 s).
          2. This determinate bar fills as each agent completes. The total
             is inferred from the running log rather than a hard-coded 10
             because the pipeline emits a variable number of status lines
             (five specialists + intake + cross-check + editor + scorecard +
             final-review checkpoint). Counting DONE vs TOTAL-SO-FAR is the
             same arithmetic Synthesis Lab uses and gives a smooth
             left-to-right fill across the whole run. */}
      {generating && agentLog.length > 0 && (() => {
        const done = agentLog.filter(e => e.done || e.error).length;
        const total = agentLog.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return (
          <div className="space-y-0.5">
            <div className="flex justify-between text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
              <span>{done}/{total} reviewers finished</span>
              <span>{pct}%</span>
            </div>
            <div
              className="h-1.5 w-full rounded-full overflow-hidden"
              style={{ backgroundColor: "var(--ats-border-subtle)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, backgroundColor: "var(--ats-fg-accent)" }}
              />
            </div>
          </div>
        );
      })()}

      {/* ── Quota block ──────────────────────────────────────────────────── */}
      {quotaBlocked && (
        <div
          className="rounded-xl border px-3 py-3 text-xs"
          style={{
            borderColor:     "rgba(217, 119, 6, 0.35)",
            backgroundColor: "rgba(217, 119, 6, 0.08)",
            color:           "#d97706",
          }}
        >
          {/* Lucide Clock instead of the hourglass emoji so the glyph
              renders in a single tone + follows the banner's amber
              colour instead of bringing its own emoji colour palette
              (which clashed with every light theme). */}
          <div className="font-semibold mb-1 flex items-center gap-1.5">
            <Clock size={12} className="shrink-0" />
            <span>Daily allowance reached</span>
          </div>
          <p className="leading-relaxed opacity-90">{quotaBlocked.message}</p>
          <p className="mt-2 text-[11px] opacity-75">
            Paper Review shares a daily allowance with Synthesis Lab (both are heavy LLM flows).
            Signed-in accounts get a bigger allowance; the admin can raise caps per tier.
          </p>
        </div>
      )}

      {/* ── Agent activity ───────────────────────────────────────────────── */}
      {(generating || agentLog.length > 0) && (
        <div
          className="rounded-xl border px-3 py-3"
          style={{
            borderColor:     "var(--ats-border-accent)",
            backgroundColor: "var(--ats-bg-accent-soft)",
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => setAgentLogOpen(o => !o)}
              className="flex items-center gap-1.5 text-xs font-bold transition-colors"
              style={{ color: "var(--ats-fg-accent)" }}
            >
              {agentLogOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <Bot size={12} />
              <span>What the reviewers are doing</span>
              {!agentLogOpen && agentLog.length > 0 && (
                <span className="font-normal" style={{ color: "var(--ats-fg-muted)" }}>({agentLog.length} steps)</span>
              )}
            </button>
            {generating && (
              <span className="text-xs animate-pulse ml-1" style={{ color: "var(--ats-fg-muted)" }}>
                {status.replace(/^\[[^\]]+\]\s*/, "") || "Running…"}
              </span>
            )}
          </div>
          {agentLogOpen && (
            <div className="space-y-1 mt-1.5">
              {agentLog.length === 0 && generating && (
                <div className="text-xs animate-pulse" style={{ color: "var(--ats-fg-muted)" }}>Getting started…</div>
              )}
              {agentLog.map(entry => {
                // Lucide icons match the rest of the product's visual
                // vocabulary — single-tone, sized to the text baseline,
                // themed via `color`. The previous ✓ / ✗ / ▶ characters
                // render in the system text font and looked inconsistent
                // next to the lucide icons used everywhere else in the
                // panel.
                const iconColor =
                  entry.done  ? "#10b981" :
                  entry.error ? "#ef4444" :
                  "var(--ats-fg-accent)";
                const iconNode = entry.done
                  ? <Check size={12} strokeWidth={3} />
                  : entry.error
                    ? <XIcon size={12} strokeWidth={3} />
                    : <Play size={10} fill="currentColor" className="animate-pulse" />;
                return (
                  <div key={entry.name} className="flex items-start gap-2 py-0.5">
                    <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 mt-0.5" style={{ color: iconColor }}>{iconNode}</span>
                    <div className="min-w-0">
                      <span className="text-xs font-semibold" style={{ color: "var(--ats-fg-primary)" }}>{entry.name}</span>
                      <span className="text-xs ml-1.5 break-words" style={{ color: "var(--ats-fg-secondary)" }}>
                        {entry.msg.replace(/^[✓✗▶↩↺]\s*/, "")}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {error && (
        <div
          className="rounded-xl border px-3 py-2 text-xs break-words"
          style={{
            borderColor:     "rgba(239,68,68,0.35)",
            backgroundColor: "rgba(239,68,68,0.10)",
            color:           "#ef4444",
          }}
        >{error}</div>
      )}

      {/* ── Scorecard ────────────────────────────────────────────────────── */}
      {bundle?.scorecard && <ScorecardBlock scorecard={bundle.scorecard} />}

      {/* ── Review letter ───────────────────────────────────────────────── */}
      {result && (
        <div>
          <div className="flex flex-nowrap items-center gap-2 mb-2 overflow-hidden">
            <span className="shrink min-w-0 truncate text-sm font-semibold" style={{ color: "var(--ats-fg-primary)" }}>Review letter</span>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(result);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                } catch { /* blocked */ }
              }}
              className="ml-auto shrink min-w-0 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors"
              style={{
                borderColor: copied ? "rgba(16,185,129,0.5)" : "var(--ats-border-subtle)",
                color:       copied ? "#10b981" : "var(--ats-fg-muted)",
              }}
            >
              {copied
                ? <><Check size={11} strokeWidth={3} className="shrink-0" /><span className="truncate">Copied</span></>
                : <><ClipboardList size={11} className="shrink-0" /><span className="truncate">Copy</span></>}
            </button>
          </div>
          <div
            // `prose-invert` was forcing dark-mode (light) text everywhere
            // inside the review letter — on any day theme the letter
            // rendered as near-white on a light card, completely unreadable.
            // Fix: drop `prose-invert` and override each Tailwind Typography
            // CSS var with an --ats-* token, so the prose colours follow
            // whichever theme is active. Uses `[x] as any` because these
            // CSS custom properties aren't in the React style typings.
            className="rounded-xl border px-4 py-3 prose prose-sm max-w-none prose-p:leading-7 prose-li:my-0.5 prose-ul:my-2 prose-h1:text-base prose-h2:text-sm prose-h3:text-sm break-words"
            style={{
              borderColor:     "var(--ats-border-subtle)",
              backgroundColor: "var(--ats-bg-input)",
              color:           "var(--ats-fg-secondary)",
              ...({
                "--tw-prose-body":       "var(--ats-fg-secondary)",
                "--tw-prose-headings":   "var(--ats-fg-primary)",
                "--tw-prose-lead":       "var(--ats-fg-secondary)",
                "--tw-prose-bold":       "var(--ats-fg-primary)",
                "--tw-prose-links":      "var(--ats-fg-accent)",
                "--tw-prose-bullets":    "var(--ats-fg-muted)",
                "--tw-prose-counters":   "var(--ats-fg-muted)",
                "--tw-prose-quotes":     "var(--ats-fg-secondary)",
                "--tw-prose-code":       "var(--ats-fg-primary)",
                "--tw-prose-hr":         "var(--ats-border-subtle)",
                "--tw-prose-captions":   "var(--ats-fg-muted)",
              } as Record<string, string>),
            }}
          >
            <ReactMarkdown>{result}</ReactMarkdown>
            {generating && <span className="inline-block ml-0.5 h-4 w-0.5 rounded-sm animate-pulse align-text-bottom" style={{ backgroundColor: "var(--ats-fg-accent)" }} />}
          </div>
        </div>
      )}

      {/* ── Details dashboard ───────────────────────────────────────────── */}
      {bundle && <DetailsBlock bundle={bundle} />}
    </div>
  );
}

// ── Scorecard visual block ────────────────────────────────────────────────────
function ScorecardBlock({ scorecard }: { scorecard: Scorecard }) {
  // Verdict tint is derived from the OVERALL SCORE (see scoreStyle above),
  // not from the verdict string — so a "Major Revision" at 5.8 reads
  // orange while a "Major Revision" at 4.2 reads red. The verdict label
  // itself stays unchanged; colour is the second information channel.
  const vs = scoreStyle(scorecard.overall_score);
  const dims = Object.entries(scorecard.dimensions);
  return (
    <div
      className="rounded-xl border px-3 py-3"
      style={{
        borderColor:     vs.border,
        backgroundColor: vs.bg,
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Award size={14} style={{ color: vs.fg }} />
        <span className="text-sm font-bold" style={{ color: vs.fg }}>{scorecard.verdict}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs" style={{ color: "var(--ats-fg-muted)" }}>
          <Gauge size={11} />
          <span className="font-bold" style={{ color: vs.fg }}>{scorecard.overall_score.toFixed(1)}</span>
          <span>/10</span>
        </span>
      </div>
      {scorecard.one_line_summary && (
        <p className="text-xs mb-2.5 italic leading-relaxed" style={{ color: "var(--ats-fg-secondary)" }}>{scorecard.one_line_summary}</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {dims.map(([key, d]) => {
          // Each dimension also gets a score-derived tint — same bands as
          // the overall, so the user can scan four dimension cards and
          // immediately see which ones are pulling the average down.
          const ds = scoreStyle(d.score);
          const pct = Math.max(0, Math.min(100, d.score * 10));
          return (
            <div
              key={key}
              className="rounded-lg border px-2.5 py-1.5"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-input)",
              }}
            >
              <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
                <span className="truncate flex-1">{d.name}</span>
                <span className="shrink-0 text-xs font-bold tabular-nums" style={{ color: ds.fg }}>{d.score}</span>
              </div>
              <div className="mt-1 h-1 w-full rounded-full overflow-hidden" style={{ backgroundColor: "var(--ats-border-subtle)" }}>
                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: ds.fg }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Details dashboard (collapsible) ──────────────────────────────────────────
function DetailsBlock({ bundle }: { bundle: ReviewBundle }) {
  const [open, setOpen] = useState(true);
  const ck = bundle.crosscheck;
  const reviews = bundle.reviews ?? {};
  const intake = bundle.intake;
  const hasAny =
    !!intake ||
    !!(ck?.top_issues?.length) ||
    !!(ck?.consensus_strengths?.length) ||
    !!(ck?.contradictions?.length) ||
    Object.keys(reviews).length > 0;
  if (!hasAny) return null;

  return (
    <div
      className="rounded-xl border"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-accent-soft)",
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-bold transition-colors"
        style={{ color: "var(--ats-fg-accent)" }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <AlertTriangle size={12} />
        <span>Reviewer details</span>
        {!open && <span className="font-normal" style={{ color: "var(--ats-fg-muted)" }}>(click to expand)</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3">
          {/* Intake summary */}
          {intake && (
            <div
              className="rounded-lg border px-3 py-2 text-xs space-y-1"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-input)",
                color:           "var(--ats-fg-secondary)",
              }}
            >
              <div><span style={{ color: "var(--ats-fg-muted)" }}>Type:</span> <span style={{ color: "var(--ats-fg-primary)" }}>{intake.paper_type ?? "?"}</span></div>
              <div><span style={{ color: "var(--ats-fg-muted)" }}>Field:</span> <span style={{ color: "var(--ats-fg-primary)" }}>{intake.field ?? "?"}</span></div>
              {intake.thesis && (
                <div><span style={{ color: "var(--ats-fg-muted)" }}>Main claim:</span> <span className="italic" style={{ color: "var(--ats-fg-secondary)" }}>&quot;{intake.thesis}&quot;</span></div>
              )}
              {intake.obvious_gaps && intake.obvious_gaps.length > 0 && (
                <div>
                  <span style={{ color: "var(--ats-fg-muted)" }}>Missing pieces:</span>{" "}
                  <span style={{ color: "#ef4444" }}>{intake.obvious_gaps.join("; ")}</span>
                </div>
              )}
            </div>
          )}

          {/* Top consolidated issues */}
          {(ck?.top_issues?.length ?? 0) > 0 && (
            <div>
              <div className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ats-fg-accent)" }}>
                <AlertTriangle size={10} />Top issues to address
              </div>
              <ul className="space-y-1.5">
                {(ck?.top_issues ?? []).map((it, i) => {
                  const sev = SEVERITY_STYLES[it.priority] ?? SEVERITY_STYLES.medium;
                  return (
                    <li
                      key={i}
                      className="rounded-lg border px-2.5 py-1.5"
                      style={{
                        borderColor:     "var(--ats-border-subtle)",
                        backgroundColor: "var(--ats-bg-input)",
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className="shrink-0 inline-flex items-center rounded border px-1 text-[9px] font-bold uppercase tracking-wider"
                          style={{ borderColor: sev.border, backgroundColor: sev.bg, color: sev.fg }}
                        >{sev.label}</span>
                        <span className="text-xs font-semibold flex-1 min-w-0" style={{ color: "var(--ats-fg-primary)" }}>{it.title || "(untitled issue)"}</span>
                        {it.lenses.length > 0 && (
                          <span className="shrink-0 text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>via {it.lenses.join(", ")}</span>
                        )}
                      </div>
                      {it.problem && <p className="mt-1 text-xs" style={{ color: "var(--ats-fg-secondary)" }}>{it.problem}</p>}
                      {it.suggestion && (
                        <p className="mt-1 text-xs">
                          <span className="font-semibold" style={{ color: "#10b981" }}>Fix: </span>
                          <span style={{ color: "var(--ats-fg-secondary)" }}>{it.suggestion}</span>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Consensus strengths */}
          {(ck?.consensus_strengths?.length ?? 0) > 0 && (
            <div>
              <div className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ats-fg-accent)" }}>
                <ThumbsUp size={10} />What the reviewers agreed was strong
              </div>
              <ul className="space-y-1">
                {(ck?.consensus_strengths ?? []).map((s, i) => (
                  <li key={i} className="text-xs flex gap-1.5" style={{ color: "var(--ats-fg-secondary)" }}>
                    <span className="shrink-0" style={{ color: "#10b981" }}>+</span>{s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Contradictions */}
          {(ck?.contradictions?.length ?? 0) > 0 && (
            <div>
              <div className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ats-fg-accent)" }}>
                <AlertTriangle size={10} />Where reviewers disagreed
              </div>
              <ul className="space-y-1">
                {(ck?.contradictions ?? []).map((s, i) => (
                  <li key={i} className="text-xs flex gap-1.5" style={{ color: "var(--ats-fg-secondary)" }}>
                    <span className="shrink-0" style={{ color: "#d97706" }}>!</span>{s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Per-specialist breakdown */}
          {Object.keys(reviews).length > 0 && (
            <div className="pt-1 border-t" style={{ borderColor: "var(--ats-border-subtle)" }}>
              <div className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ats-fg-accent)" }}>
                <Bot size={10} />One review per angle
              </div>
              <div className="space-y-1.5">
                {Object.entries(reviews).map(([key, r]) => {
                  const sev = SEVERITY_STYLES[r.severity] ?? SEVERITY_STYLES.medium;
                  return (
                    <details
                      key={key}
                      className="rounded-lg border px-2.5 py-1.5 group"
                      style={{
                        borderColor:     "var(--ats-border-subtle)",
                        backgroundColor: "var(--ats-bg-input)",
                      }}
                    >
                      <summary className="cursor-pointer list-none flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--ats-fg-primary)" }}>
                        <span className="capitalize flex-1">{key}</span>
                        <span
                          className="shrink-0 inline-flex items-center rounded border px-1 text-[9px] font-bold uppercase tracking-wider"
                          style={{ borderColor: sev.border, backgroundColor: sev.bg, color: sev.fg }}
                        >{sev.label}</span>
                        <span className="shrink-0 text-xs font-bold tabular-nums" style={{ color: "var(--ats-fg-primary)" }}>{r.score}/10</span>
                      </summary>
                      <div className="mt-1.5 space-y-1.5">
                        {r.summary && <p className="text-xs italic" style={{ color: "var(--ats-fg-secondary)" }}>{r.summary}</p>}
                        {r.strengths.length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: "#10b981" }}>What's working</div>
                            <ul className="space-y-0.5">
                              {r.strengths.map((s, i) => (
                                <li key={i} className="text-xs flex gap-1.5" style={{ color: "var(--ats-fg-secondary)" }}>
                                  <span className="shrink-0" style={{ color: "#10b981" }}>+</span>{s}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {r.issues.length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: "#ef4444" }}>What to fix</div>
                            <ul className="space-y-1">
                              {r.issues.map((it, i) => (
                                <li key={i} className="text-xs space-y-0.5" style={{ color: "var(--ats-fg-secondary)" }}>
                                  {it.quote && (
                                    <div className="italic border-l-2 pl-2" style={{ color: "var(--ats-fg-muted)", borderColor: "var(--ats-border-subtle)" }}>&quot;{it.quote}&quot;</div>
                                  )}
                                  {it.problem && <div>{it.problem}</div>}
                                  {it.suggestion && (
                                    <div>
                                      <span className="font-semibold" style={{ color: "#10b981" }}>Fix: </span>{it.suggestion}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
