"use client";

import { useMemo } from "react";

// ── Minimal paper shape needed by charts ─────────────────────────────────────
export type ChartPaper = {
  year?: string;
  source?: string;
  is_oa?: boolean | number | string;
  evidence_score?: number | string;
  score?: number | string;
  paper_type_label?: string;
  domain_fit_label?: string;
  citation_count?: number | string;   // used by BullseyeChart X-axis when available
};

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  blue:    "#3b82f6",
  teal:    "#2dd4bf",
  emerald: "#10b981",
  amber:   "#f59e0b",
  rose:    "#f43f5e",
  red:     "#ef4444",
  grid:    "#1e293b",
  tick:    "#475569",
  label:   "#64748b",
  trend:   "#93c5fd",   // blue-300 — lighter shade of the primary interface blue
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / target;
  const mag   = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
  const step  = Math.max(1, Math.ceil(rough / mag) * mag);
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(v);
  return ticks;
}

/** Robustly evaluate is_oa — handles boolean, number 0/1, and strings */
function isOA(val: boolean | number | string | undefined): boolean {
  if (val === true || val === 1) return true;
  if (typeof val === "string") return val.toLowerCase() === "true" || val === "1";
  return false;
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-slate-950/40 p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{title}</div>
      {children}
    </div>
  );
}

