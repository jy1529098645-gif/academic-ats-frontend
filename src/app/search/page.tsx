"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api";
import type { Paper, WorkflowItem } from "@/lib/types";

// Local-only — `label` and `search_query` are required here (the
// renderer assumes them without null-checks), so this can't share the
// optional-keyed shape used in src/app/page.tsx.
type IntentProfile = {
  include?:     string[];
  exclude?:     string[];
  domain_bias?: string;
};

type QueryOption = {
  label:           string;
  search_query:    string;
  reason?:         string;
  confidence?:     number;
  intent_profile?: IntentProfile;
};

type QueryOptionsResponse = {
  original_query?:    string;
  recommended_index?: number;
  options?:           QueryOption[];
  error?:             string;
  cache_hit?:         boolean;
};

type SearchSettings = {
  paper_count:      number;
  sort_mode:        string;
  prefer_abstracts: boolean;
  strict_core_only: boolean;
  open_access_only: boolean;
  use_year_range:   boolean;
  year_start:       number;
  year_end:         number;
  source_filters:   string[];
  fast_mode:        boolean;
};

// Loose response shape — the SSE envelope wraps a backend dict whose
// non-core fields evolve faster than this type can. The catch-all
// `[key: string]: unknown` was previously `any`; tightening it to
// `unknown` keeps the same flexibility but forces callers to narrow
// before consuming, which is what they were already doing implicitly.
type SearchResponse = {
  brief?:               string;
  papers?:              Paper[];
  collaboration_trace?: WorkflowItem[];
  [key: string]:        unknown;
};

type StreamState = {
  requestId: string;
  status: "idle" | "running" | "done" | "error";
  progress: number;
  message: string;
  cacheHit: boolean;
  workflow: WorkflowItem[];
  result: SearchResponse | null;
  error: string;
  briefText: string;       // accumulated from brief_chunk events
  papers: Paper[];         // received early via papers event
};

const API_BASE = API_BASE_URL;
const DEFAULT_SOURCES = ["Semantic Scholar", "OpenAlex", "Crossref", "Google Scholar", "arXiv", "PubMed", "ERIC", "DOAJ", "DiGRA"];
// Chinese academic platforms — shown in the source picker but OFF by default.
// Users explicitly opt in per search. Kept separate from DEFAULT_SOURCES so
// the "All" button only restores the English defaults (matches prior behavior).
const CHINESE_SOURCES = ["ChinaXiv", "NSTL", "NCPSSD", "CNKI Scholar"];
const ALL_SOURCES = [...DEFAULT_SOURCES, ...CHINESE_SOURCES];
const SORT_MODES = ["Balanced", "Newest first", "Research fit", "Relevance score", "Evidence strength", "Open access first"] as const;

function consumeSseBlocks(chunkBuffer: string, onEvent: (eventName: string, dataText: string) => void) {
  let remaining = chunkBuffer;
  let boundary = remaining.indexOf("\n\n");
  while (boundary !== -1) {
    const rawBlock = remaining.slice(0, boundary).trim();
    remaining = remaining.slice(boundary + 2);
    if (rawBlock) {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of rawBlock.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) onEvent(eventName, dataLines.join("\n"));
    }
    boundary = remaining.indexOf("\n\n");
  }
  return remaining;
}

