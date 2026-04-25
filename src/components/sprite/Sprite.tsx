"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { FlaskConical, Zap } from "lucide-react";

/** Imperative handle exposed to parent so the textarea's onKeyDown can
 * drive bubble focus + Enter commit without each side knowing the other's
 * internal bubble list shape. */
export type SpriteHandle = {
  /** True if at least one actionable bubble is on screen. */
  hasBubbles: () => boolean;
  /** Move focus by delta (-1 / +1), wrapping around. */
  moveFocus: (delta: 1 | -1) => void;
  /** Click whatever bubble is currently focused. Returns true if a bubble
   * was triggered (so the parent knows to suppress its own Enter logic). */
  commitFocused: () => boolean;
  /** What kind of bubble currently has focus — lets the parent route
   * Enter differently for chips (commit input fill) vs mode buttons
   * (drive the 3-step reveal flow). Returns null when nothing is focused. */
  getFocusedKind: () => "term" | "mode" | null;
};

export type AssessVerdict = "brief" | "balanced" | "detailed";

export type SpriteIntroStage = "blank" | "explore" | "full";

export type SpriteProps = {
  /** Live textarea contents (raw, untrimmed). */
  query: string;
  /** Workspace stage — sprite chats only on `blank`; bubbles auto-hide once the
   * user advances. */
  introStage: SpriteIntroStage;
  /** True once the search button has fired at least once — silences the sprite
   * after the search starts running. */
  hasRunSearch: boolean;
  /** Latest sprite voice line. */
  message: string;
  /** Hover-help overlay text. When non-empty, the sprite voice line
   * shows this string in priority — used to explain whichever UI
   * element the user is hovering / focused on. */
  hoverHelp: string;
  /** Curated suggestion chips shown under the mode buttons. Clicking a
   * chip replaces the textarea contents with the chip's text. */
  recommendedTerms: string[];
  /** Three-step Quick / Curated reveal flow:
   *   0 → buttons hidden (user has typed but not yet pressed Enter)
   *   1 → buttons visible, no focus ring on either
   *   2 → buttons visible AND focus ring on the active mode (next Enter fires it)
   * Driven by the parent's textarea Enter handler. Resets to 0 whenever
   * the input empties or after a search runs. */
  buttonStep: 0 | 1 | 2;
  /** Quick / Curated chat bubble click — picks the mode and fires the
   * search in one step. */
  onStartSearch: (mode: "quick" | "curated") => void;
  /** Click a recommended-term chip — replaces the input with `term`. */
  onPickRecommendedTerm: (term: string) => void;
  /** Hover-help wiring — call with a string when the user enters the
   * element, with empty string when they leave. */
  onHoverHelp?: (text: string) => void;
};

/**
 * Sprite — encapsulated voice + bubble UI for the workspace landing.
 *
 * The legacy "angles / sub-options / find-angles streaming" flow was
 * removed: the sprite now offers two surfaces only — Quick / Curated
 * mode buttons (the search trigger) and a small row of recommended
 * search-term chips (one click replaces the textarea contents). All
 * bubble-style state is gone; the sprite is a controlled view + a
 * thin event surface.
 */
