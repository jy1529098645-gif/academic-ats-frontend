"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EChartsTrendCharts — echarts-rendered replacements for the three SVG charts
// that previously lived in src/app/charts.tsx.
//
// What's the same:
//   · The data shape is unchanged. Each component takes `papers: ChartPaper[]`
//     and derives its own counts / coordinates internally. Empty-state copy
//     mirrors the SVG version so the user experience is unchanged when no
//     papers are loaded.
//   · The visual identity is preserved — same brand-blue accent, same per-
//     source palette, same "papers vs. year" axis layout. We're moving from
//     SVG to canvas; we're NOT redesigning the charts.
//
// What's NEW (v2):
//   · Smooth re-render. echarts ships built-in transitions on data updates,
//     so when the streamed paper set grows mid-search the bars and donut
//     slices animate from old to new values rather than redrawing in place.
//   · Auto-adapt to zone size. Each chart card's height is responsive
//     (CSS aspect-ratio with a clamp), so a wide zone gives the chart a
//     larger canvas and a narrow zone contracts it — same fluid feel
//     keyword-cloud has after the auto-scale fix.
//   · Bullseye chart redesigned. The previous polar-scatter version
//     mostly rendered blank because it relied on `evidence_score`,
//     which most papers don't carry. The new version is a Cartesian
//     scatter (methodology rigor × citation impact) with a robust
//     fallback chain that always produces meaningful coordinates from
//     whatever fields the paper actually has.
//   · Tooltip alignment fixed. `confine: true` keeps the tooltip
//     inside the canvas viewport (so it doesn't escape into negative
//     coordinates when the chart is near a zone edge). `axisPointer`
//     uses crosshair on Cartesian charts so the cursor visibly snaps
//     to the highlighted datum.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useRef } from "react";
import { Download } from "lucide-react";
import * as echarts from "echarts/core";
import {
  BarChart, LineChart, PieChart, ScatterChart,
} from "echarts/charts";
import {
  GridComponent, TooltipComponent, LegendComponent, MarkLineComponent,
  PolarComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useT } from "@/lib/i18n/use-t";
import { EChartsHost, type EChartsHostHandle } from "./EChartsHost";
import { downloadChartAsPng, sanitizeChartFilename } from "@/lib/chart-download";
import type { ChartPaper } from "@/lib/chart-types";

// Idempotent registration. Same pattern chart-builder uses.
echarts.use([
  BarChart, LineChart, PieChart, ScatterChart,
  GridComponent, TooltipComponent, LegendComponent, MarkLineComponent,
  PolarComponent,
  CanvasRenderer,
]);

// Brand palette — kept in sync with the legacy SVG charts so a user who
// has the old + new chart on the same screen during the transition sees
// matching colours.
const COLORS = {
  blue:    "#3b82f6",
  trend:   "#93c5fd",
  emerald: "#10b981",
  amber:   "#f59e0b",
  rose:    "#f43f5e",
  red:     "#ef4444",
  violet:  "#8b5cf6",
  teal:    "#14b8a6",
  pink:    "#ec4899",
  indigo:  "#6366f1",
};

// Per-source palette. Falls through to a hashed slot for unknown sources
// so the colour stays stable across renders.
const SOURCE_PALETTE = [
  COLORS.blue, COLORS.emerald, COLORS.amber, COLORS.violet,
  COLORS.rose, COLORS.teal, COLORS.indigo, COLORS.pink,
];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

// Shared tooltip surface used by every chart in this file. `confine:true`
// is the key: when the chart is near a zone edge (after a divider drag,
// or in a cramped left/right slot), echarts otherwise positions the
// tooltip relative to the datum, which can land it half-off-canvas. With
// confine the tooltip never escapes the chart's bounding box, so the
// arrow stays visually attached to the cursor / data point.
const SHARED_TOOLTIP_CSS =
  "background: var(--ats-bg-panel) !important;" +
  "border: 1px solid var(--ats-border-subtle) !important;" +
  "border-radius: 6px !important;" +
  "box-shadow: 0 4px 12px rgba(0,0,0,0.18) !important;" +
  "padding: 8px 10px !important;" +
  "color: var(--ats-fg-primary) !important;";

