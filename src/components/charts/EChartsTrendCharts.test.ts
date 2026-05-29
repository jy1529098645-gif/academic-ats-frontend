// Vitest spec for the Bullseye axis-picker — the layer that decides
// WHICH paper field becomes the X/Y axis based on whether the field
// actually varies across the result set.  Tested in isolation (no
// echarts render) so jsdom doesn't have to set up canvas/SVG.
//
// The bug being pinned here:  Quick-mode searches give every paper
// `research_fit_score = 55` (the placeholder default; see
// paper_ranking.py:_default_second_stage_meta).  The previous chart
// picked research_fit_score first regardless and produced a vertical
// line at x=55.  This spec proves the new pickAxisSignal walks past
// the degenerate signal and picks a varying one instead.

import { describe, it, expect } from "vitest";
import type { ChartPaper } from "@/lib/chart-types";
import {
  __pickAxisSignal,
  __RIGOR_CANDIDATES,
  __IMPACT_CANDIDATES,
  __MIN_SPREAD,
  __clamp0to100,
  __impactVisual,
} from "./EChartsTrendCharts";

// Identity normaliser for axes that already live in 0..100.
const identityNorm = (raw: number) => __clamp0to100(raw);

// Helper to build a synthetic paper with the fields we care about for
// the axis pick — keeps the test cases compact.
function p(overrides: Partial<ChartPaper>): ChartPaper {
  return { year: 2023, source: "OpenAlex", ...overrides };
}

describe("pickAxisSignal — X axis (rigor candidates)", () => {
  it("picks 'Research fit' when research_fit_score varies across papers", () => {
    // Curated-mode shape: the LLM rerank wrote a real fit score per paper.
    const papers: ChartPaper[] = [
      p({ research_fit_score: 82 }),
      p({ research_fit_score: 65 }),
      p({ research_fit_score: 90 }),
      p({ research_fit_score: 48 }),
    ];
    const pick = __pickAxisSignal(papers, __RIGOR_CANDIDATES, identityNorm, "Rank position");
    expect(pick.label).toBe("Research fit");
    // Spread should be preserved through the identity normaliser.
    expect(Math.max(...pick.values) - Math.min(...pick.values)).toBeGreaterThanOrEqual(__MIN_SPREAD);
  });

  it("falls through past research_fit_score = 55 (Quick-mode placeholder) to the next varying signal", () => {
    // The bug case.  Every paper has the placeholder 55.  Score field
    // varies because the backend ranking pipeline writes it per paper.
    const papers: ChartPaper[] = [
      p({ research_fit_score: 55, score: 87 }),
      p({ research_fit_score: 55, score: 71 }),
      p({ research_fit_score: 55, score: 62 }),
      p({ research_fit_score: 55, score: 44 }),
      p({ research_fit_score: 55, score: 33 }),
    ];
    const pick = __pickAxisSignal(papers, __RIGOR_CANDIDATES, identityNorm, "Rank position");
    // Must NOT pick "Research fit" — that's the degenerate signal we're
    // trying to skip.
    expect(pick.label).not.toBe("Research fit");
    // The next varying candidate is relevance_score or score; in this
    // dataset only `score` is present so we expect "Match score".
    expect(pick.label).toBe("Match score");
    // Sanity: the picked values should actually vary on screen.
    const spread = Math.max(...pick.values) - Math.min(...pick.values);
    expect(spread).toBeGreaterThanOrEqual(__MIN_SPREAD);
  });

  it("falls all the way through to 'Rank position' when every candidate is constant", () => {
    // Pathological case — no candidate varies enough.  We MUST still
    // produce a varying axis so the chart never collapses to a line.
    const papers: ChartPaper[] = Array.from({ length: 6 }, () =>
      p({ research_fit_score: 55, score: 50, paper_type_label: "" }),
    );
    const pick = __pickAxisSignal(papers, __RIGOR_CANDIDATES, identityNorm, "Rank position");
    expect(pick.label).toBe("Rank position");
    const spread = Math.max(...pick.values) - Math.min(...pick.values);
    // Rank-position fallback spreads evenly across 0..100.
    expect(spread).toBeGreaterThanOrEqual(80);
  });

  it("returns a single mid-axis value for a single paper (no division by zero)", () => {
    const papers: ChartPaper[] = [p({ research_fit_score: 55 })];
    const pick = __pickAxisSignal(papers, __RIGOR_CANDIDATES, identityNorm, "Rank position");
    expect(pick.values).toHaveLength(1);
    expect(pick.values[0]).toBeGreaterThanOrEqual(0);
    expect(pick.values[0]).toBeLessThanOrEqual(100);
  });

  it("skips candidates that have null gaps (some papers missing the field)", () => {
    // Mixed nulls — research_fit on 2 of 4 papers, score on every paper.
    // Strict-no-null rule: research_fit candidate is skipped despite
    // having spread, because not every paper carries it.
    const papers: ChartPaper[] = [
      p({ research_fit_score: 80, score: 50 }),
      p({ research_fit_score: undefined, score: 60 }),
      p({ research_fit_score: 40, score: 70 }),
      p({ research_fit_score: undefined, score: 80 }),
    ];
    const pick = __pickAxisSignal(papers, __RIGOR_CANDIDATES, identityNorm, "Rank position");
    expect(pick.label).not.toBe("Research fit");
  });
});

