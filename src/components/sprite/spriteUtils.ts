import { NEW_CONTENT_PROMPTS } from "./spriteConstants";

// Wide kaomoji palette used for the rotation helper below. Text-only
// glyphs — never coloured / graphical emoji. Order is irrelevant; we
// pick uniformly from whichever glyph is NOT in the recently-used set.
const KAOMOJI_PALETTE: readonly string[] = [
  "(◕‿◕)", "(˙ᵕ˙)", "(´･ω･`)", "(◡‿◡)", "(｡•́ᴗ•̀｡)",
  "(´｡• ᵕ •｡`)", "(¬‿¬)", "(⌒‿⌒)", "(✿◠‿◠)", "(˘ω˘)",
  "(*ˊᵕˋ*)", "(=^･ω･^=)", "(•‿•)", "(´∀`)", "(*˘︶˘*)",
];

// Last few kaomoji we returned, kept short so the palette can keep
// circulating without quickly re-repeating the most-recent face.
const _recentKaomoji: string[] = [];
const _RECENT_LIMIT = 4;

/**
 * pickKaomoji — return a kaomoji that wasn't one of the last few we
 * returned. Used both for canned sprite lines and to swap the trailing
 * kaomoji of any AI-generated voice line so the user doesn't see the
 * same face on consecutive bubbles.
 */
export function pickKaomoji(): string {
  const eligible = KAOMOJI_PALETTE.filter(k => !_recentKaomoji.includes(k));
  const pool     = eligible.length > 0 ? eligible : KAOMOJI_PALETTE.slice();
  const choice   = pool[Math.floor(Math.random() * pool.length)];
  _recentKaomoji.push(choice);
  while (_recentKaomoji.length > _RECENT_LIMIT) _recentKaomoji.shift();
  return choice;
}

// Loose match for trailing kaomoji — covers most ASCII / fullwidth-paren
// faces our backend + canned lines produce. Strips at most one trailing
// kaomoji and any whitespace before it.
const _TRAILING_KAOMOJI_RE = /\s*[(（][^)）]{0,30}[)）]\s*$/;

/**
 * swapKaomoji — if `msg` ends with a kaomoji, replace it with a freshly
 * picked one from the rotation. If it doesn't, append one. Keeps the
 * sprite's expression varied even when the source line (LLM or canned)
 * keeps falling back to the same face.
 */
export function swapKaomoji(msg: string): string {
  if (!msg) return msg;
  const stripped = msg.replace(_TRAILING_KAOMOJI_RE, "").trimEnd();
  return `${stripped} ${pickKaomoji()}`;
}

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
