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
  /** Human-readable label for where today's chips came from
   * (e.g. "OpenAlex recent publications"). Empty string hides the
   * attribution line entirely. */
  recommendedTermsSource?: string;
  /** Optional click-through URL — when present, the source label
   * becomes a link the user can open to verify the source. */
  recommendedTermsSourceUrl?: string;
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
    recommendedTermsSource, recommendedTermsSourceUrl,
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

  // Voice-slot sizing — split between two regimes:
  //   · Pre-search (hasRunSearch=false): FIXED 3 rem height + 2-line
  //     clamp. The user is hovering chips, typing, advancing the
  //     3-Enter ritual; if the slot resized on every hover-help text
  //     change the buttons + chips below would jitter up and down.
  //     Sticking to a fixed slot is the proven cure.
  //   · Post-search (hasRunSearch=true): drop the fixed height,
  //     shrink the font, and let the line wrap up to 3 lines. The
  //     guidance lines that fire here ("Synthesis Lab — write a draft
  //     using the papers you've collected as references") are longer
  //     than the landing copy and were getting clipped at 3 rem.
  //     There are no hover bubbles below to be pushed by a growing
  //     slot, so growth is fine.
  const voiceSlotStyle: React.CSSProperties = hasRunSearch
    ? {}                                            // grows naturally
    : { height: "4rem" };                           // 2 lines of 22 px voice + breathing
  const voiceLineStyle: React.CSSProperties = hasRunSearch
    ? {                                             // post-search: a touch
                                                    // smaller than the
                                                    // landing 22 px voice,
                                                    // but still readable.
        display:         "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        overflow:        "hidden",
        fontSize:        "calc(17px * var(--sprite-zoom-comp, 1))",
        lineHeight:      1.4,
      }
    : {                                             // landing: full 22 px
                                                    // (set by .sprite-voice
                                                    // class), 2-line clamp.
        display:         "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow:        "hidden",
      };

  return (
    <div className="stage-reveal mt-3 flex flex-col items-center gap-2.5 w-full">
      {/* Sprite VOICE SLOT — see voiceSlotStyle / voiceLineStyle above
          for the pre-search vs post-search sizing rationale. */}
      <div
        className="w-full flex items-center justify-center px-3 text-center overflow-hidden"
        style={voiceSlotStyle}
      >
        {hoverHelp ? (
          <p
            key={`help-${hoverHelp}`}
            className="sprite-voice voice-fade inline-flex items-center gap-2 italic leading-snug max-w-full"
            style={{ color: "var(--ats-fg-accent)", ...voiceLineStyle }}
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
            style={{ color: "var(--ats-fg-secondary)", ...voiceLineStyle }}
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
            style={{ color: "var(--ats-fg-secondary)", ...voiceLineStyle }}
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

      {/* Quick / Curated buttons — mounted while we're on the landing
          (hasRunSearch=false) so the row reserves space and the chips
          below stay pinned through the 3-step Enter reveal. Once a
          search fires we COLLAPSE the row entirely (height: 0, no
          children) so the retrieved-papers / brief sections below can
          slide up and fill what would otherwise be a dead band of
          empty pixels under the sprite. We DON'T use a CSS opacity
          transition here: React's strict-mode re-renders (driven by
          hover-help + the buttonStep state machine) kept resetting
          the in-flight transition to currentTime=0. The reveal reads
          fine as an instant flip. */}
      {!hasRunSearch && (
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
      )}

      {/* Recommended-term chips — borderless ghost row. Like the
          Quick/Curated row above, this disappears outright once a
          search is running so the retrieved-papers / brief sections
          below can climb up. While on the landing the row is always
          mounted (with opacity 0/1) so its height stays reserved and
          the chip strip never blinks in/out as the user types. */}
      {!hasRunSearch && (
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
              className="recommended-chip inline-flex items-center rounded-md px-2 py-0.5 font-normal"
              style={{
                // Multiply through --sprite-zoom-comp so the visible
                // size stays around 14 px regardless of the html zoom
                // applied at smaller viewports. Without the comp, the
                // chip rendered at ~7 px on 1440 viewports and was
                // genuinely hard to read.
                fontSize:   "calc(14px * var(--sprite-zoom-comp, 1))",
                lineHeight: 1.3,
              }}
            >
              {term}
            </button>
          );
        })}
      </div>
      )}

      {/* Source attribution — a small italic line under the chip
          strip telling the user where today's topics came from
          ("via OpenAlex recent publications" etc.). Hidden when the
          backend didn't provide a source (e.g. local FALLBACK_POOL
          state) or when the chip strip itself isn't visible. The
          link target opens the upstream source in a new tab so the
          user can verify the picks aren't fabricated. */}
      {!hasRunSearch && showRecommendedTerms && recommendedTermsSource && (
        <p
          className="text-[10px] italic"
          style={{ color: "var(--ats-fg-muted)", opacity: 0.6 }}
        >
          via{" "}
          {recommendedTermsSourceUrl ? (
            <a
              href={recommendedTermsSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted hover:opacity-100"
            >
              {recommendedTermsSource}
            </a>
          ) : (
            <span>{recommendedTermsSource}</span>
          )}
          {" "}· refreshed daily
        </p>
      )}
    </div>
  );
});
Sprite.displayName = "Sprite";
