"use client";

import { useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api";

type IntentProfile = {
  include?: string[];
  exclude?: string[];
  domain_bias?: string;
};

type QueryOption = {
  label: string;
  search_query: string;
  reason?: string;
  confidence?: number;
  intent_profile?: IntentProfile;
};

type QueryOptionsResponse = {
  original_query?: string;
  recommended_index?: number;
  options?: QueryOption[];
  error?: string;
  cache_hit?: boolean;
};

type SearchSettings = {
  paper_count: number;
  sort_mode: string;
  prefer_abstracts: boolean;
  strict_core_only: boolean;
  open_access_only: boolean;
  use_year_range: boolean;
  year_start: number;
  year_end: number;
  source_filters: string[];
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
  summary?: string;
  recommendation_reason?: string;
};

type SearchResponse = {
  brief?: string;
  papers?: Paper[];
  collaboration_trace?: WorkflowItem[];
  [key: string]: any;
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
  });

  const options = queryOptions?.options || [];
  const recommendedIndex = typeof queryOptions?.recommended_index === "number" ? queryOptions.recommended_index : 0;
  const selectedOption = options[selectedOptionIndex ?? recommendedIndex] || null;
  const finalSearchQuery = useMemo(() => customQuery.trim() || selectedOption?.search_query?.trim() || query.trim(), [customQuery, selectedOption, query]);

  // The brief to display: streaming chunks during run, final result after done.
  // Strip the leading "Research Brief" title from content (already shown as heading in UI).
  const displayBrief = useMemo(() => {
    const raw = stream.result?.brief || stream.briefText;
    // Remove optional leading "Research Brief" header + blank lines emitted by LLM
    return raw.replace(/^Research Brief\s*\n+/i, "").trimStart();
  }, [stream.result, stream.briefText]);

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
        // Brief section events — brief_reset clears stale text on re-run (e.g. after refinement)
        if (eventName === "brief_event") {
          if (parsed?.event === "brief_reset") {
            setStream((prev) => ({ ...prev, briefText: "" }));
          }
          return;
        }
        // Live brief chunks — accumulate as they stream in
        if (eventName === "brief_chunk") {
          const chunk = String(parsed?.text || "");
          if (chunk) setStream((prev) => ({ ...prev, briefText: prev.briefText + chunk }));
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
      if ((error as any)?.name !== "AbortError") {
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
            Academic ATS
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500">v1.3</span>
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
        {displayBrief ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="text-base font-semibold">Research Brief</h2>
              {stream.status === "running" ? (
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
              ) : null}
            </div>
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{displayBrief}</div>
          </section>
        ) : null}

        {/* ── Papers ── */}
        {displayPapers.length > 0 ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">
                Retrieved Papers <span className="ml-1 text-sm font-normal text-slate-500">({displayPapers.length})</span>
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
