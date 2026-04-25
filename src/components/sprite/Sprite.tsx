"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { FlaskConical, Sparkles, Zap } from "lucide-react";

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
    hoverHelp, recommendedTerms,
    onStartSearch, onPickRecommendedTerm, onHoverHelp,
  } = props;
  const hh = (msg: string) => ({
    onMouseEnter: () => onHoverHelp?.(msg),
    onMouseLeave: () => onHoverHelp?.(""),
    onFocus:      () => onHoverHelp?.(msg),
    onBlur:       () => onHoverHelp?.(""),
  });

  const trimmedQuery = query.trim();
  const showSearchModeButtons = !hasRunSearch && trimmedQuery.length > 0;
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

  // Default focus = first mode button when present, else first chip.
  // Persists across re-renders so the focused item stays put as state changes.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  useEffect(() => {
    if (actionables.length === 0) {
      setFocusedKey(null);
      return;
    }
    const focusInvalid = focusedKey === null || !actionables.some(a => a.key === focusedKey);
    if (focusInvalid) {
      const quickAvailable = actionables.some(a => a.key === "mode-quick");
      setFocusedKey(quickAvailable ? "mode-quick" : actionables[0].key);
    }
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
  }), [actionables, focusedIdx, focusedKey]);

  return (
    <div className="stage-reveal mt-3 flex flex-col items-center gap-2.5 w-full">
      {/* Sprite VOICE SLOT — fixed-height reservation so this row's
          vertical position never shifts. */}
      <div className="w-full min-h-[2.4rem] flex items-center justify-center px-3 text-center">
        {hoverHelp ? (
          <p
            key={`help-${hoverHelp}`}
            className="sprite-voice stage-reveal inline-flex items-center gap-2 italic leading-snug"
            style={{ color: "var(--ats-fg-accent)" }}
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
            className="sprite-voice stage-reveal inline-flex items-center gap-2 italic leading-snug"
            style={{ color: "var(--ats-fg-secondary)" }}
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
            className="sprite-voice stage-reveal inline-flex items-center gap-2 italic leading-snug"
            style={{ color: "var(--ats-fg-secondary)" }}
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
            className="sprite-voice inline-flex items-center gap-2 leading-snug flex-wrap justify-center"
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

      {/* Quick / Curated buttons — the search trigger. Only render once
          the textarea has content; an empty query has nothing to fire. */}
      {showSearchModeButtons && (
        <div className="stage-reveal flex flex-row items-center justify-center gap-2">
          <button
            onClick={() => onStartSearch("quick")}
            title="Fast smart-ranked search — seconds to results"
            {...hh("Quick Search — fast smart-ranked retrieval, results in seconds")}
            data-focused={isFocused("mode-quick") || undefined}
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
            data-focused={isFocused("mode-curated") || undefined}
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
      )}

      {/* Recommended-term chips — sit directly below the mode buttons.
          Clicking a chip replaces the textarea contents wholesale, so the
          user can scan a few suggested topics and pick one without typing.
          Also keyboard-navigable via the same arrow-key flow that walks
          the mode buttons. */}
      {showRecommendedTerms && (
        <div className="stage-reveal flex flex-col items-center gap-1.5 w-full max-w-3xl">
          <div
            className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]"
            style={{ color: "var(--ats-fg-muted)" }}
          >
            <Sparkles size={11} aria-hidden />
            <span>Try one of these</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5 px-2">
            {recommendedTerms.map((term, i) => (
              <button
                key={`term-${i}`}
                onClick={() => onPickRecommendedTerm(term)}
                title={`Use "${term}" as your search`}
                {...hh(`Replace your input with "${term}" — click to set, then pick Quick or Curated`)}
                data-focused={isFocused(`term-${i}`) || undefined}
                className="sprite-bubble inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all hover:brightness-110 hover:border-[var(--ats-border-accent)] hover:text-[var(--ats-fg-accent)] data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-1 data-[focused]:ring-offset-[var(--ats-bg-section)]"
                style={{
                  borderColor:     "var(--ats-border-subtle)",
                  backgroundColor: "var(--ats-bg-panel)",
                  color:           "var(--ats-fg-muted)",
                }}
              >
                {term}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
Sprite.displayName = "Sprite";