describe("pickAxisSignal — Y axis (impact candidates)", () => {
  // Y normaliser mirrors the chart's behaviour: log-scale when the raw
  // range looks like citation counts, linear min-max otherwise.
  const yNorm = (raw: number, all: number[]) => {
    const min = Math.min(...all);
    const max = Math.max(...all);
    if (max <= min) return 50;
    if (max - min > 200 && max >= 50) return __impactVisual(raw);
    return __clamp0to100(((raw - min) / (max - min)) * 100);
  };

  it("picks 'Citations' when papers have varied citation_count", () => {
    const papers: ChartPaper[] = [
      p({ citation_count: 42 }),
      p({ citation_count: 5 }),
      p({ citation_count: 180 }),
      p({ citation_count: 0 }),
    ];
    const pick = __pickAxisSignal(papers, __IMPACT_CANDIDATES, yNorm, "Rank position");
    expect(pick.label).toBe("Citations");
  });

  it("falls through to year when citations are all zero / missing", () => {
    // Common for fresh preprints — every paper uncited so the citation
    // signal is degenerate.  Year should still vary and become Y.
    const papers: ChartPaper[] = [
      p({ citation_count: 0, year: 2023 }),
      p({ citation_count: 0, year: 2020 }),
      p({ citation_count: 0, year: 2025 }),
      p({ citation_count: 0, year: 2018 }),
    ];
    const pick = __pickAxisSignal(papers, __IMPACT_CANDIDATES, yNorm, "Rank position");
    // Either "Relevance score" / "Match score" (if score is present and
    // varying — not in this dataset) or "Publication year".
    expect(pick.label).toBe("Publication year");
  });

  it("renders unique X positions for Quick-mode-shaped data (the regression test)", () => {
    // End-to-end check on the actual bug shape: 10 papers from a
    // Quick search.  Build the X axis via the picker and assert that
    // we get >=3 distinct values — proving the chart isn't a line.
    const papers: ChartPaper[] = Array.from({ length: 10 }, (_, i) => p({
      research_fit_score: 55,           // placeholder for every paper
      score:              90 - i * 7,   // varies per paper (backend rank score)
      citation_count:     undefined,    // missing on Quick-mode papers
      paper_type_label:   "research article",
    }));
    const xPick = __pickAxisSignal(papers, __RIGOR_CANDIDATES, identityNorm, "Rank position");
    const uniqueX = new Set(xPick.values.map((v) => Math.round(v)));
    expect(uniqueX.size).toBeGreaterThanOrEqual(3);
  });
});