// ── Card chrome ─────────────────────────────────────────────────────────
// PRESET-SIZE chart card. The chart no longer adapts to the zone's
// width — it sits at a fixed CHART_PRESET_W × CHART_PRESET_H and the
// card is centred horizontally inside whatever column it's in. The
// reasons:
//
//   · Tighter zone boundaries used to make the chart canvas
//     redraw on every divider drag, occasionally drifting out of
//     hit-test sync with the wrapper.
//   · A preset size means the eye reads "chart" as a stable visual
//     element regardless of which mode / zone hosts the trend
//     chart, instead of rescaling depending on what's beside it.
//   · Wider zones now show breathing room around the chart rather
//     than stretching it into a useless wide ribbon.
//
// On narrower zones (below the preset width), the card scales down
// gracefully via `max-w-full`; the inner echarts host still gets a
// real (non-zero) bounding box so hit-tests stay correct.
const CHART_PRESET_W = 460; // px
const CHART_PRESET_H = 240; // px

function ChartCard({
  title,
  children,
  chartRef,
}: {
  title:    string;
  children: React.ReactNode;
  /** When provided, a hover-revealed download button appears in the
   *  top-right corner. Click → exports the rendered chart as PNG via
   *  the EChartsHost imperative handle. Pass `undefined` for empty /
   *  no-data states to suppress the button (nothing to download). */
  chartRef?: React.RefObject<EChartsHostHandle | null>;
}) {
  // Tailwind `group` on the card lets the absolute-positioned chip
  // fade in only while the user hovers / focuses inside the card. At
  // rest the chip is opacity-0 + pointer-events-none so it doesn't
  // intercept clicks meant for the chart.
  return (
    <div
      className="ats-card p-3 chart-card mx-auto max-w-full relative group"
      style={{ width: `${CHART_PRESET_W}px` }}
    >
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
        {title}
      </div>
      {chartRef ? <ChartDownloadChip chartRef={chartRef} title={title} /> : null}
      <div className="w-full" style={{ height: `${CHART_PRESET_H}px` }}>
        {children}
      </div>
    </div>
  );
}

// Tiny reusable hover-revealed download button. Lifted out of
// ChartCard so the in-mod PresetChartCard (which has its own card
// shell with a Sparkles-prefixed title) can reuse the exact same
// affordance without duplicating the show/hide logic.
//
// Positioning: pinned to the card's top-right corner, padded 0.5rem
// off both edges. The card's title row sits at top-left (uppercase
// 10px); the chip's 1.5rem square never overlaps the title because
// the title's right edge is well clear of the chip slot.
//
// Visibility: opacity 0 at rest, 1 on parent hover/focus-within, with
// `pointer-events-none` while hidden so accidental top-right clicks
// pass through to the chart. The hover transition is 150 ms — fast
// enough to feel responsive, slow enough not to flicker on a quick
// mouseover.
export function ChartDownloadChip({
  chartRef,
  title,
}: {
  chartRef: React.RefObject<EChartsHostHandle | null>;
  title:    string;
}) {
  return (
    <button
      type="button"
      onClick={async () => {
        // toImageDataURL is async (it rasterises an SVG render to a
        // real PNG via an in-DOM canvas). Without `await` we'd hand
        // a Promise object to the download helper and write garbage.
        const url = await chartRef.current?.toImageDataURL();
        if (!url) return;
        downloadChartAsPng(url, sanitizeChartFilename(title));
      }}
      aria-label={`Download ${title} as PNG`}
      title={`Download "${title}" as PNG`}
      className="absolute top-2 right-2 inline-flex h-6 w-6 items-center justify-center rounded-md border opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto hover:brightness-110 focus:opacity-100 focus:pointer-events-auto"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-panel)",
        color:           "var(--ats-fg-muted)",
      }}
    >
      <Download size={12} />
    </button>
  );
}

