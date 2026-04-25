// Sprite voice pools — one place to add / tune the cat-sprite's micro-lines.
//
// All three pools follow the same style rules:
//   * No coloured / graphical emoji — kaomoji only (text glyphs only).
//   * ≤ ~10 words per line.
//   * Lowercase, fragments welcome, friendly + curious tone.
// Backend assess endpoint enforces the same style on AI-generated lines via
// _scrub_sprite_message (see academic-ats-backend/main.py).

// Instant typing reactions — fire after a short "thinking" pause so the
// sprite always feels mulling-it-over rather than shouting canned words.
// The 900 ms AI verdict then takes over the same slot. Rotated
// deterministically by index so consecutive edits cycle through.
export const INSTANT_REACTIONS: readonly string[] = [
  "ooh watching~",
  "mm ok ok",
  "hmm interesting",
  "oh?",
  "let me see~",
  "mm mm",
  "ooh tell me more",
  "paying attention",
  "peeking at your words (˙ᵕ˙)",
  "curious curious",
  "go on~",
  "ok ok ok",
  "watching you type (◕‿◕)",
  "oh neat",
  "mm carry on",
  "ooh something new",
  "alright, following along",
  "hmm i see~",
  "yay, writing something?",
  "paws ready (´･ω･`)",
  "oh interesting angle",
  "mm thoughtful",
  "ok i'm here",
  "listening listening",
  "got my ears up",
  "ooh yes go~",
  "mm reading along",
  "oh cool direction",
  "alright alright",
  "keeping up (◡‿◡)",
  "i'm with you",
  "ooh ok ok",
  "watching quietly",
  "hmm what else?",
  "go on, don't stop",
  "mm taking notes",
];

// Quick / Curated mode-toggle reactions — only fired from the user's manual
// toggle. AI-driven recommend-mode replies write their own longer line, so
// these short canned ones are reserved for explicit user clicks.
export const MODE_SWITCH_LINES_QUICK: readonly string[] = [
  "quick it is~ fast smart ranking, good for a skim",
  "ok quick mode, seconds-fast results (◕‿◕)",
  "going quick, great for rapid scanning",
  "quick search on, light touch and speedy (˙ᵕ˙)",
  "skim mode, smart ranking, in and out",
];

export const MODE_SWITCH_LINES_CURATED: readonly string[] = [
  "curated, nice — deep dive with agent screening",
  "going deep, multi-agent analysis takes a few minutes",
  "curated mode on, adversarial screening kicks in (˙ᵕ˙)",
  "ok deep dive, slower but more careful",
  "full analysis incoming, sit tight (◡‿◡)",
];

// "You typed something materially different from what's committed — start
// over?" prompts. Picked deterministically from the committed text's hash
// so the prompt stays stable on a given snapshot but rotates between
// sessions.
export const NEW_CONTENT_PROMPTS: readonly string[] = [
  "different path, huh? (◕‿◕)",
  "ooh, new question?",
  "wait — changing direction? (˙ᵕ˙)",
  "mm, something fresh?",
  "going somewhere new? (｡•́ᴗ•̀｡)",
  "whole new angle?",
  "changed your mind? (˙ᵕ˙)",
  "different topic brewing?",
  "oh, pivoting?",
  "new thread starting?",
];
