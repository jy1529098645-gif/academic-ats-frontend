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
  evidence_strength?: string;         // "Strong" | "Moderate" | "Limited" | "Weak" — Y fallback
  research_fit_score?: number | null; // 0–100 numeric fit — secondary Y fallback
  citation_count?: number | string;   // used by BullseyeChart X-axis when available
  word_count?: number;                // used by BullseyeChart for dot size
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

/** Maps evidence_strength string to a methodology proxy score (fallback when paper_type_label absent). */
function evidenceStrengthScore(s?: string): number | null {
  if (!s) return null;
  const map: Record<string, number> = {
    "very strong": 88, "strong": 80, "high": 80,
    "moderate": 62, "medium": 62,
    "limited": 46, "low": 46, "weak": 38,
  };
  return map[s.toLowerCase()] ?? null;
}

/**
 * Derive a methodology-rigour score (0–100) from paper_type_label.
 * Used for the Y axis ("Methodology Strength ↑").
 * Meta-analyses and empirical studies rank highest; theoretical/other rank lowest.
 * Falls back to evidence_strength tier, then research_fit_score, then 50 (centre).
 */
function methodologyScore(label?: string, evStrength?: string, rfScore?: number | null): number {
  // Primary: paper_type_label (only available in deep/curated mode after LLM enrichment)
  if (label) {
    const scores: Record<string, number> = {
      "Meta":         93,
      "Empirical":    85,
      "Quantitative": 82,
      "Mixed":        76,
      "Review":       70,
      "Qualitative":  65,
      "Design":       58,
      "Framework":    54,
      "Case":         49,
      "Theory":       44,
      "Other":        40,
    };
    const s = scores[normType(label)];
    if (s !== undefined) return s;
  }
  // Fallback 1: evidence_strength tier (available in fast mode from rule ranker)
  const es = evidenceStrengthScore(evStrength);
  if (es !== null) return es;
  // Fallback 2: research_fit_score (numeric, 0–100)
  if (rfScore != null && rfScore > 0) return Math.max(30, Math.min(95, rfScore));
  // Default: centre
  return 50;
}

/** Arrowhead path for an axis line */
function arrowHead(x: number, y: number, dir: "up" | "right"): string {
  const s = 5;
  if (dir === "up")    return `M${x},${y} l-${s/2},${s} l${s},0 Z`;
  return                      `M${x},${y} l-${s},-${s/2} l0,${s} Z`;
}

