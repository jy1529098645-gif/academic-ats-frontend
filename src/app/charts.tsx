"use client";

// ─────────────────────────────────────────────────────────────────────────────
// charts.tsx — paper-analytics chart pack.
//
// Previously this file held three hand-rolled SVG charts
// (YearDistribution / Bullseye / SourceDonut). That version is now
// retired; the three charts have been replaced by echarts-rendered
// equivalents in `src/components/charts/EChartsTrendCharts.tsx`, which
// ship the same data shape but add real tooltips, smooth re-render
// transitions on data updates, DPR-aware crisp rendering, and a
// per-chart Download chip.
//
// This wrapper preserves the public surface (`PaperCharts` +
// `ChartPaper`) so every consumer (page.tsx, MobileApp.tsx) keeps
// importing from `@/app/charts` unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { memo } from "react";
import {
  YearDistributionChartEC,
  BullseyeChartEC,
  SourceDonutChartEC,
} from "@/components/charts/EChartsTrendCharts";
import type { ChartPaper as ChartPaperType } from "@/lib/chart-types";

// Re-export ChartPaper so existing `import { ChartPaper } from "@/app/charts"`
// call sites keep compiling — the type now lives in @/lib/chart-types
// (dependency-free module) so the EChartsTrendCharts file can import it
// without a circular dependency back through this wrapper.
export type ChartPaper = ChartPaperType;

// Backwards-compatible aliases. Anything in the codebase that still
// references the SVG-era chart names by import keeps working without a
// rename pass.
export const YearDistributionChart = YearDistributionChartEC;
export const BullseyeChart         = BullseyeChartEC;
export const SourceDonutChart      = SourceDonutChartEC;

// `memo` because the parent (page.tsx / MobileApp.tsx) re-renders on
// every keystroke, hover, panel toggle, etc.  Without this wrapper
// PaperCharts re-walks its three sub-charts on every parent render
// even though the `papers` array only actually changes once per
// search.  Shallow comparison is sufficient — call sites already
// memoise `displayedPapers` via useMemo so its reference is stable
// across unrelated re-renders.
function PaperChartsImpl({ papers, wide = false }: { papers: ChartPaper[]; wide?: boolean }) {
  if (papers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-slate-600">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
          <path d="M3 3v18h18" />
          <path d="M7 15l3-3 3 3 5-5" />
        </svg>
        <div className="text-xs">Run a search to see analytics</div>
      </div>
    );
  }
  return (
    <div className={wide ? "grid grid-cols-2 gap-3" : "space-y-4"}>
      <YearDistributionChart papers={papers} />
      <BullseyeChart         papers={papers} />
      <SourceDonutChart      papers={papers} />
    </div>
  );
}
export const PaperCharts = memo(PaperChartsImpl);