function EmptyChart({ msg = "No data yet" }: { msg?: string }) {
  return (
    <div className="flex h-24 items-center justify-center rounded-xl text-xs text-slate-600">
      {msg}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart 1 · Publication Year Distribution + Trend Line
// ─────────────────────────────────────────────────────────────────────────────
export function YearDistributionChart({ papers }: { papers: ChartPaper[] }) {
  const data = useMemo(() => {
    const counts: Record<string, number> = {};
    papers.forEach((p) => {
      const y = String(p.year ?? "").match(/\d{4}/)?.[0];
      if (y) counts[y] = (counts[y] ?? 0) + 1;
    });
    return Object.entries(counts).sort(([a], [b]) => Number(a) - Number(b));
  }, [papers]);

  if (data.length === 0)
    return <ChartCard title="Publication Year"><EmptyChart /></ChartCard>;

  const W = Math.max(420, data.length * 18 + 50);
  const H = 230;
  const pad = { t: 16, r: 14, b: 46, l: 36 };
  const iW  = W - pad.l - pad.r;
  const iH  = H - pad.t - pad.b;

  const maxN  = Math.max(...data.map(([, n]) => n));
  const ticks = niceTicks(maxN);
  const yMax  = ticks[ticks.length - 1];
  const bandW = iW / data.length;
  const barW  = Math.max(4, Math.min(26, bandW * 0.65));
  const step  = data.length <= 6 ? 1 : data.length <= 12 ? 2 : Math.ceil(data.length / 6);

  // Trend line points
  const trendPoints = data.map(([, count], i) => {
    const cx = pad.l + (i + 0.5) * bandW;
    const y  = pad.t + iH - (count / yMax) * iH;
    return `${cx},${y}`;
  }).join(" ");

  return (
    <ChartCard title="Publication Year · Bars = count · Line = trend">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto chart-svg">
        {/* Grid + Y ticks */}
        {ticks.map((t) => {
          const y = pad.t + iH - (t / yMax) * iH;
          return (
            <g key={t}>
              <line x1={pad.l} y1={y} x2={pad.l + iW} y2={y} stroke={C.grid} strokeWidth={0.6} className="chart-grid" />
              <text x={pad.l - 5} y={y + 4} textAnchor="end" fill={C.label} className="chart-label" fontSize={9}>{t}</text>
            </g>
          );
        })}

        {/* Bars */}
        {data.map(([year, count], i) => {
          const bH  = (count / yMax) * iH;
          const cx  = pad.l + (i + 0.5) * bandW;
          const y   = pad.t + iH - bH;
          const showLabel = i % step === 0 || i === data.length - 1;
          return (
            <g key={year}>
              <rect
                x={cx - barW / 2} y={y} width={barW} height={Math.max(bH, 0)}
                fill={C.blue} rx={2} opacity={0.55}
              >
                <title>{year}: {count} paper{count !== 1 ? "s" : ""}</title>
              </rect>
              {showLabel && (
                <text
                  x={cx} y={pad.t + iH + 12} textAnchor="middle" fill={C.label} className="chart-label" fontSize={8.5}
                  transform={data.length > 8 ? `rotate(-40,${cx},${pad.t + iH + 12})` : undefined}
                >
                  {year}
                </text>
              )}
            </g>
          );
        })}

        {/* Trend line */}
        {data.length > 1 && (
          <polyline
            points={trendPoints}
            fill="none"
            stroke={C.trend}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.85}
          />
        )}

        {/* Trend dots */}
        {data.map(([year, count], i) => {
          const cx = pad.l + (i + 0.5) * bandW;
          const cy = pad.t + iH - (count / yMax) * iH;
          return (
            <circle key={`dot-${year}`} cx={cx} cy={cy} r={3} fill={C.trend} opacity={0.9}>
              <title>{year}: {count}</title>
            </circle>
          );
        })}

        {/* Axes */}
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + iH} stroke={C.tick} strokeWidth={0.9} className="chart-axis" />
        <line x1={pad.l} y1={pad.t + iH} x2={pad.l + iW} y2={pad.t + iH} stroke={C.tick} strokeWidth={0.9} className="chart-axis" />
        <text x={10} y={pad.t + iH / 2} textAnchor="middle" fill={C.label} className="chart-label" fontSize={8} transform={`rotate(-90,10,${pad.t + iH / 2})`}>count</text>

        {/* Legend */}
        <rect x={pad.l + iW - 82} y={pad.t + 2} width={10} height={7} fill={C.blue} opacity={0.55} rx={1.5} />
        <text x={pad.l + iW - 69} y={pad.t + 9} fill={C.label} className="chart-label" fontSize={7.5}>Papers</text>
        <line x1={pad.l + iW - 29} y1={pad.t + 6} x2={pad.l + iW - 19} y2={pad.t + 6} stroke={C.trend} strokeWidth={2} />
        <circle cx={pad.l + iW - 24} cy={pad.t + 6} r={2.5} fill={C.trend} />
        <text x={pad.l + iW - 16} y={pad.t + 9} fill={C.label} className="chart-label" fontSize={7.5}>Trend</text>
      </svg>
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Chart 3 · Domain Fit Bullseye
// ─────────────────────────────────────────────────────────────────────────────

function normType(raw?: string): string {
  if (!raw) return "Other";
  const r = raw.toLowerCase();
  if (r.includes("empirical"))                                      return "Empirical";
  if (r.includes("systematic") || r.includes("literature review"))  return "Review";
  if (r.includes("meta"))                                           return "Meta";
  if (r.includes("framework") || r.includes("conceptual"))         return "Framework";
  if (r.includes("case"))                                           return "Case";
  if (r.includes("theor"))                                          return "Theory";
  if (r.includes("mixed"))                                          return "Mixed";
  if (r.includes("qualit"))                                         return "Qualitative";
  if (r.includes("quantit"))                                        return "Quantitative";
  if (r.includes("design"))                                         return "Design";
  const first = raw.trim().split(/\s+/)[0];
  return first.length > 10 ? first.slice(0, 9) + "…" : first;
}

function normDomain(raw?: string): string {
  if (!raw) return "Adjacent";
  const r = raw.toLowerCase();
  if (r.startsWith("direct") || r === "core")           return "Direct";
  if (r.includes("mostly") || r.includes("highly"))     return "Mostly Direct";
  if (r.includes("adjacent") || r.includes("partial"))  return "Adjacent";
  if (r.includes("off") || r.includes("weak"))          return "Off-Target";
  return "Adjacent";
}

/** SVG path for a filled circle or annulus (ring), using even-odd fill rule */
function annulusPath(cx: number, cy: number, outerR: number, innerR: number): string {
  const circ = (r: number) =>
    `M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} Z`;
  return innerR > 0 ? `${circ(outerR)} ${circ(innerR)}` : circ(outerR);
}

// Rings rendered outer → inner so inner always sits on top visually
const BULLSEYE_RINGS = [
  { domain: "Off-Target",    innerR: 104, outerR: 136, fill: "rgba(244,63,94,0.07)",   stroke: "#f43f5e" },
  { domain: "Adjacent",      innerR: 68,  outerR: 104, fill: "rgba(245,158,11,0.09)",  stroke: "#f59e0b" },
  { domain: "Mostly Direct", innerR: 32,  outerR: 68,  fill: "rgba(59,130,246,0.12)",  stroke: "#3b82f6" },
  { domain: "Direct",        innerR: 0,   outerR: 32,  fill: "rgba(16,185,129,0.20)",  stroke: "#10b981" },
] as const;

const TYPE_COLORS: Record<string, string> = {
  "Empirical":    "#3b82f6",
  "Review":       "#8b5cf6",
  "Framework":    "#f59e0b",
  "Case":         "#10b981",
  "Theory":       "#2dd4bf",
  "Mixed":        "#f97316",
  "Meta":         "#ec4899",
  "Qualitative":  "#84cc16",
  "Quantitative": "#06b6d4",
  "Design":       "#fb923c",
  "Other":        "#94a3b8",
};

// ── Bullseye helpers ──────────────────────────────────────────────────────────
/** Safely convert any score-like value to a number in [0, 100] */
function toScore(v: number | string | undefined, fallback = 50): number {
  if (v == null) return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : Math.min(100, Math.max(0, n));
}

/** Arrowhead path for an axis line */
function arrowHead(x: number, y: number, dir: "up" | "right"): string {
  const s = 5;
  if (dir === "up")    return `M${x},${y} l-${s/2},${s} l${s},0 Z`;
  return                      `M${x},${y} l-${s},-${s/2} l0,${s} Z`;
}

export function BullseyeChart({ papers }: { papers: ChartPaper[] }) {
  const { dots, presentTypes, axisLabels } = useMemo(() => {
    if (papers.length === 0)
      return { dots: [], presentTypes: [], axisLabels: { x: "Score", y: "Methodology" } };

    // ── Stable deterministic pseudo-random in [0, 1] for paper i, axis tag t ─
    // Uses a simple bijective integer hash so every (i, t) pair gives a unique,
    // stable value without depending on any mutable state.
    const pseudoRand = (i: number, t: number): number => {
      let h = (i * 2654435761 + t * 40503) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
      h = Math.imul(h ^ (h >>> 11), 0xac4d6a45) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;
      return h / 0xffffffff; // [0, 1]
    };

    // ── domain label → 4-tier score baseline [0, 100] ────────────────────
    // Gives natural vertical spread even when evidence_score is absent.
    const domainBase = (label: string | undefined): number => {
      const d = normDomain(label);
      if (d === "Direct")        return 82;
      if (d === "Mostly Direct") return 64;
      if (d === "Adjacent")      return 40;
      return 20; // Off-Target
    };

    // ── Collect raw field values ──────────────────────────────────────────
    const n = papers.length;
    const rawScore    = papers.map(p => toScore(p.score, -1));
    const rawEvidence = papers.map(p =>
      p.evidence_score != null ? toScore(p.evidence_score, -1) : -1
    );
    // Citation: log-scale so a 1000-citation paper doesn't dwarf a 10-citation one
    const rawCitation = papers.map(p => {
      const c = Number(p.citation_count);
      return Number.isFinite(c) && c >= 0 ? Math.min(100, Math.log1p(c) * 14.4) : -1;
    });

    // ── How many papers have a real (non-default) value for each field? ───
    const countReal = (arr: number[]) => arr.filter(v => v >= 0).length;
    const citReal  = countReal(rawCitation);
    const evReal   = countReal(rawEvidence);
    const scoreReal = papers.filter(p => p.score != null).length;

    // Range of a series (ignoring sentinel -1)
    const realRange = (arr: number[]): number => {
      const vals = arr.filter(v => v >= 0);
      if (vals.length < 2) return 0;
      return Math.max(...vals) - Math.min(...vals);
    };

    // ── Choose X axis ─────────────────────────────────────────────────────
    // Priority: citation (if ≥ 40% populated) → score (if range ≥ 8) → domain+jitter
    let xLabel: string;
    let xBases: number[];

    if (citReal >= n * 0.4) {
      xBases = rawCitation.map((v, i) => v >= 0 ? v : domainBase(papers[i].domain_fit_label));
      xLabel = "Citation Count (log)";
    } else if (scoreReal >= n * 0.4 && realRange(rawScore) >= 8) {
      xBases = rawScore.map((v, i) => v >= 0 ? v : 50);
      xLabel = "Relevance Score";
    } else {
      // All scores identical or absent → use domain baseline so rings spread horizontally
      xBases = papers.map(p => domainBase(p.domain_fit_label));
      xLabel = "Relevance Score";
    }

    // ── Choose Y axis ─────────────────────────────────────────────────────
    // Priority: evidence_score (if ≥ 40% populated AND range ≥ 8) → domain+jitter
    let yLabel = "Methodology Strength";
    let yBases: number[];

    if (evReal >= n * 0.4 && realRange(rawEvidence) >= 8) {
      yBases = rawEvidence.map((v, i) => v >= 0 ? v : domainBase(papers[i].domain_fit_label));
    } else {
      // evidence_score absent or flat → domain-derived 4-tier baseline
      yBases = papers.map(p => domainBase(p.domain_fit_label));
    }

    // ── Add deterministic jitter to both axes ─────────────────────────────
    // Even when real data has good range, a small jitter prevents exact overlaps.
    // Jitter amplitude scales inversely with data quality: less jitter when data
    // has real spread, more when we're relying on the domain fallback.
    const xJitterAmp = xLabel === "Citation Count (log)" ? 4 : realRange(xBases) >= 20 ? 4 : 14;
    const yJitterAmp = evReal >= n * 0.4 && realRange(rawEvidence) >= 8 ? 4 : 12;

    const xValues = xBases.map((b, i) => b + (pseudoRand(i, 1) * 2 - 1) * xJitterAmp);
    const yValues = yBases.map((b, i) => b + (pseudoRand(i, 2) * 2 - 1) * yJitterAmp);

    // ── Normalize to chart space ─────────────────────────────────────────
    const xMin = Math.min(...xValues), xMax = Math.max(...xValues);
    const yMin = Math.min(...yValues), yMax = Math.max(...yValues);
    // Guarantee minimum range so dots are never all at center
    const xRange = Math.max(20, xMax - xMin);
    const yRange = Math.max(20, yMax - yMin);
    const xMid = (xMin + xMax) / 2;
    const yMid = (yMin + yMax) / 2;

    const CX = 178, CY = 170;
    const plotR = 125;

    const typeSet = new Set<string>();
    const dots = papers.map((p, i) => {
      const xv = xValues[i];
      const yv = yValues[i];
      const dx = ((xv - xMid) / xRange) * plotR * 1.65;
      const dy = -((yv - yMid) / yRange) * plotR * 1.65; // SVG y flipped

      const dist = Math.sqrt(dx * dx + dy * dy);
      const clampFactor = dist > plotR ? plotR / dist : 1;
      const x = CX + dx * clampFactor;
      const y = CY + dy * clampFactor;

      const dotR = 1.8 + (Math.max(0, yv) / 100) * 2.2;
      const type   = normType(p.paper_type_label);
      const domain = normDomain(p.domain_fit_label);
      typeSet.add(type);
      const color = TYPE_COLORS[type] ?? TYPE_COLORS["Other"];
      return { x, y, dotR, color, type, domain, xVal: Math.round(xv), yVal: Math.round(yv) };
    });

    return {
      dots,
      presentTypes: [...typeSet],
      axisLabels: { x: xLabel, y: yLabel },
    };
  }, [papers]);

  if (dots.length === 0)
    return <ChartCard title="Scatter · Methodology vs Citation"><EmptyChart msg="Need score data" /></ChartCard>;

  const W = 356, H = 430, CX = 178, CY = 170, maxR = 136;
  const axisExt = maxR + 14; // axis lines extend a bit past outer ring

  return (
    <ChartCard title={`Scatter · ${axisLabels.y} vs ${axisLabels.x} · dot size = methodology`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto chart-svg">

        {/* ── Background rings (visual reference only) ── */}
        {BULLSEYE_RINGS.map(({ domain, innerR, outerR, fill, stroke }) => (
          <path
            key={`ring-${domain}`}
            d={annulusPath(CX, CY, outerR, innerR)}
            fill={fill}
            fillRule="evenodd"
            stroke={stroke}
            strokeWidth={0.7}
            opacity={0.7}
          />
        ))}

        {/* ── Crosshair axes ── */}
        {/* Y axis (Methodology Strength — up) */}
        <line
          x1={CX} y1={CY + axisExt}
          x2={CX} y2={CY - axisExt}
          stroke="#3b82f6" strokeWidth={1.1} strokeOpacity={0.55}
        />
        <path d={arrowHead(CX, CY - axisExt, "up")} fill="#3b82f6" opacity={0.7} />

        {/* X axis (Citation Count — right) */}
        <line
          x1={CX - axisExt} y1={CY}
          x2={CX + axisExt} y2={CY}
          stroke="#3b82f6" strokeWidth={1.1} strokeOpacity={0.55}
        />
        <path d={arrowHead(CX + axisExt, CY, "right")} fill="#3b82f6" opacity={0.7} />

        {/* Axis labels */}
        <text
          x={CX} y={CY - axisExt - 8}
          textAnchor="middle" fill="#60a5fa"
          fontSize={8} fontWeight={600} opacity={0.85}
          className="chart-label"
        >{axisLabels.y} ↑</text>
        <text
          x={CX + axisExt - 2} y={CY - 10}
          textAnchor="end" fill="#60a5fa"
          fontSize={8} fontWeight={600} opacity={0.85}
          className="chart-label"
        >→ {axisLabels.x}</text>

        {/* Quadrant micro-labels */}
        <text x={CX + 6}  y={CY - 6} fill="#94a3b8" fontSize={6.5} opacity={0.5} className="chart-label">High both</text>
        <text x={CX - 50} y={CY - 6} fill="#94a3b8" fontSize={6.5} opacity={0.5} className="chart-label" textAnchor="end">Rigorous</text>
        <text x={CX + 6}  y={CY + 10} fill="#94a3b8" fontSize={6.5} opacity={0.5} className="chart-label">Cited</text>
        <text x={CX - 50} y={CY + 10} fill="#94a3b8" fontSize={6.5} opacity={0.5} className="chart-label" textAnchor="end">Low</text>

        {/* ── Dots (positioned by real data) ── */}
        {dots.map((d, i) => (
          <circle
            key={`dot-${i}`}
            cx={d.x} cy={d.y} r={d.dotR}
            fill={d.color} fillOpacity={0.50}
            stroke={d.color} strokeWidth={0.6} strokeOpacity={0.35}
          >
            <title>{d.type} · {d.domain} · {axisLabels.x}={Math.round(d.xVal)} · {axisLabels.y}={Math.round(d.yVal)}</title>
          </circle>
        ))}

        {/* ── Ring domain labels — placed at 210° (lower-left arc), horizontal ── */}
        {BULLSEYE_RINGS.map(({ domain, innerR, outerR, stroke }) => {
          const midR = innerR > 0 ? (innerR + outerR) / 2 : outerR * 0.52;
          // 210° in standard math coords = lower-left in SVG (y-down)
          // lx = CX + cos(210°)*midR,  ly = CY − sin(210°)*midR
          // cos(210°) = −0.866,  sin(210°) = −0.5  →  ly = CY + 0.5*midR
          const rad = (210 * Math.PI) / 180;
          const lx = CX + Math.cos(rad) * midR;
          const ly = CY - Math.sin(rad) * midR;
          return (
            <text
              key={`rl-${domain}`}
              x={lx} y={ly}
              textAnchor="middle"
              fill={stroke} fontSize={6.5} fontWeight={600} opacity={0.70}
              className="chart-label"
            >
              {domain}
            </text>
          );
        })}

        {/* ── Summary line ── */}
        <text x={CX} y={CY + maxR + 18} textAnchor="middle" fill={C.label} className="chart-label" fontSize={7.5}>
          {dots.length} paper{dots.length !== 1 ? "s" : ""}{" · "}centre = median{" · "}larger dot = stronger methodology
        </text>

        {/* ── Type color legend ── */}
        {presentTypes.slice(0, 12).map((type, i) => {
          const col   = i % 3;
          const row   = Math.floor(i / 3);
          const lx    = 8 + col * 116;
          const ly    = CY + maxR + 32 + row * 17;
          const color = TYPE_COLORS[type] ?? TYPE_COLORS["Other"];
          return (
            <g key={`leg-${type}`}>
              <circle cx={lx + 5} cy={ly - 4} r={4.5} fill={color} fillOpacity={0.82} />
              <text x={lx + 13} y={ly} fill={C.label} className="chart-label" fontSize={8.5}>{type}</text>
            </g>
          );
        })}
      </svg>
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart 4 · Source Distribution — nested donut
//   Outer ring = source share  |  Inner ring = OA vs Non-OA
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_COLORS = [
  "#3b82f6","#8b5cf6","#10b981","#f97316","#ec4899",
  "#06b6d4","#84cc16","#f43f5e","#2dd4bf","#94a3b8",
  "#a855f7","#14b8a6","#f59e0b","#6366f1","#22d3ee",
  "#fb923c","#4ade80","#e879f9",
];

/** Polar (degrees, 0° = top/12-o'clock) → SVG cartesian */
function polarXY(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/**
 * SVG path for a donut slice.
 * For the degenerate full-circle case, falls back to annulusPath (needs fillRule="evenodd").
 */
function donutSlice(
  cx: number, cy: number,
  innerR: number, outerR: number,
  startDeg: number, endDeg: number,
): string {
  if (endDeg - startDeg >= 359.9) return annulusPath(cx, cy, outerR, innerR);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const [sx,  sy]  = polarXY(cx, cy, outerR, startDeg);
  const [ex,  ey]  = polarXY(cx, cy, outerR, endDeg);
  const [eix, eiy] = polarXY(cx, cy, innerR, endDeg);
  const [six, siy] = polarXY(cx, cy, innerR, startDeg);
  return `M${sx} ${sy} A${outerR} ${outerR} 0 ${large} 1 ${ex} ${ey} L${eix} ${eiy} A${innerR} ${innerR} 0 ${large} 0 ${six} ${siy} Z`;
}

export function SourceDonutChart({ papers }: { papers: ChartPaper[] }) {
  const { srcData, totalOA, totalNonOA, grandTotal } = useMemo(() => {
    const counts: Record<string, { oa: number; noa: number }> = {};
    papers.forEach((p) => {
      const src = p.source || "Unknown";
      if (!counts[src]) counts[src] = { oa: 0, noa: 0 };
      if (isOA(p.is_oa)) counts[src].oa++;
      else                counts[src].noa++;
    });
    const srcData = Object.entries(counts)
      .map(([src, { oa, noa }]) => ({ src, oa, noa, total: oa + noa }))
      .sort((a, b) => b.total - a.total);
    const grandTotal  = srcData.reduce((s, d) => s + d.total, 0);
    const totalOA     = srcData.reduce((s, d) => s + d.oa, 0);
    const totalNonOA  = grandTotal - totalOA;
    return { srcData, totalOA, totalNonOA, grandTotal };
  }, [papers]);

  if (srcData.length === 0)
    return <ChartCard title="Source Distribution"><EmptyChart /></ChartCard>;

  const W = 340, CX = 170, CY = 155;
  const outerR = 120, innerR = 92;      // outer ring: source share
  const oaOuter = 80,  oaInner = 48;   // inner ring: OA vs Non-OA
  const GAP = srcData.length > 1 ? 1.2 : 0; // gap between slices in degrees

  // ── outer ring slices ──────────────────────────────────────────────────────
  let deg = 0;
  const srcSlices = srcData.map((s, i) => {
    const span  = (s.total / grandTotal) * 360;
    const start = deg + GAP / 2;
    const end   = deg + span - GAP / 2;
    deg += span;
    return { ...s, start, end, color: SOURCE_COLORS[i % SOURCE_COLORS.length] };
  });

  // ── inner ring slices ──────────────────────────────────────────────────────
  const oaDeg = grandTotal > 0 ? (totalOA / grandTotal) * 360 : 0;
  type OASlice = { label: string; count: number; color: string; start: number; end: number };
  const oaSlices: OASlice[] = [
    { label: "OA",     count: totalOA,   color: C.emerald, start: GAP/2,        end: oaDeg - GAP/2 },
    { label: "Non-OA", count: totalNonOA, color: C.amber,  start: oaDeg + GAP/2, end: 360 - GAP/2  },
  ].filter((s) => s.count > 0 && s.end > s.start + 0.5);

  const shorten  = (s: string) => s.length > 15 ? s.slice(0, 14) + "…" : s;
  const legendY0 = CY + outerR + 20;
  const srcRows  = Math.ceil(srcSlices.length / 2);
  const H        = legendY0 + srcRows * 16 + 30;

  return (
    <ChartCard title="Source Distribution · outer = source share · inner = OA / Non-OA">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto chart-svg">

        {/* ── inner ring: OA vs Non-OA ── */}
        {oaSlices.map((s) => (
          <path
            key={`oa-${s.label}`}
            d={donutSlice(CX, CY, oaInner, oaOuter, s.start, s.end)}
            fill={s.color} fillRule="evenodd" opacity={0.82}
            stroke="#040b19" strokeWidth={1.2}
          >
            <title>{s.label}: {s.count} · {grandTotal > 0 ? Math.round(s.count / grandTotal * 100) : 0}%</title>
          </path>
        ))}

        {/* ── outer ring: source distribution ── */}
        {srcSlices.map((s) => (
          <path
            key={`src-${s.src}`}
            d={donutSlice(CX, CY, innerR, outerR, s.start, s.end)}
            fill={s.color} fillRule="evenodd" opacity={0.70}
            stroke="#040b19" strokeWidth={1.2}
          >
            <title>{s.src}: {s.total} papers · {Math.round(s.total / grandTotal * 100)}%</title>
          </path>
        ))}

        {/* ── center label ── */}
        <text x={CX} y={CY - 6} textAnchor="middle" fill="white" fontSize={17} fontWeight={700} className="chart-center-num">{grandTotal}</text>
        <text x={CX} y={CY + 10} textAnchor="middle" fill={C.label} className="chart-label" fontSize={8}>papers</text>

        {/* ── inner ring % labels ── */}
        {oaSlices.filter((s) => s.end - s.start > 20).map((s) => {
          const [lx, ly] = polarXY(CX, CY, (oaInner + oaOuter) / 2, (s.start + s.end) / 2);
          const pct = grandTotal > 0 ? Math.round(s.count / grandTotal * 100) : 0;
          return (
            <text key={`oa-lbl-${s.label}`} x={lx} y={ly + 3.5}
              textAnchor="middle" fill="white" fontSize={7.5} fontWeight={700}>
              {pct}%
            </text>
          );
        })}

        {/* ── outer ring % labels (only for larger slices) ── */}
        {srcSlices.filter((s) => s.end - s.start > 24).map((s) => {
          const midDeg = (s.start + s.end) / 2;
          const [lx, ly] = polarXY(CX, CY, outerR + 13, midDeg);
          const pct = Math.round(s.total / grandTotal * 100);
          return (
            <text key={`src-lbl-${s.src}`} x={lx} y={ly + 3}
              textAnchor="middle" fill={s.color} fontSize={7} fontWeight={600} opacity={0.9}>
              {pct}%
            </text>
          );
        })}

        {/* ── source legend (2 columns) ── */}
        {srcSlices.map((s, i) => {
          const col   = i % 2;
          const row   = Math.floor(i / 2);
          const lx    = 6 + col * 168;
          const ly    = legendY0 + row * 16;
          const pct   = Math.round(s.total / grandTotal * 100);
          const oaPct = s.total > 0 ? Math.round(s.oa / s.total * 100) : 0;
          return (
            <g key={`leg-${s.src}`}>
              <rect x={lx} y={ly - 7} width={8} height={8} fill={s.color} opacity={0.80} rx={1.5} />
              <text x={lx + 11} y={ly} fill={C.label} className="chart-label" fontSize={7.5}>
                {shorten(s.src)} {s.total} ({pct}% · {oaPct}% OA)
              </text>
            </g>
          );
        })}

        {/* ── OA summary row at bottom of legend ── */}
        {(() => {
          const by = legendY0 + srcRows * 16 + 8;
          return (
            <>
              <rect x={6}  y={by}     width={8} height={8} fill={C.emerald} opacity={0.82} rx={1.5} />
              <text x={17} y={by + 8} fill={C.label} className="chart-label" fontSize={7.5}>OA: {totalOA}</text>
              <rect x={72} y={by}     width={8} height={8} fill={C.amber}   opacity={0.65} rx={1.5} />
              <text x={83} y={by + 8} fill={C.label} className="chart-label" fontSize={7.5}>Non-OA: {totalNonOA}</text>
            </>
          );
        })()}
      </svg>
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite export
// ─────────────────────────────────────────────────────────────────────────────
export function PaperCharts({ papers, wide = false }: { papers: ChartPaper[]; wide?: boolean }) {
  if (papers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-slate-600">
        <div className="text-4xl opacity-30">📊</div>
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