export function BullseyeChart({ papers }: { papers: ChartPaper[] }) {
  const { dots, presentTypes } = useMemo(() => {
    if (papers.length === 0) return { dots: [], presentTypes: [] };

    // Stable deterministic hash for reproducible per-paper jitter
    const pseudoRand = (i: number, t: number): number => {
      let h = (i * 2654435761 + t * 40503) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
      h = Math.imul(h ^ (h >>> 11), 0xac4d6a45) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;
      return h / 0xffffffff;
    };

    const CX = 178, CY = 170, maxR = 136;
    // Usable plotting radius — leave room for dot radius
    const plotR = maxR * 0.92;
    const typeSet = new Set<string>();

    const dots = papers.map((p, i) => {
      // ── X axis: Relevance Score (evidence_score, 0–100) ──────────────────────
      // Right side of chart = higher relevance.
      const relevance = p.evidence_score != null ? toScore(p.evidence_score) : toScore(p.score, 50);

      // ── Y axis: Methodology Strength (derived from paper_type_label, 0–100) ──
      // Top of chart = stronger methodology.
      // Fallback chain: paper_type_label → evidence_strength tier → research_fit_score → 50
      const meth = methodologyScore(p.paper_type_label, p.evidence_strength, p.research_fit_score);

      // Normalise both axes to [-1, +1] so 50 maps to the chart centre.
      const xNorm = (relevance - 50) / 50;   // positive → right half
      const yNorm = (meth      - 50) / 50;   // positive → top half (SVG Y inverted)

      // Small deterministic jitter (±5 px) to prevent exact overlap
      const jx = (pseudoRand(i, 5) * 2 - 1) * 5;
      const jy = (pseudoRand(i, 9) * 2 - 1) * 5;

      // Dot size = content volume (word count)
      const wc  = p.word_count ?? 0;
      const dotR = 2.5 + Math.min(4.5, (wc / 400) * 4.5);

      // Clamp to stay inside outer ring
      const bx = CX + xNorm * plotR + jx;
      const by = CY - yNorm * plotR + jy;   // minus because SVG Y grows downward
      const x  = Math.max(CX - maxR + dotR + 1, Math.min(CX + maxR - dotR - 1, bx));
      const y  = Math.max(CY - maxR + dotR + 1, Math.min(CY + maxR - dotR - 1, by));

      const type   = normType(p.paper_type_label);
      const domain = normDomain(p.domain_fit_label);
      typeSet.add(type);
      const color = TYPE_COLORS[type] ?? TYPE_COLORS["Other"];
      return { x, y, dotR, color, type, domain, score: relevance, meth };
    });

    return { dots, presentTypes: [...typeSet] };
  }, [papers]);

  if (dots.length === 0)
    return <ChartCard title="Bullseye · Score vs Methodology"><EmptyChart msg="Need score data" /></ChartCard>;

  const W = 356, H = 430, CX = 178, CY = 170, maxR = 136;
  const axisExt = maxR + 14;

  return (
    <ChartCard title="Bullseye · X = relevance · Y = methodology strength">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto chart-svg">

        {/* ── Background rings ── */}
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
        <line x1={CX} y1={CY + axisExt} x2={CX} y2={CY - axisExt}
          stroke="#3b82f6" strokeWidth={1.1} strokeOpacity={0.55} />
        <path d={arrowHead(CX, CY - axisExt, "up")} fill="#3b82f6" opacity={0.7} />
        <line x1={CX - axisExt} y1={CY} x2={CX + axisExt} y2={CY}
          stroke="#3b82f6" strokeWidth={1.1} strokeOpacity={0.55} />
        <path d={arrowHead(CX + axisExt, CY, "right")} fill="#3b82f6" opacity={0.7} />

        {/* ── Axis labels ── */}
        <text x={CX} y={CY - axisExt - 8} textAnchor="middle"
          fill="#60a5fa" fontSize={8} fontWeight={600} opacity={0.85}
          className="chart-label">Methodology Strength ↑</text>
        <text x={CX + axisExt - 2} y={CY - 10} textAnchor="end"
          fill="#60a5fa" fontSize={8} fontWeight={600} opacity={0.85}
          className="chart-label">→ Relevance Score</text>

        {/* ── Quadrant micro-labels ── */}
        <text x={CX + 6}  y={CY - 6}  fill="#94a3b8" fontSize={6.5} opacity={0.5} className="chart-label">Best picks</text>
        <text x={CX - 50} y={CY - 6}  fill="#94a3b8" fontSize={6.5} opacity={0.5} className="chart-label" textAnchor="end">Rigorous</text>
        <text x={CX + 6}  y={CY + 10} fill="#94a3b8" fontSize={6.5} opacity={0.5} className="chart-label">High fit</text>
        <text x={CX - 50} y={CY + 10} fill="#94a3b8" fontSize={6.5} opacity={0.5} className="chart-label" textAnchor="end">Low priority</text>

        {/* ── Dots (2D Cartesian: X=relevance, Y=methodology) ── */}
        {dots.map((d, i) => (
          <circle
            key={`dot-${i}`}
            cx={d.x} cy={d.y} r={d.dotR}
            fill={d.color} fillOpacity={0.6}
            stroke={d.color} strokeWidth={0.6} strokeOpacity={0.5}
          >
            <title>{d.type} · {d.domain} · relevance {d.score} · methodology {d.meth}</title>
          </circle>
        ))}

        {/* ── Ring domain labels at 210° arc ── */}
        {BULLSEYE_RINGS.map(({ domain, innerR, outerR, stroke }) => {
          const midR = innerR > 0 ? (innerR + outerR) / 2 : outerR * 0.52;
          const rad  = (210 * Math.PI) / 180;
          const lx   = CX + Math.cos(rad) * midR;
          const ly   = CY - Math.sin(rad) * midR;
          return (
            <text key={`rl-${domain}`} x={lx} y={ly} textAnchor="middle"
              fill={stroke} fontSize={6.5} fontWeight={600} opacity={0.70}
              className="chart-label">{domain}
            </text>
          );
        })}

        {/* ── Summary line ── */}
        <text x={CX} y={CY + maxR + 18} textAnchor="middle" fill={C.label} className="chart-label" fontSize={7.5}>
          {dots.length} paper{dots.length !== 1 ? "s" : ""}{" · "}X = relevance{" · "}Y = methodology{" · "}dot size = word count
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
