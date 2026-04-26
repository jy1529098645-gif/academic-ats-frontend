// ─────────────────────────────────────────────────────────────────────────────
// hover-help-store — tiny Zustand slice for the sprite "what does this button
// do?" overlay.
//
// Why a store: setting hover-help text via React's local useState in page.tsx
// triggers a re-render of the WHOLE 8000-line component every time the user's
// mouse enters or leaves any button — and there are 12+ buttons that wire up
// `helpProps`. That was a substantial chunk of the INP=504 ms regression
// because every mousemove-induced re-render walked hundreds of hooks even
// though only the Sprite voice line actually needed the update.
//
// With a dedicated store, only the Sprite (which subscribes via a selector)
// re-renders on hover. page.tsx is unaffected. Per-button helpProps just
// calls the store's `setText` action — no React re-render in the parent.
//
// State shape is intentionally minimal: a single string. No persistence,
// no SSR, no devtools — this is one of the rare cases where the simplest
// possible Zustand store wins.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

type HoverHelpState = {
  text: string;
  setText: (next: string) => void;
  /** Conditional clear — used by onMouseLeave / onBlur so a stale "leave"
   * event from one button doesn't blow away a "enter" event that was just
   * fired from a different button (race when hovering quickly across two
   * adjacent elements). Equivalent to `setHoverHelpText(prev => prev === msg
   * ? "" : prev)` in the old useState world. */
  clearIfMatches: (msg: string) => void;
};

export const useHoverHelpStore = create<HoverHelpState>((set) => ({
  text: "",
  setText: (next) => set({ text: next }),
  clearIfMatches: (msg) => set((s) => (s.text === msg ? { text: "" } : s)),
}));

/** Selector helper for components that only need the current text. */
export const selectHoverHelpText = (s: HoverHelpState): string => s.text;