export const Sprite = forwardRef<SpriteHandle, SpriteProps>(function Sprite(props, ref) {
  const {
    query, introStage, hasRunSearch, message,
    hoverHelp, recommendedTerms, buttonStep,
    onStartSearch, onPickRecommendedTerm, onHoverHelp,
  } = props;
  const hh = (msg: string) => ({
    onMouseEnter: () => onHoverHelp?.(msg),
    onMouseLeave: () => onHoverHelp?.(""),
    onFocus:      () => onHoverHelp?.(msg),
    onBlur:       () => onHoverHelp?.(""),
  });

  const trimmedQuery = query.trim();
  // Buttons stay hidden at step 0 (user typed but hasn't pressed Enter yet),
  // appear at step 1 (1st Enter — visible but no ring), and pick up the
  // visible focus ring at step 2 (2nd Enter — armed; 3rd Enter fires).
  const showSearchModeButtons = !hasRunSearch && trimmedQuery.length > 0 && buttonStep >= 1;
  const showButtonFocusRing   = buttonStep >= 2;
  const showRecommendedTerms  = !hasRunSearch && recommendedTerms.length > 0;

  // Fallback line for the post-Run / post-results states — keeps the
  // sprite "in conversation" with the user the whole time.
  const fallbackVoice = hasRunSearch
    ? (introStage === "full" ? "running your search… (˙ᵕ˙)" : "ready when you are (◕‿◕)")
    : "";
  const showDefaultInvite = !hoverHelp && trimmedQuery.length === 0 && !hasRunSearch && !message;
  const showMessage       = !hoverHelp && !!message;
  const showFallback      = !hoverHelp && !showMessage && !showDefaultInvite && !!fallbackVoice;

  // ── Focusable-bubble flat list ─────────────────────────────────────────
  // Order is the visual reading order. Quick / Curated buttons come first
  // (they're the default action target) followed by the chips.
  type Actionable = { key: string; kind: "term" | "mode"; onClick: () => void };
  const actionables = useMemo<Actionable[]>(() => {
    const list: Actionable[] = [];
    if (showSearchModeButtons) {
      list.push({ key: "mode-quick",   kind: "mode", onClick: () => onStartSearch("quick") });
      list.push({ key: "mode-curated", kind: "mode", onClick: () => onStartSearch("curated") });
    }
    if (showRecommendedTerms) {
      recommendedTerms.forEach((term, i) => {
        list.push({ key: `term-${i}`, kind: "term", onClick: () => onPickRecommendedTerm(term) });
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSearchModeButtons, showRecommendedTerms, recommendedTerms.join("|")]);

  // Focus state — null until the parent drives it via a real arrow key
  // or until the mode buttons appear (we then auto-default to mode-quick
  // so the 2nd Enter has something to arm). Chips only get focus when
  // the user explicitly arrows onto them; we DON'T auto-focus a chip
  // because that would make the textarea Enter accidentally fill the
  // input every time, instead of advancing the 3-step button flow.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  useEffect(() => {
    if (actionables.length === 0) {
      setFocusedKey(null);
      return;
    }
    const stillValid = focusedKey !== null && actionables.some(a => a.key === focusedKey);
    if (stillValid) return;
    const quickAvailable = actionables.some(a => a.key === "mode-quick");
    // Auto-focus mode-quick once the buttons render so the 2nd Enter
    // has a default target. Otherwise leave focus null.
    setFocusedKey(quickAvailable ? "mode-quick" : null);
  }, [actionables, focusedKey]);

  const focusedIdx = useMemo(
    () => actionables.findIndex(a => a.key === focusedKey),
    [actionables, focusedKey],
  );
  const isFocused = (key: string) => focusedKey === key;

  useImperativeHandle(ref, () => ({
    hasBubbles: () => actionables.length > 0,
    moveFocus: (delta: 1 | -1) => {
      if (actionables.length === 0) return;
      const cur = focusedIdx < 0 ? 0 : focusedIdx;
      const next = (cur + delta + actionables.length) % actionables.length;
      setFocusedKey(actionables[next].key);
    },
    commitFocused: () => {
      const target = actionables.find(a => a.key === focusedKey);
      if (!target) return false;
      target.onClick();
      return true;
    },
    getFocusedKind: () => {
      const target = actionables.find(a => a.key === focusedKey);
      return target?.kind ?? null;
    },
  }), [actionables, focusedIdx, focusedKey]);

  // The "selected" chip is whichever entry exactly matches the trimmed
  // textarea contents. Lets us style a chip the user has just picked
  // (or is in the middle of editing into the input) without tracking a
  // separate selection state. Equality is intentionally strict — if
  // the user starts typing past the chip's text, it deselects.
  const selectedTerm = trimmedQuery;

  return (
    <div className="stage-reveal mt-3 flex flex-col items-center gap-2.5 w-full">
      {/* Sprite VOICE SLOT — FIXED-height reservation so the slot's
          height never changes when the voice line swaps. Earlier we
          used min-h-[2.4rem] which let the slot grow when a longer
          hover-help message wrapped to a second line, pushing the
          buttons + chips below it down by a row and back up again on
          mouse-out — the visible "shake" the user reported. Locking
          the height + line-clamping at 2 lines keeps the row's
          baseline pinned across every voice transition. */}
      <div
        className="w-full flex items-center justify-center px-3 text-center overflow-hidden"
        style={{ height: "3rem" }}
      >
        {hoverHelp ? (
          <p
            key={`help-${hoverHelp}`}
            className="sprite-voice voice-fade inline-flex items-center gap-2 italic leading-snug max-w-full"
            style={{
              color:           "var(--ats-fg-accent)",
              display:         "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow:        "hidden",
            }}
          >
            <span
              className="sprite-dot-idle inline-block h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: "var(--ats-fg-accent)" }}
              aria-hidden
            />
            <span>{hoverHelp}</span>
          </p>
        ) : null}
        {showMessage && (
          <p
            key={message}
            className="sprite-voice voice-fade inline-flex items-center gap-2 italic leading-snug max-w-full"
            style={{
              color:           "var(--ats-fg-secondary)",
              display:         "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow:        "hidden",
            }}
          >
            <span
              className="sprite-dot-idle inline-block h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: "var(--ats-fg-accent)" }}
              aria-hidden
            />
            <span>{message}</span>
          </p>
        )}
        {showFallback && (
          <p
            key={fallbackVoice}
            className="sprite-voice voice-fade inline-flex items-center gap-2 italic leading-snug max-w-full"
            style={{
              color:           "var(--ats-fg-secondary)",
              display:         "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow:        "hidden",
            }}
          >
            <span
              className="sprite-dot-idle inline-block h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: "var(--ats-fg-accent)" }}
              aria-hidden
            />
            <span>{fallbackVoice}</span>
          </p>
        )}
        {showDefaultInvite && (
          <p
            className="sprite-voice voice-fade inline-flex items-center gap-2 leading-snug flex-wrap justify-center"
            style={{ color: "var(--ats-fg-muted)" }}
          >
            <span>Type any key words, topic or theme you want to explore</span>
            <span
              aria-hidden
              className="sprite-badge inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-semibold tracking-wide animate-pulse"
              style={{
                borderColor:     "var(--ats-border-accent)",
                backgroundColor: "var(--ats-bg-accent-soft)",
                color:           "var(--ats-fg-accent)",
              }}
            >
              Press <kbd className="font-mono">⏎ Enter</kbd>
            </span>
          </p>
        )}
      </div>

      {/* Quick / Curated buttons — ALWAYS mounted so the row reserves
          its vertical space at all times. We swap visibility via
          opacity + pointer-events instead of mount/unmount, which keeps
          the chips below pinned at the same y when the user starts
          typing and through the 3-step Enter reveal. We DON'T use a
          CSS opacity transition here: React's strict-mode re-renders
          (driven by hover-help + the buttonStep state machine) kept
          resetting the in-flight transition to currentTime=0, leaving
          the row stuck at opacity:0 even though inline style was
          opacity:1. The reveal reads fine as an instant flip. */}
      <div
        className="flex flex-row items-center justify-center gap-2"
        style={{
          minHeight:     "2.5rem",
          opacity:       showSearchModeButtons ? 1 : 0,
          pointerEvents: showSearchModeButtons ? "auto" : "none",
          transition:    "none",
        }}
        aria-hidden={!showSearchModeButtons}
      >
        <button
          onClick={() => onStartSearch("quick")}
          title="Fast smart-ranked search — seconds to results"
          {...hh("Quick Search — fast smart-ranked retrieval, results in seconds")}
          data-focused={(showButtonFocusRing && isFocused("mode-quick")) || undefined}
          tabIndex={showSearchModeButtons ? 0 : -1}
          className="sprite-bubble inline-flex items-center justify-center gap-1.5 rounded-full border px-4 py-2 font-semibold transition-all hover:brightness-110 hover:border-[var(--ats-border-accent)] data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-2 data-[focused]:ring-offset-[var(--ats-bg-section)]"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-secondary)",
          }}
        >
          <Zap size={14} />
          <span>Quick Search</span>
        </button>
        <button
          onClick={() => onStartSearch("curated")}
          title="Multi-agent deep dive — slower, more careful"
          {...hh("Curated Analysis — multi-agent deep dive (in minutes), much more careful evidence chains")}
          data-focused={(showButtonFocusRing && isFocused("mode-curated")) || undefined}
          tabIndex={showSearchModeButtons ? 0 : -1}
          className="sprite-bubble inline-flex items-center justify-center gap-1.5 rounded-full border px-4 py-2 font-semibold transition-all hover:brightness-110 hover:border-[var(--ats-border-accent)] data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-2 data-[focused]:ring-offset-[var(--ats-bg-section)]"
          style={{
            borderColor:     "var(--ats-border-subtle)",
            backgroundColor: "var(--ats-bg-panel)",
            color:           "var(--ats-fg-secondary)",
          }}
        >
          <FlaskConical size={14} />
          <span>Curated Analysis</span>
        </button>
      </div>

      {/* Recommended-term chips — borderless ghost row, always mounted
          so it can fade in/out with the search-mode-buttons strip
          above. Hover scales each chip via CSS `transform` (does NOT
          reflow neighbours) and the chip whose text matches the
          current input is rendered in a "selected" style: same
          transform-only scale + a darker text colour. No padding /
          font-size changes anywhere — every visual emphasis is done
          off the layout flow so neighbouring chips stay put. */}
      <div
        className="flex flex-row flex-wrap items-center justify-center gap-x-3 gap-y-0.5 w-full max-w-3xl px-3 leading-tight"
        style={{
          opacity:       showRecommendedTerms ? 1 : 0,
          pointerEvents: showRecommendedTerms ? "auto" : "none",
          transition:    "none",
        }}
        aria-hidden={!showRecommendedTerms}
      >
        {recommendedTerms.map((term, i) => {
          const isSelected = selectedTerm === term;
          return (
            <button
              key={`term-${i}`}
              onClick={() => onPickRecommendedTerm(term)}
              title={`Use "${term}" as your search`}
              {...hh(`Replace your input with "${term}" — click to set, then pick Quick or Curated`)}
              data-focused={isFocused(`term-${i}`) || undefined}
              data-selected={isSelected || undefined}
              tabIndex={showRecommendedTerms ? 0 : -1}
              className="recommended-chip inline-flex items-center rounded-md px-1.5 py-0.5 font-normal"
              style={{
                fontSize:   "11px",
                lineHeight: 1.25,
              }}
            >
              {term}
            </button>
          );
        })}
      </div>
    </div>
  );
});
Sprite.displayName = "Sprite";
