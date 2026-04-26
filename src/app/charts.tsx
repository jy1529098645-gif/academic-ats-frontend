"use client";

import { memo, useMemo } from "react";

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

// ── Unified chart typography & line spec ─────────────────────────────────────
// Every chart in this file reads from these constants so the axis treatment,
// legend sizing, and stroke weights stay visually consistent. Tweak a value
// here and it flows to the Year / Bullseye / Donut charts at once.
const CHART = {
  axisStroke:    C.label,   // #64748b — neutral for axes, arrows, ticks
  axisOpacity:   0.55,
  gridOpacity:   0.35,
  fontTick:      7,         // numeric tick labels
  fontAxis:      8,         // axis captions ("Year", "Methodology Rigor")
  fontLegend:    8.5,       // legend labels
  fontHint:      6.5,       // quadrant / secondary hint labels
  weightAxis:    600 as const,
  weightLegend:  500 as const,
  dotOpacity:    0.65,      // fill opacity for dots / bars
  dotStrokeOp:   0.5,       // stroke opacity for dots / bars
  sliceStrokeOp: 0.8,       // donut slice separator opacity
  legendDotR:    4.5,       // legend swatch radius
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
    <div className="ats-card p-3">
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
              <line x1={pad.l} y1={y} x2={pad.l + iW} y2={y} stroke={C.grid} strokeWidth={0.6} strokeOpacity={CHART.gridOpacity} className="chart-grid" />
              <text x={pad.l - 5} y={y + 4} textAnchor="end" fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontTick}>{t}</text>
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
                fill={C.blue} rx={2} opacity={CHART.dotOpacity}
              >
                <title>{year}: {count} paper{count !== 1 ? "s" : ""}</title>
              </rect>
              {showLabel && (
                <text
                  x={cx} y={pad.t + iH + 12} textAnchor="middle" fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontTick}
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
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + iH} stroke={CHART.axisStroke} strokeOpacity={CHART.axisOpacity} strokeWidth={0.9} className="chart-axis" />
        <line x1={pad.l} y1={pad.t + iH} x2={pad.l + iW} y2={pad.t + iH} stroke={CHART.axisStroke} strokeOpacity={CHART.axisOpacity} strokeWidth={0.9} className="chart-axis" />
        <text x={10} y={pad.t + iH / 2} textAnchor="middle" fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontAxis} fontWeight={CHART.weightAxis} transform={`rotate(-90,10,${pad.t + iH / 2})`}>count</text>

        {/* Legend */}
        <rect x={pad.l + iW - 82} y={pad.t + 2} width={10} height={7} fill={C.blue} opacity={CHART.dotOpacity} rx={1.5} />
        <text x={pad.l + iW - 69} y={pad.t + 9} fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontLegend} fontWeight={CHART.weightLegend}>Papers</text>
        <line x1={pad.l + iW - 29} y1={pad.t + 6} x2={pad.l + iW - 19} y2={pad.t + 6} stroke={C.trend} strokeWidth={2} />
        <circle cx={pad.l + iW - 24} cy={pad.t + 6} r={2.5} fill={C.trend} />
        <text x={pad.l + iW - 16} y={pad.t + 9} fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontLegend} fontWeight={CHART.weightLegend}>Trend</text>
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

/** SVG path for a filled circle or annulus (ring), using even-odd fill rule */
function annulusPath(cx: number, cy: number, outerR: number, innerR: number): string {
  const circ = (r: number) =>
    `M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} Z`;
  return innerR > 0 ? `${circ(outerR)} ${circ(innerR)}` : circ(outerR);
}

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
 * Derive a Methodology Rigor score in [0, 1] from paper_type_label.
 * Scale (user spec): qualitative/observational → empirical/experimental → RCT / systematic review / meta-analysis.
 * Falls back to evidence_strength tier, then research_fit_score, then 0.5 (centre).
 */
function methodologyRigor01(label?: string, evStrength?: string, rfScore?: number | null): number {
  if (label) {
    const scores: Record<string, number> = {
      "Meta":         0.96,   // meta-analysis
      "Review":       0.86,   // systematic / literature review
      "Quantitative": 0.78,   // RCT-adjacent experimental
      "Empirical":    0.70,
      "Mixed":        0.58,
      "Design":       0.46,
      "Case":         0.32,
      "Qualitative":  0.28,
      "Framework":    0.20,
      "Theory":       0.14,
      "Other":        0.42,
    };
    const s = scores[normType(label)];
    if (s !== undefined) return s;
  }
  const es = evidenceStrengthScore(evStrength);
  if (es !== null) return es / 100;
  if (rfScore != null && rfScore > 0) return Math.max(0.2, Math.min(0.9, rfScore / 100));
  return 0.5;
}

