// ─────────────────────────────────────────────────────────────────────────────
// Shared cross-page types.
//
// These were previously duplicated across src/app/page.tsx,
// src/app/search/page.tsx, and src/components/mobile/MobileApp.tsx. The
// duplication kept the three files independent at the cost of small
// drift — adding a `paper_type_label` field on the desktop Paper meant
// remembering to mirror it on mobile (it usually wasn't, so chips that
// rendered fine on desktop appeared as `undefined` on mobile).
//
// We deliberately centralise only the types whose runtime contracts are
// the SAME across all three pages:
//
//   · `WorkflowItem` — identical shape in all three copies.
//   · `Paper`        — desktop's was a strict superset of mobile/search;
//                      every field that was optional anywhere stays
//                      optional here, so all existing call sites keep
//                      type-checking unchanged.
//
// `QueryOption` and `SearchResponse` are NOT centralised — those drift
// is meaningful (search/page.tsx requires `label` and renders it as a
// string; page.tsx allows it to be optional). Forcing a single shape
// would require refactoring every render site, which is exactly the
// kind of risk we're avoiding here.
// ─────────────────────────────────────────────────────────────────────────────

// One step in the multi-agent search trace. Used by:
//   · the desktop "collaboration trace" rail
//   · the mobile workflow drawer
//   · the search-page progress events
// All three previously defined the type identically; this is the merged
// shape verbatim.
export type WorkflowItem = {
  agent?:   string;
  action?:  string;
  details?: string;
};

// Canonical Paper shape. Sourced from the desktop page.tsx version, which
// was the most fully-typed of the three. Mobile and search-page copies
// covered a strict subset of these fields, so importing this everywhere
// is backwards-compatible: nothing they used has been removed or
// re-required. Numeric fields stay `number | string` because the backend
// occasionally serialises scores as strings when computed from a
// non-numeric pipeline (e.g. percentile labels).
export type Paper = {
  title:                  string;
  authors?:               string;
  year?:                  string | number;
  source?:                string;
  score?:                 number | string;
  summary?:               string;
  url?:                   string;
  is_oa?:                 boolean;
  oa_url?:                string;
  pdf_url?:               string;
  doi?:                   string;
  evidence_strength?:     string;
  evidence_score?:        number | string;
  recommendation_reason?: string;
  research_fit_score?:    number;
  domain_fit_label?:      string;
  paper_type_label?:      string;
  off_target_risk_score?: number;
  ranking_reason?:        string;
  citation_count?:        number | string;
  evidence_breakdown?:    Record<string, number>;
  word_count?:            number;
  raw?:                   Record<string, unknown>;
};
