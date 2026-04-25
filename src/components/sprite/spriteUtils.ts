import { NEW_CONTENT_PROMPTS } from "./spriteConstants";

// Word-overlap heuristic for "is this a fresh question, or just a tweak?".
// Returns true only when ≥ 50 % of the committed query's meaningful (>2-char)
// words have disappeared from the current query.
//   "mental helath" → "mental health"   → false (typo fix, no prompt)
//   "mental health" → "crypto markets"  → true  (full pivot, prompt fires)
export function looksLikeNewContent(committed: string, current: string): boolean {
  if (!committed) return false;
  const tok = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const a = tok(committed);
  const b = tok(current);
  if (a.size === 0) return false;
  let overlap = 0;
  for (const w of a) if (b.has(w)) overlap++;
  return overlap / a.size < 0.5;
}

// Deterministic prompt-line picker for the new-content confirmation. Keyed
// off the committed text so a given snapshot always shows the SAME prompt
// (no per-keystroke flicker), but different committed snapshots rotate
// through the pool across a session.
export function pickNewContentPrompt(committedQuery: string): string {
  if (!committedQuery) return NEW_CONTENT_PROMPTS[0];
  let h = 0;
  for (let i = 0; i < committedQuery.length; i++) {
    h = ((h << 5) - h + committedQuery.charCodeAt(i)) | 0;
  }
  return NEW_CONTENT_PROMPTS[Math.abs(h) % NEW_CONTENT_PROMPTS.length];
}