/**
 * Derive an Evidence Maturity score in [0, 1].
 * Scale (user spec): frontier/exploratory → emerging consensus → established consensus.
 * Primary signal = citation_count (log-normalised), secondary = evidence_score.
 */
function evidenceMaturity01(citationCount?: number | string, evidenceScore?: number | string, evStrength?: string): number {
  const cn = Number(citationCount);
  if (Number.isFinite(cn) && cn > 0) {
    // log10 mapping: 1 cite ≈ 0.15, 10 ≈ 0.45, 100 ≈ 0.75, 1000+ → 1.0
    const v = Math.log10(cn + 1) / 3.2;
    return Math.max(0.05, Math.min(1.0, v));
  }
  const ev = Number(evidenceScore);
  if (Number.isFinite(ev) && ev > 0) return Math.max(0.1, Math.min(0.95, ev / 100));
  const es = evidenceStrengthScore(evStrength);
  if (es !== null) return es / 100;
  return 0.35;
}

/** Arrowhead path for an axis line */
function arrowHead(x: number, y: number, dir: "up" | "right"): string {
  const s = 5;
  if (dir === "up")    return `M${x},${y} l-${s/2},${s} l${s},0 Z`;
  return                      `M${x},${y} l-${s},-${s/2} l0,${s} Z`;
}

// Visual concentric bands centred at (0.5, 0.5) — purely cosmetic "bullseye" rings.
const BULLSEYE_BANDS = [
  { innerR: 104, outerR: 136, fill: "rgba(59,130,246,0.04)", stroke: "#3b82f6" },
  { innerR: 68,  outerR: 104, fill: "rgba(59,130,246,0.08)", stroke: "#3b82f6" },
  { innerR: 32,  outerR: 68,  fill: "rgba(59,130,246,0.14)", stroke: "#3b82f6" },
  { innerR: 0,   outerR: 32,  fill: "rgba(59,130,246,0.22)", stroke: "#60a5fa" },
] as const;

