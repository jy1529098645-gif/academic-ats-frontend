// Shared paper-shape used by every chart component (the SVG/legacy
// wrappers in src/app/charts.tsx AND the echarts-rendered replacements
// in src/components/charts/EChartsTrendCharts.tsx). Lives in a
// dependency-free module so both files can import without a circular
// graph. `year` is `string | number` to stay compatible with the
// canonical Paper in @/lib/types — every call site stringifies + regex-
// extracts the 4-digit year, so widening the type is purely a type-
// level change.
export type ChartPaper = {
  year?: string | number;
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