export default function SearchPage() {
  const abortRef = useRef<AbortController | null>(null);
  const briefQueueRef = useRef<string[]>([]);
  const briefFlushGenRef = useRef(0);
  const briefVersionRef = useRef(0);
  const briefClearPendingRef = useRef(false);
  const [query, setQuery] = useState("AR games");
  const [queryOptions, setQueryOptions] = useState<QueryOptionsResponse | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | null>(null);
  const [customQuery, setCustomQuery] = useState("");
  const [uiError, setUiError] = useState("");
  const [isUnderstanding, setIsUnderstanding] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<"idle" | "clearing" | "cleared" | "error">("idle");
  const [seenPaperTitles, setSeenPaperTitles] = useState<string[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [briefAnimated, setBriefAnimated] = useState("");
  const [briefPhase, setBriefPhase] = useState<{ phase: "idle" | "draft" | "sections" | "stitch"; done: number; total: number }>({ phase: "idle", done: 0, total: 4 });
  const [agentResults, setAgentResults] = useState<Record<string, any>>({});
  const [stream, setStream] = useState<StreamState>({
    requestId: "",
    status: "idle",
    progress: 0,
    message: "",
    cacheHit: false,
    workflow: [],
    result: null,
    error: "",
    briefText: "",
    papers: [],
  });
  const [settings, setSettings] = useState<SearchSettings>({
    paper_count: 10,
    sort_mode: "Balanced",
    prefer_abstracts: true,
    strict_core_only: false,
    open_access_only: false,
    use_year_range: false,
    year_start: 2018,
    year_end: new Date().getFullYear(),
    source_filters: DEFAULT_SOURCES,
    fast_mode: false,
  });

  const options = queryOptions?.options || [];
  const recommendedIndex = typeof queryOptions?.recommended_index === "number" ? queryOptions.recommended_index : 0;
  const selectedOption = options[selectedOptionIndex ?? recommendedIndex] || null;
  const finalSearchQuery = useMemo(() => customQuery.trim() || selectedOption?.search_query?.trim() || query.trim(), [customQuery, selectedOption, query]);

  // RAF flush loop: drains briefQueueRef at 3 word-tokens per animation frame (~60 fps).
  // briefClearPendingRef signals a version bump (v1→v2): on the next flush we reset
  // briefAnimated to just the new batch instead of appending, eliminating the blank flash.
  useEffect(() => {
    let rafId: number;
    const flush = () => {
      const q = briefQueueRef.current;
      if (q.length > 0) {
        const capturedGen = briefFlushGenRef.current;
        const batch = q.splice(0, Math.min(q.length, 3));
        if (briefClearPendingRef.current) {
          briefClearPendingRef.current = false;
          setBriefAnimated(batch.join(""));
        } else {
          setBriefAnimated(prev => {
            if (briefFlushGenRef.current !== capturedGen) return prev;
            return prev + batch.join("");
          });
        }
      }
      rafId = requestAnimationFrame(flush);
    };
    rafId = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // The brief to display: RAF-animated text during run, final result after done.
  // briefAnimated takes priority while it has content so the typewriter animation
  // is never replaced mid-stream by the full result text (which would jump to the end).
  // Falls back to stream.result?.brief only when animation never started (total SSE failure).
  const displayBrief = useMemo(() => {
    const raw = briefAnimated || stream.result?.brief || "";
    return raw.replace(/^Research Brief\s*\n+/i, "").trimStart();
  }, [stream.result, briefAnimated]);

  // Papers to display: early papers event or final result
  const displayPapers = useMemo(() => {
    if ((stream.result?.papers || []).length > 0) return stream.result!.papers!;
    return stream.papers;
  }, [stream.result, stream.papers]);

  const handleUnderstand = async () => {
    const trimmed = query.trim();
    if (!trimmed || isUnderstanding) return;
    setUiError("");
    setIsUnderstanding(true);
    try {
      const res = await fetch(`${API_BASE}/api/query-options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Failed to understand query: ${res.status}`);
      setQueryOptions(data);
      setSelectedOptionIndex(typeof data?.recommended_index === "number" ? data.recommended_index : 0);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Failed to understand query.");
    } finally {
      setIsUnderstanding(false);
    }
  };

  const handleClearCache = async () => {
    setCacheStatus("clearing");
    try {
      const res = await fetch(`${API_BASE}/api/cache`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.detail || "Cache clear failed.");
      setCacheStatus("cleared");
      setTimeout(() => setCacheStatus("idle"), 3000);
    } catch {
      setCacheStatus("error");
      setTimeout(() => setCacheStatus("idle"), 3000);
    }
  };

  const handleBatchRefresh = async () => {
    // Collect titles of currently displayed papers to exclude them from the next search
    const currentTitles = displayPapers.map((p) => p.title).filter(Boolean);
    const newSeen = [...new Set([...seenPaperTitles, ...currentTitles])];
    setSeenPaperTitles(newSeen);
    setIsRefreshing(true);

    // Trigger a new fast search with excluded_titles, then clear isRefreshing
    await handleSearch(newSeen);
    setIsRefreshing(false);
  };

  const handleSearch = async (excludedTitles?: string[]) => {
    const trimmed = query.trim();
    if (!trimmed || isSubmitting) return;
    if (!settings.source_filters.length) {
      setUiError("Please select at least one source.");
      return;
    }

    // Fresh search (no exclusions passed) resets the seen-titles history
    if (!excludedTitles || excludedTitles.length === 0) {
      setSeenPaperTitles([]);
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setUiError("");
    setIsSubmitting(true);
    briefFlushGenRef.current += 1;
    briefVersionRef.current = 0;
    briefQueueRef.current = [];
    briefClearPendingRef.current = false;
    setBriefAnimated("");
    setBriefPhase({ phase: "idle", done: 0, total: 4 });
    setAgentResults({});
    setStream({
      requestId: "", status: "running", progress: 0,
      message: "⚙️ Initializing...", cacheHit: false,
      workflow: [], result: null, error: "",
      briefText: "", papers: [],
    });

    const selectedPayload = customQuery.trim()
      ? {
          label: "Custom query",
          search_query: customQuery.trim(),
          reason: "User-entered custom query.",
          confidence: 1,
          intent_profile: selectedOption?.intent_profile || { include: [], exclude: [], domain_bias: "" },
        }
      : selectedOption || {
          label: trimmed,
          search_query: trimmed,
          reason: "Direct search.",
          confidence: 0.5,
          intent_profile: { include: [], exclude: [], domain_bias: "" },
        };

    const payload = {
      query: trimmed,
      final_search_query: finalSearchQuery,
      selected_option: selectedPayload,
      paper_count: settings.paper_count,
      sort_mode: settings.sort_mode,
      prefer_abstracts: settings.prefer_abstracts,
      strict_core_only: settings.strict_core_only,
      open_access_only: settings.open_access_only,
      source_filters: settings.source_filters,
      year_range: settings.use_year_range ? [settings.year_start, settings.year_end] : null,
      excluded_titles: excludedTitles ?? [],
      fast_mode: settings.fast_mode,
    };

    try {
      const res = await fetch(`${API_BASE}/api/search/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Failed to start streaming search: ${res.status}`);
      }
      if (!res.body) throw new Error("The backend did not return a readable stream.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const applyEvent = (eventName: string, dataText: string) => {
        // `any` is intentional here — the SSE envelope from the search
        // backend has ~12 distinct event shapes and the consumer below
        // already narrows each field individually with typeof /
        // Array.isArray / Number(...) before use. Tightening to
        // `Record<string, unknown>` would force a per-site cast at every
        // `parsed?.foo` access without strengthening any actual runtime
        // check. The boundary is the JSON.parse — beyond that, narrowing
        // is structural.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let parsed: any;
        try { parsed = JSON.parse(dataText); } catch { return; }

        if (eventName === "meta") {
          setStream((prev) => ({
            ...prev,
            requestId: String(parsed?.request_id || prev.requestId),
            cacheHit: Boolean(parsed?.cache_hit),
          }));
          return;
        }
        if (eventName === "progress") {
          setStream((prev) => ({
            ...prev,
            status: "running",
            progress: typeof parsed?.progress === "number" ? parsed.progress : prev.progress,
            message: parsed?.message || prev.message,
            workflow: parsed?.workflow_item ? [...prev.workflow, parsed.workflow_item].slice(-20) : prev.workflow,
          }));
          return;
        }
        // Brief lifecycle events — track section-level progress for deep mode UI
        if (eventName === "brief_event") {
          const evt = parsed?.event;
          if (evt === "brief_reset") {
            briefFlushGenRef.current += 1;
            briefVersionRef.current = 0;
            briefQueueRef.current.length = 0;
            briefClearPendingRef.current = false;
            setBriefAnimated("");
            setBriefPhase({ phase: "idle", done: 0, total: 4 });
            setStream((prev) => ({ ...prev, briefText: "" }));
          } else if (evt === "brief_started") {
            setBriefPhase({ phase: "sections", done: 0, total: parsed?.total_sections ?? 4 });
          } else if (evt === "section_done") {
            setBriefPhase((prev) => ({ ...prev, done: prev.done + 1 }));
          } else if (evt === "stitch_started") {
            setBriefPhase((prev) => ({ ...prev, phase: "stitch" }));
          } else if (evt === "stitch_done") {
            setBriefPhase((prev) => ({ ...prev, phase: "idle" }));
          }
          return;
        }
        // Live brief chunks — split into word-tokens then push to RAF queue.
        // Splitting ensures even large fallback chunks (full text in one callback)
        // get rendered token-by-token rather than appearing in a single frame.
        if (eventName === "brief_chunk") {
          const chunk = String(parsed?.chunk || "");
          const incomingVersion = (parsed?.version as number) ?? 1;
          if (chunk) {
            const tokens = chunk.match(/\S+\s*/g) ?? [chunk];
            if (incomingVersion > briefVersionRef.current) {
              // Version bump (draft→final): invalidate stale RAF batches.
              // briefClearPendingRef defers the actual clear to the next RAF frame
              // so there is no blank-flash between versions.
              briefFlushGenRef.current += 1;
              briefVersionRef.current = incomingVersion;
              briefQueueRef.current.length = 0;
              briefQueueRef.current.push(...tokens);
              briefClearPendingRef.current = true;
            } else if (incomingVersion === briefVersionRef.current || briefVersionRef.current === 0) {
              briefVersionRef.current = incomingVersion;
              briefQueueRef.current.push(...tokens);
            }
            setStream((prev) => ({ ...prev, briefText: prev.briefText + chunk }));
          }
          return;
        }
        if (eventName === "agent_result") {
          const agent = String(parsed?.agent || "");
          const data = parsed?.data;
          if (agent && data) setAgentResults((prev) => ({ ...prev, [agent]: data }));
          return;
        }
        // Papers ready early — show before analysis completes
        if (eventName === "papers") {
          const papers: Paper[] = Array.isArray(parsed?.papers) ? parsed.papers : [];
          if (papers.length) setStream((prev) => ({ ...prev, papers }));
          return;
        }
        if (eventName === "result") {
          setStream((prev) => ({
            ...prev,
            status: "done",
            progress: 100,
            message: parsed?.message || "✅ Finished.",
            result: parsed?.result || null,
            cacheHit: Boolean(parsed?.cache_hit || prev.cacheHit),
          }));
          return;
        }
        if (eventName === "error") {
          const message = String(parsed?.error || "Search failed.");
          setStream((prev) => ({ ...prev, status: "error", progress: 100, message: "❌ Failed.", error: message }));
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeSseBlocks(buffer, applyEvent);
      }
      buffer += decoder.decode();
      consumeSseBlocks(buffer, applyEvent);
    } catch (error) {
      // AbortError is normal — fired when the user cancels mid-stream
      // by clicking Stop or starting a new query. Anything else is a
      // real failure that needs to surface in the UI.
      const errName = error instanceof Error ? error.name : "";
      if (errName !== "AbortError") {
        const message = error instanceof Error ? error.message : "Streaming search failed.";
        setUiError(message);
        setStream((prev) => ({ ...prev, status: "error", progress: 100, message: "❌ Failed.", error: message }));
      }
    } finally {
      setIsSubmitting(false);
      abortRef.current = null;
    }
  };

  const toggleSource = (source: string) => {
    setSettings((prev) => ({
      ...prev,
      source_filters: prev.source_filters.includes(source)
        ? prev.source_filters.filter((s) => s !== source)
        : [...prev.source_filters, source],
    }));
  };

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-900">
      <div className="mx-auto max-w-4xl space-y-6">

        {/* ── Header ── */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-baseline gap-2">
            <span className="text-slate-900">Academi</span><span className="text-blue-500">Cats</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500">v1.5.0-Alpha</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">Deep search · Research Brief · Multi-agent analysis</p>
        </div>

        {uiError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{uiError}</div>
        ) : null}

        {/* ── Query input ── */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <label className="block text-sm font-medium text-slate-700">Research topic</label>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-500 resize-none"
            placeholder="e.g. effects of screen time on adolescent sleep quality"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void handleUnderstand()}
              disabled={!query.trim() || isUnderstanding || isSubmitting}
              className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {isUnderstanding ? "Understanding…" : "Understand Query"}
            </button>
            <button
              onClick={() => void handleSearch()}
              disabled={!query.trim() || isSubmitting}
              className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {isSubmitting ? "Searching…" : "Deep Search"}
            </button>
            <div className="ml-auto flex items-center gap-2">
              {/* Delete Cache — always visible */}
              <button
                onClick={() => void handleClearCache()}
                disabled={cacheStatus === "clearing"}
                title="Delete search cache"
                className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  cacheStatus === "cleared"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : cacheStatus === "error"
                    ? "border-red-300 bg-red-50 text-red-700"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                } disabled:opacity-50`}
              >
                {cacheStatus === "clearing" ? "Clearing…" : cacheStatus === "cleared" ? "✓ Cleared" : cacheStatus === "error" ? "✗ Failed" : "🗑 Cache"}
              </button>
              <button
                onClick={() => setShowSettings((v) => !v)}
                className={`rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                  showSettings ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                ⚙ Settings
              </button>
            </div>
          </div>

          {/* ── Query options ── */}
          {queryOptions ? (
            <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs text-slate-500">
                {queryOptions.cache_hit ? "⚡ Loaded from cache." : "Fresh query understanding."}
              </div>
              {(queryOptions.options || []).map((option, index) => (
                <button
                  key={`${option.label}-${index}`}
                  type="button"
                  onClick={() => setSelectedOptionIndex(index)}
                  className={`block w-full rounded-xl border p-3 text-left text-sm ${
                    index === (selectedOptionIndex ?? recommendedIndex)
                      ? "border-blue-500 bg-blue-50"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <span className="font-medium">{option.label}</span>
                  {option.reason ? <span className="ml-2 text-slate-500">{option.reason}</span> : null}
                  <div className="mt-1 text-xs text-slate-400">Query: {option.search_query}</div>
                </button>
              ))}
              <input
                value={customQuery}
                onChange={(e) => setCustomQuery(e.target.value)}
                placeholder="Custom search query (optional override)"
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-blue-500"
              />
            </div>
          ) : null}
        </section>

        {/* ── Settings panel ── */}
        {showSettings ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
            <h2 className="text-base font-semibold">Search Settings</h2>

            {/* Paper count + sort mode */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">Papers to retrieve</label>
                <input
                  type="number"
                  min={3}
                  max={30}
                  value={settings.paper_count}
                  onChange={(e) => setSettings((p) => ({ ...p, paper_count: Math.max(3, Math.min(30, Number(e.target.value))) }))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">Sort mode</label>
                <select
                  value={settings.sort_mode}
                  onChange={(e) => setSettings((p) => ({ ...p, sort_mode: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 bg-white"
                >
                  {SORT_MODES.map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
            </div>

            {/* Year range */}
            <div>
              <label className="mb-1.5 flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.use_year_range}
                  onChange={(e) => setSettings((p) => ({ ...p, use_year_range: e.target.checked }))}
                  className="rounded"
                />
                Filter by year range
              </label>
              {settings.use_year_range ? (
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="number"
                    min={1900}
                    max={settings.year_end}
                    value={settings.year_start}
                    onChange={(e) => setSettings((p) => ({ ...p, year_start: Number(e.target.value) }))}
                    className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                  <span className="text-slate-400">–</span>
                  <input
                    type="number"
                    min={settings.year_start}
                    max={new Date().getFullYear()}
                    value={settings.year_end}
                    onChange={(e) => setSettings((p) => ({ ...p, year_end: Number(e.target.value) }))}
                    className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </div>
              ) : null}
            </div>

            {/* Analysis depth */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">Analysis depth</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, fast_mode: true }))}
                  className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${settings.fast_mode ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  Quick <span className="ml-1 text-xs opacity-60">~15s</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSettings((p) => ({ ...p, fast_mode: false }))}
                  className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${!settings.fast_mode ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  Deep <span className="ml-1 text-xs opacity-60">~90s · multi-agent</span>
                </button>
              </div>
            </div>

            {/* Toggles */}
            <div className="flex flex-wrap gap-4">
              {[
                { key: "prefer_abstracts" as const, label: "Prefer abstracts" },
                { key: "strict_core_only" as const, label: "Core papers only" },
                { key: "open_access_only" as const, label: "Open access only" },
              ].map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={settings[key] as boolean}
                    onChange={(e) => setSettings((p) => ({ ...p, [key]: e.target.checked }))}
                    className="rounded"
                  />
                  {label}
                </label>
              ))}
            </div>

            {/* Source filters */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">Sources</span>
                <div className="flex gap-2 text-xs text-slate-500">
                  <button onClick={() => setSettings((p) => ({ ...p, source_filters: [...DEFAULT_SOURCES] }))} className="hover:text-blue-600">All</button>
                  <span>·</span>
                  <button onClick={() => setSettings((p) => ({ ...p, source_filters: [...ALL_SOURCES] }))} className="hover:text-blue-600">All + 中文</button>
                  <span>·</span>
                  <button onClick={() => setSettings((p) => ({ ...p, source_filters: [] }))} className="hover:text-blue-600">None</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {DEFAULT_SOURCES.map((src) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => toggleSource(src)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      settings.source_filters.includes(src)
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    {src}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                <span className="font-medium">中文平台</span>
                <span className="text-slate-400">· 默认关闭，开启后纳入检索</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {CHINESE_SOURCES.map((src) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => toggleSource(src)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      settings.source_filters.includes(src)
                        ? "border-amber-500 bg-amber-50 text-amber-700"
                        : "border-dashed border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    {src}
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {/* ── Stream progress ── */}
        {stream.status !== "idle" ? (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-slate-700">{stream.message || "Running…"}</span>
              <div className="flex items-center gap-2">
                {stream.cacheHit ? (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">Cache hit</span>
                ) : null}
                {stream.requestId ? (
                  <span className="text-xs text-slate-400">#{stream.requestId.slice(0, 8)}</span>
                ) : null}
              </div>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${Math.max(2, Math.min(100, stream.progress))}%` }}
              />
            </div>
            {stream.workflow.length ? (
              <div className="mt-3 space-y-1.5 max-h-40 overflow-y-auto">
                {stream.workflow.slice().reverse().map((item, idx) => (
                  <div key={idx} className="rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
                    <span className="font-medium text-slate-700">{item.agent}</span>
                    {item.action ? <span className="mx-1 text-slate-400">·</span> : null}
                    {item.action}
                    {item.details ? <span className="ml-1 text-slate-400">— {item.details}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* ── Research Brief (streams in live) ── */}
        {(displayBrief || (stream.status === "running" && briefPhase.phase !== "idle")) ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="text-base font-semibold">Research Brief</h2>
              {stream.status === "running" ? (
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
              ) : null}
            </div>

            {/* Deep mode section progress (shown during the silent parallel-section phase) */}
            {briefPhase.phase === "sections" ? (
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                  <span>Analyzing sections ({briefPhase.done}/{briefPhase.total})</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-blue-400 transition-all duration-500"
                    style={{ width: `${Math.round((briefPhase.done / briefPhase.total) * 100)}%` }}
                  />
                </div>
              </div>
            ) : briefPhase.phase === "stitch" ? (
              <p className="mb-2 text-xs text-slate-500">Composing final brief…</p>
            ) : null}

            {displayBrief ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                {displayBrief}
                {stream.status === "running" && briefAnimated && !stream.result ? (
                  <span className="inline-block w-0.5 h-3.5 bg-blue-500 ml-0.5 animate-pulse align-middle" />
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-slate-400">
                {briefPhase.phase === "sections" ? "Draft brief generating in background…" : "Generating brief…"}
              </p>
            )}
          </section>
        ) : null}

        {/* ── Agent Results (deep mode) ── */}
        {Object.keys(agentResults).length > 0 ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-base font-semibold">Agent Analysis</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["evidence_mapper", "researcher", "methodologist", "scholar", "theorist", "critic", "gap_analyst", "verifier"] as const).map((agent) => {
                const data = agentResults[agent];
                if (!data) return null;
                const label: Record<string, string> = {
                  evidence_mapper: "Evidence Mapper",
                  researcher: "Researcher",
                  methodologist: "Methodologist",
                  scholar: "Scholar",
                  theorist: "Theorist",
                  critic: "Critic",
                  gap_analyst: "Gap Analyst",
                  verifier: "Verifier",
                };
                const entries = Object.entries(data as Record<string, any>).filter(([, v]) => Array.isArray(v) ? v.length > 0 : Boolean(v));
                if (!entries.length) return null;
                return (
                  <div key={agent} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{label[agent] ?? agent}</div>
                    <div className="space-y-1.5">
                      {entries.slice(0, 4).map(([key, val]) => (
                        <div key={key}>
                          <span className="text-xs font-medium text-slate-700">{key.replace(/_/g, " ")}: </span>
                          <span className="text-xs text-slate-600">
                            {Array.isArray(val) ? val.slice(0, 3).join(", ") : String(val)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* ── Papers ── */}
        {displayPapers.length > 0 ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">
                Retrieved Papers
                {(() => {
                  // Show "selected N from M retrieved" using the retrieval
                  // funnel from diagnostics — take the MAX across stages so
                  // we always surface the biggest candidate pool we ever
                  // saw (typically retrieved_total: raw hits from all
                  // upstream sources before dedup + filters + re-ranking).
                  // SearchResponse.diagnostics is `unknown` at the type
                  // level (loose backend payload); narrow to a Record
                  // here so the four numeric reads below stay simple.
                  const diag = stream.result?.diagnostics;
                  const fr = (diag && typeof diag === "object")
                    ? (diag as Record<string, unknown>).retrieval_funnel
                    : null;
                  const f = (fr && typeof fr === "object")
                    ? fr as Record<string, unknown>
                    : {};
                  const poolSize = Math.max(
                    Number(f.retrieved_total) || 0,
                    Number(f.after_filters)   || 0,
                    Number(f.stage2_pool)     || 0,
                    Number(f.final_count)     || 0,
                  );
                  return poolSize > displayPapers.length ? (
                    <span className="ml-1 text-sm font-normal text-slate-500">
                      (selected <span className="font-semibold text-slate-700">{displayPapers.length}</span> from <span className="font-semibold text-slate-700">{poolSize.toLocaleString()}</span> retrieved)
                    </span>
                  ) : (
                    <span className="ml-1 text-sm font-normal text-slate-500">({displayPapers.length})</span>
                  );
                })()}
              </h2>
              {stream.status === "done" ? (
                <button
                  onClick={() => void handleBatchRefresh()}
                  disabled={isRefreshing || isSubmitting}
                  title="Get a new batch of papers (previously shown papers are excluded)"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
                >
                  {isRefreshing ? "Loading…" : "🔄 换一批"}
                </button>
              ) : null}
            </div>
            <div className="space-y-3">
              {displayPapers.map((paper, idx) => (
                <div key={`${paper.title}-${idx}`} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                  <div className="font-medium text-slate-900">{paper.title}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {[paper.authors, paper.year, paper.source].filter(Boolean).join(" · ")}
                  </div>
                  {paper.recommendation_reason || paper.summary ? (
                    <div className="mt-2 text-sm text-slate-600">
                      {paper.recommendation_reason || paper.summary}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* ── Error state ── */}
        {stream.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {stream.error}
          </div>
        ) : null}

      </div>
    </main>
  );
}