export function BullseyeChart({ papers }: { papers: ChartPaper[] }) {
  const { dots, presentTypes } = useMemo(() => {
    if (papers.length === 0) return { dots: [], presentTypes: [] };

    const pseudoRand = (i: number, t: number): number => {
      let h = (i * 2654435761 + t * 40503) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
      h = Math.imul(h ^ (h >>> 11), 0xac4d6a45) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;
      return h / 0xffffffff;
    };

    const CX = 178, CY = 170, maxR = 136;
    // Plot box centred at (CX, CY). The axes span [0, 1] → [-plotR, +plotR] around centre.
    const plotR = maxR * 0.92;
    const typeSet = new Set<string>();

    const dots = papers.map((p, i) => {
      // X axis: Methodology Rigor (0 → 1, left = qualitative, right = meta-analysis)
      const rigor = methodologyRigor01(p.paper_type_label, p.evidence_strength, p.research_fit_score);
      // Y axis: Evidence Maturity (0 → 1, bottom = exploratory, top = established)
      const maturity = evidenceMaturity01(p.citation_count, p.evidence_score, p.evidence_strength);

      // Map [0, 1] → [-1, +1] so 0.5 lands at (CX, CY)
      const xNorm = (rigor    - 0.5) * 2;
      const yNorm = (maturity - 0.5) * 2;

      const jx = (pseudoRand(i, 5) * 2 - 1) * 4;
      const jy = (pseudoRand(i, 9) * 2 - 1) * 4;

      const wc = p.word_count ?? 0;
      const dotR = 2.5 + Math.min(4.5, (wc / 400) * 4.5);

      const bx = CX + xNorm * plotR + jx;
      const by = CY - yNorm * plotR + jy;
      const x  = Math.max(CX - maxR + dotR + 1, Math.min(CX + maxR - dotR - 1, bx));
      const y  = Math.max(CY - maxR + dotR + 1, Math.min(CY + maxR - dotR - 1, by));

      const type = normType(p.paper_type_label);
      typeSet.add(type);
      const color = TYPE_COLORS[type] ?? TYPE_COLORS["Other"];
      return { x, y, dotR, color, type, rigor, maturity };
    });

    return { dots, presentTypes: [...typeSet] };
  }, [papers]);

  if (dots.length === 0)
    return <ChartCard title="Bullseye · Methodology Rigor × Evidence Maturity"><EmptyChart msg="Need paper metadata" /></ChartCard>;

  const W = 356, H = 430, CX = 178, CY = 170, maxR = 136;
  const axisExt = maxR + 14;

  return (
    <ChartCard title="Bullseye · X = Methodology Rigor · Y = Evidence Maturity">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto chart-svg">

        {/* ── Concentric bands centred at (0.5, 0.5) ── */}
        {BULLSEYE_BANDS.map((band, i) => (
          <path
            key={`band-${i}`}
            d={annulusPath(CX, CY, band.outerR, band.innerR)}
            fill={band.fill}
            fillRule="evenodd"
            stroke={band.stroke}
            strokeOpacity={0.35}
            strokeWidth={0.6}
          />
        ))}

        {/* ── Crosshair axes through the centre ── */}
        <line x1={CX} y1={CY + axisExt} x2={CX} y2={CY - axisExt}
          stroke={CHART.axisStroke} strokeWidth={1} strokeOpacity={CHART.axisOpacity} />
        <path d={arrowHead(CX, CY - axisExt, "up")} fill={CHART.axisStroke} opacity={CHART.axisOpacity + 0.2} />
        <line x1={CX - axisExt} y1={CY} x2={CX + axisExt} y2={CY}
          stroke={CHART.axisStroke} strokeWidth={1} strokeOpacity={CHART.axisOpacity} />
        <path d={arrowHead(CX + axisExt, CY, "right")} fill={CHART.axisStroke} opacity={CHART.axisOpacity + 0.2} />

        {/* ── Axis tick marks at 0.0 / 0.5 / 1.0 ── */}
        {[0, 0.5, 1].map(t => {
          const tx = CX + (t - 0.5) * 2 * (maxR * 0.92);
          const ty = CY - (t - 0.5) * 2 * (maxR * 0.92);
          return (
            <g key={`t-${t}`}>
              <line x1={tx} y1={CY - 3} x2={tx} y2={CY + 3} stroke={CHART.axisStroke} strokeWidth={0.8} strokeOpacity={CHART.axisOpacity} />
              <line x1={CX - 3} y1={ty} x2={CX + 3} y2={ty} stroke={CHART.axisStroke} strokeWidth={0.8} strokeOpacity={CHART.axisOpacity} />
              {t !== 0.5 && (
                <>
                  <text x={tx} y={CY + 10} textAnchor="middle" fill={CHART.axisStroke} fontSize={CHART.fontTick} className="chart-label">{t.toFixed(1)}</text>
                  <text x={CX - 6} y={ty + 2} textAnchor="end" fill={CHART.axisStroke} fontSize={CHART.fontTick} className="chart-label">{t.toFixed(1)}</text>
                </>
              )}
            </g>
          );
        })}

        {/* ── Axis labels ── */}
        <text x={CX} y={CY - axisExt - 8} textAnchor="middle"
          fill={CHART.axisStroke} fontSize={CHART.fontAxis} fontWeight={CHART.weightAxis}
          className="chart-label">Evidence Maturity ↑</text>
        <text x={CX + axisExt - 2} y={CY - 10} textAnchor="end"
          fill={CHART.axisStroke} fontSize={CHART.fontAxis} fontWeight={CHART.weightAxis}
          className="chart-label">→ Methodology Rigor</text>

        {/* ── Quadrant hint labels ── */}
        <text x={CX + maxR - 4}  y={CY - maxR + 8}  fill={CHART.axisStroke} fontSize={CHART.fontHint} opacity={0.65} className="chart-label" textAnchor="end">Established · Rigorous</text>
        <text x={CX - maxR + 4}  y={CY - maxR + 8}  fill={CHART.axisStroke} fontSize={CHART.fontHint} opacity={0.65} className="chart-label" textAnchor="start">Established · Qualitative</text>
        <text x={CX + maxR - 4}  y={CY + maxR - 2}  fill={CHART.axisStroke} fontSize={CHART.fontHint} opacity={0.65} className="chart-label" textAnchor="end">Frontier · Rigorous</text>
        <text x={CX - maxR + 4}  y={CY + maxR - 2}  fill={CHART.axisStroke} fontSize={CHART.fontHint} opacity={0.65} className="chart-label" textAnchor="start">Frontier · Exploratory</text>

        {/* ── Dots (Cartesian: X = rigor, Y = maturity) ── */}
        {dots.map((d, i) => (
          <circle
            key={`dot-${i}`}
            cx={d.x} cy={d.y} r={d.dotR}
            fill={d.color} fillOpacity={CHART.dotOpacity}
            stroke={d.color} strokeWidth={0.6} strokeOpacity={CHART.dotStrokeOp}
          >
            <title>{d.type} · rigor {d.rigor.toFixed(2)} · maturity {d.maturity.toFixed(2)}</title>
          </circle>
        ))}

        {/* ── Summary line ── */}
        <text x={CX} y={CY + maxR + 18} textAnchor="middle" fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontLegend} fontWeight={CHART.weightLegend}>
          {dots.length} paper{dots.length !== 1 ? "s" : ""}{" · "}X = rigor{" · "}Y = maturity{" · "}dot size = word count
        </text>

        {/* ── Type colour legend ── */}
        {presentTypes.slice(0, 12).map((type, i) => {
          const col   = i % 3;
          const row   = Math.floor(i / 3);
          const lx    = 8 + col * 116;
          const ly    = CY + maxR + 32 + row * 17;
          const color = TYPE_COLORS[type] ?? TYPE_COLORS["Other"];
          return (
            <g key={`leg-${type}`}>
              <circle cx={lx + 5} cy={ly - 4} r={CHART.legendDotR} fill={color} fillOpacity={CHART.dotOpacity + 0.15} />
              <text x={lx + 13} y={ly} fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontLegend} fontWeight={CHART.weightLegend}>{type}</text>
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
            fill={s.color} fillRule="evenodd" opacity={CHART.dotOpacity + 0.15}
            stroke="#040b19" strokeWidth={1.2} strokeOpacity={CHART.sliceStrokeOp}
          >
            <title>{s.label}: {s.count} · {grandTotal > 0 ? Math.round(s.count / grandTotal * 100) : 0}%</title>
          </path>
        ))}

        {/* ── outer ring: source distribution ── */}
        {srcSlices.map((s) => (
          <path
            key={`src-${s.src}`}
            d={donutSlice(CX, CY, innerR, outerR, s.start, s.end)}
            fill={s.color} fillRule="evenodd" opacity={CHART.dotOpacity}
            stroke="#040b19" strokeWidth={1.2} strokeOpacity={CHART.sliceStrokeOp}
          >
            <title>{s.src}: {s.total} papers · {Math.round(s.total / grandTotal * 100)}%</title>
          </path>
        ))}

        {/* ── center label ── */}
        <text x={CX} y={CY - 6} textAnchor="middle" fill="white" fontSize={17} fontWeight={700} className="chart-center-num">{grandTotal}</text>
        <text x={CX} y={CY + 10} textAnchor="middle" fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontAxis} fontWeight={CHART.weightAxis}>papers</text>

        {/* ── inner ring % labels ── */}
        {oaSlices.filter((s) => s.end - s.start > 20).map((s) => {
          const [lx, ly] = polarXY(CX, CY, (oaInner + oaOuter) / 2, (s.start + s.end) / 2);
          const pct = grandTotal > 0 ? Math.round(s.count / grandTotal * 100) : 0;
          return (
            <text key={`oa-lbl-${s.label}`} x={lx} y={ly + 3.5}
              textAnchor="middle" fill="white" fontSize={CHART.fontLegend} fontWeight={700}>
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
              textAnchor="middle" fill={s.color} fontSize={CHART.fontTick} fontWeight={600} opacity={0.9}>
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
              <rect x={lx} y={ly - 7} width={8} height={8} fill={s.color} opacity={CHART.dotOpacity + 0.15} rx={1.5} />
              <text x={lx + 11} y={ly} fill={CHART.axisStroke} className="chart-label" fontSize={CHART.fontLegend} fontWeight={CHART.weightLegend}>
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
// memo'd because the parent (page.tsx) re-renders on every keystroke,
// hover, panel toggle, etc. Without this wrapper PaperCharts re-walks
// its three SVG sub-charts on every parent render, even though the
// `papers` array only actually changes once per search. The default
// shallow comparison is sufficient — page.tsx already memoises the
// `displayedPapers` array via useMemo, so its reference is stable
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
