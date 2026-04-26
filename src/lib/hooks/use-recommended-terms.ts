// ─────────────────────────────────────────────────────────────────────────────
// useRecommendedTerms — daily-rotated chip strip for the workspace landing.
//
// Hits GET /api/workspace/recommended-terms once on mount and caches the
// resulting deck for the lifetime of the page. The backend returns a
// deterministic shuffle seeded by today's UTC date so every user sees the
// same chips on the same day; admin edits to the underlying pool surface
// from the next mount. We deliberately do NOT subscribe to changes — a
// hard refresh (or just the next session) is enough.
//
// FALLBACK_POOL keeps the landing UI alive when the backend is unreachable
// or the table is freshly migrated and empty. Kept in sync with the
// backend's DEFAULT_RECOMMENDED_TERMS so first paint never feels stale.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { fetchWithApiFallback } from "@/lib/api";

const FALLBACK_POOL: string[] = [
  "academic motivation in undergraduates",
  "machine learning for medical imaging",
  "climate adaptation in coastal cities",
  "large language model evaluation",
  "social media and adolescent wellbeing",
  "open science reproducibility",
  "renewable energy grid integration",
  "post-pandemic learning loss",
  "quantum error correction protocols",
  "gut microbiome and mental health",
  "carbon capture and storage",
  "transformer attention mechanisms",
];

/** Seeded shuffle so the fallback strip looks similar (but not identical)
 * to what the backend would have served — the same UTC date drives both. */
function dailySeededShuffle(pool: string[]): string[] {
  const today = new Date().toISOString().slice(0, 10);
  let seed = 0;
  for (let i = 0; i < today.length; i += 1) seed = (seed * 31 + today.charCodeAt(i)) >>> 0;
  const out = pool.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type RecommendedTermsBundle = {
  terms:      string[];
  /** Human-readable source label, e.g. "OpenAlex recent publications".
   * Empty when the frontend is showing the local FALLBACK_POOL. */
  source:     string;
  /** Click-through URL the frontend may render alongside the source. */
  sourceUrl:  string;
};

export function useRecommendedTerms(): RecommendedTermsBundle {
  const [bundle, setBundle] = useState<RecommendedTermsBundle>(() => ({
    terms:     dailySeededShuffle(FALLBACK_POOL),
    source:    "",
    sourceUrl: "",
  }));

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetchWithApiFallback("/api/workspace/recommended-terms");
        if (!res.ok) return;
        const data = (await res.json()) as {
          terms?: string[];
          source?: string;
          source_url?: string;
        };
        if (!alive) return;
        if (Array.isArray(data?.terms) && data.terms.length > 0) {
          setBundle({
            terms:     data.terms,
            source:    data.source ?? "",
            sourceUrl: data.source_url ?? "",
          });
        }
      } catch {
        // best-effort — fallback pool is already on screen
      }
    })();
    return () => { alive = false; };
  }, []);

  return bundle;
}