function EmptyChart({ msg = "No data yet" }: { msg?: string }) {
  return (
    <div className="flex h-full min-h-[6rem] items-center justify-center rounded-xl text-xs text-slate-600">
      {msg}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Chart 1 · Publication Year Distribution + Trend Line
// Recreates the SVG bar+line combo using a shared category axis: a "papers"
// bar series and a "trend" line series sit on the same x ticks.
// ─────────────────────────────────────────────────────────────────────────
export function YearDistributionChartEC({ papers }: { papers: ChartPaper[] }) {
  const t = useT();

  const data = useMemo(() => {
    const counts: Record<string, number> = {};
    papers.forEach((p) => {
      const y = String(p.year ?? "").match(/\d{4}/)?.[0];
      if (y) counts[y] = (counts[y] ?? 0) + 1;
    });
    return Object.entries(counts).sort(([a], [b]) => Number(a) - Number(b));
  }, [papers]);

  const option = useMemo(() => {
    const xs = data.map(([y]) => y);
    const ys = data.map(([, n]) => n);
    return {
      tooltip: {
        trigger:      "axis",
        // axis-shadow follows the cursor's CATEGORY column, which lines
        // up with the bar centre — fixes the cursor/tooltip mismatch on
        // narrow x bands where the cursor was landing between two bars.
        axisPointer:  { type: "shadow" },
        confine:      true,
        extraCssText: SHARED_TOOLTIP_CSS,
      },
      grid: { top: 16, right: 16, bottom: 36, left: 36, containLabel: true },
      xAxis: {
        type: "category",
        data: xs,
        axisLine:  { lineStyle: { color: "rgba(100,116,139,0.55)" } },
        axisLabel: { color: "#64748b", fontSize: 10, rotate: xs.length > 8 ? -35 : 0 },
        axisTick:  { show: false },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLine:  { show: false },
        axisLabel: { color: "#64748b", fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(100,116,139,0.18)" } },
      },
      legend: {
        data: [t("chart.papers"), "Trend"],
        textStyle: { color: "#64748b", fontSize: 10 },
        right: 0, top: 0,
      },
      series: [
        {
          name: t("chart.papers"),
          type: "bar",
          data: ys,
          itemStyle: { color: COLORS.blue, borderRadius: [3, 3, 0, 0], opacity: 0.85 },
          barMaxWidth: 28,
          // The smooth-grow animation on first paint is the bit that
          // makes the chart feel alive.
          animationDuration: 600,
          animationEasing: "cubicOut",
        },
        {
          name: "Trend",
          type: "line",
          data: ys,
          smooth: true,
          symbol: "circle",
          symbolSize: 6,
          lineStyle: { color: COLORS.trend, width: 2 },
          itemStyle: { color: COLORS.trend },
          z: 5,
        },
      ],
    };
  }, [data, t]);

  // chartRef is forwarded INTO the EChartsHost so its
  // `useImperativeHandle` populates it with the chart instance handle
  // (`getInstance` / `toImageDataURL`). The hover-revealed download
  // chip in ChartCard reads from the same ref, so we don't bother
  // wiring it up at all in the empty-data branch.
  const chartRef = useRef<EChartsHostHandle | null>(null);
  if (data.length === 0) {
    return <ChartCard title={t("chart.papersByYear")}><EmptyChart /></ChartCard>;
  }
  return (
    <ChartCard title={t("chart.papersByYear")} chartRef={chartRef}>
      <EChartsHost ref={chartRef} option={option} className="h-full w-full" />
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Chart 2 · Bullseye — Methodology Rigor × Citation Impact (Cartesian).
//
// v1 used a polar scatter that depended on `evidence_score`, which most
// papers don't carry → blank chart in production. v2 is a CARTESIAN
// scatter with a robust fallback chain on both axes, plus dot-size
// encoding for paper age (newer = bigger). Result: the chart always
// renders meaningful data and answers a real question for the user
// ("which papers in the corpus are both methodologically solid AND
// well-cited?").
//
// Axes:
//   X (rigor)  — research_fit_score → evidence_score → evidence_strength
//                (Strong/Moderate/Limited/Weak) → paper_type heuristic.
//                Falls back to 50 only when nothing else is present.
//   Y (impact) — citation_count → relevance_score → score → 0.
//                Log-transformed because citations are heavy-tailed.
//
// Dot size encodes recency (newer papers = larger dot). The four
// quadrants surface the actionable insight: top-right = "well-supported
// AND influential" — the corpus's heaviest hitters.
// ─────────────────────────────────────────────────────────────────────────
function evidenceStrengthScore(s?: string): number | null {
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.includes("strong"))   return 90;
  if (lower.includes("moderate")) return 65;
  if (lower.includes("limited"))  return 40;
  if (lower.includes("weak"))     return 20;
  return null;
}

/** Each candidate is a (label, extractor) pair. Extractor returns the
 *  raw value or null when the field is missing on this paper. The chart
 *  picks the FIRST candidate whose extracted values have meaningful
 *  spread across the paper set (max-min ≥ MIN_SPREAD) — see
 *  `pickAxisSignal` below. This solves the Quick-mode bug where
 *  `research_fit_score` is technically present on every paper but
 *  always equals the placeholder 55, collapsing the chart to a single
 *  vertical line. */
type AxisCandidate = {
  label:   string;
  extract: (p: ChartPaper, indexInRankList: number) => number | null;
};

/** Minimum max-min spread (in 0..100 axis units) below which we treat
 *  a signal as "all the same" and try the next candidate. Tuned so a
 *  spread of 4 — typical of evidence_score after the LLM compression
 *  blend — still passes, while a uniform 55 across 30+ papers fails. */
const MIN_SPREAD = 5;

function evidenceFromStrength(p: ChartPaper): number | null {
  return evidenceStrengthScore(p.evidence_strength);
}

function rigorFromPaperType(p: ChartPaper): number | null {
  const ty = (p.paper_type_label || "").toLowerCase();
  if (!ty) return null;
  if (ty.includes("review") || ty.includes("meta")) return 70;
  if (ty.includes("survey")) return 65;
  if (ty.includes("empirical") || ty.includes("experimental")) return 60;
  if (ty.includes("theoretical")) return 55;
  return null;
}

function readScoreField(p: ChartPaper, key: "score" | "relevance_score"): number | null {
  const px = p as unknown as Record<string, unknown>;
  const v  = px[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v === "string") {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return null;
}

function readEvidenceScore(p: ChartPaper): number | null {
  const ev = typeof p.evidence_score === "number" ? p.evidence_score : Number(p.evidence_score ?? NaN);
  if (!Number.isFinite(ev) || ev <= 0) return null;
  // evidence_score is sometimes 0..1, sometimes 0..100 — heuristic
  // expand if it looks fractional.
  return Math.max(0, Math.min(100, ev <= 1 ? ev * 100 : ev));
}

function readResearchFit(p: ChartPaper): number | null {
  if (typeof p.research_fit_score !== "number") return null;
  return Math.max(0, Math.min(100, p.research_fit_score));
}

function readCitationCount(p: ChartPaper): number | null {
  const cc = typeof p.citation_count === "number" ? p.citation_count : Number(p.citation_count ?? NaN);
  if (!Number.isFinite(cc) || cc < 0) return null;
  return cc;
}

function readYear(p: ChartPaper): number | null {
  const m = String(p.year ?? "").match(/\d{4}/);
  return m ? Number(m[0]) : null;
}

/** Log-scale a heavy-tailed value (citation count) to a 0..100 visual.
 *  log1p flattens the long tail; capped at 1000 so beyond that the dot
 *  sits at the top edge. */
function impactVisual(raw: number): number {
  const capped = Math.min(1000, Math.max(0, raw));
  return (Math.log1p(capped) / Math.log1p(1000)) * 100;
}

/** Walk candidates in order, return the first whose extracted values
 *  show meaningful spread across the paper set. Returns the picked
 *  label + a per-paper coords array (with index-rank as last-resort
 *  fallback so the chart NEVER collapses to a line). The values
 *  returned are already in 0..100 axis units. */
function pickAxisSignal(
  papers: ChartPaper[],
  candidates: AxisCandidate[],
  normaliseToAxis: (raw: number, allRaw: number[]) => number,
  rankAxisLabel: string,
): { label: string; values: number[] } {
  for (const cand of candidates) {
    const raws: (number | null)[] = papers.map((p, i) => cand.extract(p, i));
    // Skip the candidate if any paper has a null reading — we want
    // a complete column, not interpolated holes.
    if (raws.some((v) => v == null)) continue;
    const numeric = raws as number[];
    const min = Math.min(...numeric);
    const max = Math.max(...numeric);
    // First do the raw-spread test in the candidate's native units;
    // it's cheaper than normalising N values just to throw them away.
    if (max - min < MIN_SPREAD) continue;
    const values = numeric.map((v) => normaliseToAxis(v, numeric));
    // Re-check spread after normalisation — defensive, since some
    // normalisers (log) can compress a borderline-passing raw spread
    // into a flat visual.
    const vMin = Math.min(...values);
    const vMax = Math.max(...values);
    if (vMax - vMin < MIN_SPREAD) continue;
    return { label: cand.label, values };
  }
  // Last resort — rank within the displayed list. Highest-ranked paper
  // (index 0) gets the highest value so the eye associates "top-right"
  // with "best of corpus". Spread is guaranteed: N papers → 0..100
  // evenly. The label changes too so the user knows the axis is now
  // "position in result list" rather than the failed primary signal.
  const n = Math.max(1, papers.length);
  return {
    label:  rankAxisLabel,
    values: papers.map((_, i) => (n === 1 ? 50 : 100 - (i / (n - 1)) * 100)),
  };
}

function clamp0to100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function recencySize(p: ChartPaper, oldestYear: number, newestYear: number): number {
  const m = String(p.year ?? "").match(/\d{4}/);
  if (!m) return 8;
  const y = Number(m[0]);
  if (newestYear === oldestYear) return 10;
  const t = (y - oldestYear) / (newestYear - oldestYear);
  return 6 + t * 10;  // 6..16 px
}

interface BullseyeDatum {
  value: [number, number, number, number]; // [rigor, impactVisual, citationsRaw, year]
  name:  string;
  itemStyle: { color: string; opacity: number };
  symbolSize: number;
}

// X-axis candidates — tried in order, first one with meaningful spread
// wins.  research_fit_score is first because when it's MEANT to vary
// (Curated mode, where the LLM actually rated each paper) it carries
// the most information, but Quick mode pins it at the placeholder 55
// so the spread test naturally falls through to score / evidence_score
// — which DO vary because the backend ranking pipeline writes them per
// paper.
const RIGOR_CANDIDATES: AxisCandidate[] = [
  { label: "Research fit",   extract: (p) => readResearchFit(p) },
  { label: "Relevance score", extract: (p) => readScoreField(p, "relevance_score") },
  { label: "Match score",    extract: (p) => readScoreField(p, "score") },
  { label: "Evidence score", extract: (p) => readEvidenceScore(p) },
  { label: "Evidence strength", extract: (p) => evidenceFromStrength(p) },
  { label: "Paper type",     extract: (p) => rigorFromPaperType(p) },
];

// Y-axis candidates — citation_count first because external validation
// is the strongest "impact" signal when available; fall through to
// year (recency) and score (rank-quality) so the chart always shows a
// meaningful Y even on un-cited preprints.
const IMPACT_CANDIDATES: AxisCandidate[] = [
  { label: "Citations",      extract: (p) => readCitationCount(p) },
  { label: "Relevance score", extract: (p) => readScoreField(p, "relevance_score") },
  { label: "Match score",    extract: (p) => readScoreField(p, "score") },
  { label: "Publication year", extract: (p) => readYear(p) },
];

export function BullseyeChartEC({ papers }: { papers: ChartPaper[] }) {
  const t = useT();

  const { points, xAxisLabel, yAxisLabel } = useMemo(() => {
    if (papers.length === 0) {
      return { points: [] as BullseyeDatum[], xAxisLabel: "Rigor", yAxisLabel: "Impact" };
    }
    const years = papers
      .map((p) => Number(String(p.year ?? "").match(/\d{4}/)?.[0] ?? NaN))
      .filter((n) => Number.isFinite(n));
    const oldestY = years.length ? Math.min(...years) : 2000;
    const newestY = years.length ? Math.max(...years) : 2025;

    // Pick the best X-axis signal. Scores already live in 0..100, so
    // the identity normaliser is correct for every candidate except
    // the year-fallback (handled below).
    const xPick = pickAxisSignal(
      papers,
      RIGOR_CANDIDATES,
      (raw) => clamp0to100(raw),
      "Rank position",
    );

    // Y-axis pick is a bit more nuanced because the candidates live in
    // very different units (citations: 0..thousands; year: 1900..2100;
    // scores: 0..100). The normaliser projects each into 0..100 using
    // the candidate's own min/max so the chart fills the canvas.
    const yPick = pickAxisSignal(
      papers,
      IMPACT_CANDIDATES,
      (raw, all) => {
        const min = Math.min(...all);
        const max = Math.max(...all);
        if (max <= min) return 50;
        // Citations are heavy-tailed → log scale.  Detect by range: a
        // span over 200 with values reaching >=50 is almost certainly
        // citation counts and benefits from log compression.
        if (max - min > 200 && max >= 50) return impactVisual(raw);
        return clamp0to100(((raw - min) / (max - min)) * 100);
      },
      "Rank position",
    );

    const datums: BullseyeDatum[] = papers.map((p, i) => {
      const src     = (p.source || "Unknown").trim() || "Unknown";
      const m       = String(p.year ?? "").match(/\d{4}/);
      const yr      = m ? Number(m[0]) : 0;
      // Tooltip needs the raw citation count for display when that's
      // what Y was derived from. When Y came from a different signal,
      // we fall back to the citation_count field (or 0).
      const rawCites = readCitationCount(p) ?? 0;
      return {
        value:      [xPick.values[i], yPick.values[i], rawCites, yr],
        name:       src,
        itemStyle:  {
          color:   SOURCE_PALETTE[hashString(src) % SOURCE_PALETTE.length],
          opacity: 0.78,
        },
        symbolSize: recencySize(p, oldestY, newestY),
      };
    });

    return { points: datums, xAxisLabel: xPick.label, yAxisLabel: yPick.label };
  }, [papers]);

  const option = useMemo(() => ({
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (p: { value: [number, number, number, number]; name?: string }) => {
        const [xVal, yVal, cites, yr] = p.value;
        // Show the axis label so the user understands which signal the
        // chart fell back to (when research_fit_score was degenerate
        // and we picked relevance_score / rank instead, the tooltip
        // tells them rather than mislabelling). Citations is shown
        // separately when the value > 0 because it's the most
        // information-dense field a paper can carry and almost
        // always interesting even when not the Y axis itself.
        const citesLine = cites > 0
          ? `<div style="font-size:10px;color:var(--ats-fg-muted);margin-top:2px;">Citations <span style="color:var(--ats-fg-primary);font-weight:600;">${cites.toFixed(0)}</span></div>`
          : "";
        return [
          `<div style="font-size:11px;font-weight:600;margin-bottom:4px;">${p.name || "Unknown"}${yr ? ` · ${yr}` : ""}</div>`,
          `<div style="font-size:10px;color:var(--ats-fg-muted);">`,
          `${xAxisLabel} <span style="color:var(--ats-fg-primary);font-weight:600;">${xVal.toFixed(0)}</span> ·`,
          ` ${yAxisLabel} <span style="color:var(--ats-fg-primary);font-weight:600;">${yVal.toFixed(0)}</span>`,
          `</div>`,
          citesLine,
        ].join("");
      },
      extraCssText: SHARED_TOOLTIP_CSS,
    },
    grid: { top: 18, right: 18, bottom: 32, left: 38, containLabel: true },
    xAxis: {
      type: "value",
      min:  0,
      max:  100,
      // Axis label reflects the picked signal — "Research fit" when
      // research_fit_score had spread, otherwise "Relevance score" /
      // "Match score" / etc. so a Quick-mode user doesn't see "Rigor"
      // for an axis that's actually scoring something else.
      name: xAxisLabel,
      nameLocation: "middle",
      nameGap:      24,
      nameTextStyle: { color: "#64748b", fontSize: 10, fontWeight: 600 },
      axisLine:  { lineStyle: { color: "rgba(100,116,139,0.45)" } },
      axisTick:  { show: false },
      axisLabel: { color: "#64748b", fontSize: 9 },
      splitLine: { lineStyle: { color: "rgba(100,116,139,0.18)" } },
    },
    yAxis: {
      type: "value",
      min:  0,
      max:  100,
      name: yAxisLabel,
      nameLocation: "middle",
      nameGap:      32,
      nameTextStyle: { color: "#64748b", fontSize: 10, fontWeight: 600 },
      axisLine:  { lineStyle: { color: "rgba(100,116,139,0.45)" } },
      axisTick:  { show: false },
      axisLabel: { color: "#64748b", fontSize: 9 },
      splitLine: { lineStyle: { color: "rgba(100,116,139,0.18)" } },
    },
    series: [{
      type:        "scatter",
      data:        points,
      // 50/50 quadrant guides via mark-lines so the user can read
      // upper-right = high-rigor + high-impact at a glance.
      markLine: {
        silent:    true,
        symbol:    "none",
        lineStyle: { color: "rgba(100,116,139,0.30)", type: "dashed" },
        data: [
          { xAxis: 50 },
          { yAxis: 50 },
        ],
      },
      animationDuration: 600,
      animationEasing: "cubicOut",
    }],
  }), [points, xAxisLabel, yAxisLabel]);

  const chartRef = useRef<EChartsHostHandle | null>(null);
  if (papers.length === 0) {
    return <ChartCard title={t("chart.bullseye") || "Rigor × Impact"}><EmptyChart /></ChartCard>;
  }
  return (
    <ChartCard title={t("chart.bullseye") || "Rigor × Impact"} chartRef={chartRef}>
      <EChartsHost ref={chartRef} option={option} className="h-full w-full" />
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Chart 3 · Source distribution donut
// ─────────────────────────────────────────────────────────────────────────
export function SourceDonutChartEC({ papers }: { papers: ChartPaper[] }) {
  const t = useT();

  const data = useMemo(() => {
    const counts: Record<string, number> = {};
    papers.forEach((p) => {
      const src = (p.source || "Unknown").trim() || "Unknown";
      counts[src] = (counts[src] ?? 0) + 1;
    });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return entries.map(([name, value]) => ({
      name,
      value,
      itemStyle: {
        color: SOURCE_PALETTE[hashString(name) % SOURCE_PALETTE.length],
      },
    }));
  }, [papers]);

  const option = useMemo(() => ({
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: "{b}: {c} ({d}%)",
      extraCssText: SHARED_TOOLTIP_CSS,
    },
    legend: {
      orient: "vertical",
      right:  4,
      top:    "middle",
      textStyle: { color: "#94a3b8", fontSize: 10 },
      itemWidth:  10,
      itemHeight: 10,
    },
    series: [{
      name: t("chart.bySource") || "Sources",
      type: "pie",
      radius: ["48%", "72%"],
      center: ["35%", "50%"],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      data,
      animationDuration: 700,
      animationEasing: "cubicOut",
    }],
  }), [data, t]);

  const chartRef = useRef<EChartsHostHandle | null>(null);
  if (papers.length === 0) {
    return <ChartCard title={t("chart.bySource") || "Sources"}><EmptyChart /></ChartCard>;
  }
  return (
    <ChartCard title={t("chart.bySource") || "Sources"} chartRef={chartRef}>
      <EChartsHost ref={chartRef} option={option} className="h-full w-full" />
    </ChartCard>
  );
}
