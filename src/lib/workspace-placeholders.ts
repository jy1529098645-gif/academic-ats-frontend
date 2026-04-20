// ─────────────────────────────────────────────────────────────────────────────
// Rotating placeholder copy shown inside the Workspace textarea when empty.
// Extracted from page.tsx so new entries don't touch the component file.
//
// Each entry is a single string. Browser natural wrap handles line breaks —
// so if the container is wide enough to fit the whole phrase on one line,
// users see one line; otherwise the greedy wrap fills line 1 first and the
// remainder tails onto line 2 (top-heavy by default, which is what we want).
// ─────────────────────────────────────────────────────────────────────────────

export const WORKSPACE_PLACEHOLDERS: ReadonlyArray<string> = [
  "The world changes when thinking becomes clear.",
  "Thought is the beginning of everything.",
  "Every breakthrough starts as a question.",
  "Understanding is the first form of creation.",
  "Ideas are everywhere. Truth is not.",
  "You are closer to changing everything than you think.",
  "What you're thinking matters more than you know.",
  "You are not here to repeat knowledge. You are here to create it.",
  "Some ideas are meant to change everything.",
  "The future begins with a question.",
  "You bring the idea. We build the path.",
  "You think. We reason.",
  "I think, therefore I am.",
  "All truths are easy to understand once they are discovered; the point is to discover them.",
  "Thinking, existentially speaking, is a solitary but not a lonely business.",
  "To seek truth, begin with doubt.",
  "Truth is not the end of thought, but its reward.",
  "Thinking changes more than answers ever can.",
  "Every ascent begins with a harder question.",
];
