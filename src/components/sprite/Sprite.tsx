"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { FlaskConical, Star, Zap } from "lucide-react";
import { looksLikeNewContent } from "./spriteUtils";

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

export type SpriteSubOption = {
  label: string;
  reason?: string;
};

export type SpriteDirection = {
  label: string;
  description?: string;
  sub_options?: SpriteSubOption[];
};

export type SpriteDirectionData = {
  directions?: SpriteDirection[];
  recommended_direction?: number;
  recommended_sub?: number;
} | null;

export type SpriteIntroStage = "blank" | "explore" | "full";

export type SpriteProps = {
  /** Live textarea contents (raw, untrimmed). */
  query: string;
  /** Last query the user committed to (locks in once they advance past blank). */
  committedQuery: string;
  /** Workspace stage — sprite chats only on `blank`; bubbles auto-hide once the
   * user advances. */
  introStage: SpriteIntroStage;
  /** True once the search button has fired at least once — silences the sprite
   * after the search starts running. */
  hasRunSearch: boolean;
  /** Whether the Explore-Angles fetch is in flight. */
  isUnderstanding: boolean;
  /** Latest sprite voice line (AI verdict, instant reaction, or canned). */
  message: string;
  /** Latest sprite verdict (drives which choice bubbles render). */
  verdict: AssessVerdict | null;
  /** True while the assess-input request is in flight — animates the dot. */
  assessing: boolean;
  /** Pre-AI typing micro-line that fades in after a 400 ms thinking pause. */
  instantReaction: string;
  /** True once the user has clicked Find-angles / Search-it / picked a
   * direction — hides the choice bubbles. */
  spriteChoiceMade: boolean;
  /** Latest direction-fetch result (null until handleUnderstand resolves). */
  directionData: SpriteDirectionData;
  /** The last query string the assess endpoint returned for. Used to detect
   * when the textarea has drifted past the verdict's source. */
  lastAssessedText: string;
  /** True the moment the user presses Enter — flips the choice bubbles on
   * INSTANTLY, even before the assess verdict arrives. The sprite voice
   * line then catches up asynchronously. */
  bubblesRequested: boolean;
  /** Pre-picked confirmation prompt for the new-content drift dialog. */
  newContentPrompt: string;
  /** Live SSE progress message from the directions stream (e.g. "scanning
   * literature…"). Replaces the canned "looking for angles…" line while
   * the stream is in flight so the user sees real motion. */
  understandStatus: string;
  /** Stage-1 decompose payload — key terms, contexts, intent type. Set
   * partway through the directions stream; rendered as a small chip row
   * under the sprite voice so the user sees what the AI pulled out of
   * their query. */
  understandDecompose: Record<string, unknown> | null;
  /** Stage-2 expand payload — synonyms / related-term clusters. Same
   * "what the AI is looking at" reveal, second slice. */
  understandExpand: Record<string, unknown> | null;
  /** Hover-help overlay text. When non-empty, the sprite voice line
   * shows this string in priority — used to explain whichever UI
   * element the user is hovering / focused on. */
  hoverHelp: string;
  /** Currently picked main direction (null = none yet). When set, the
   * sprite reveals the sub-option bubbles for that direction. */
  selectedDirIndex: number | null;
  /** Currently picked sub-option (null = none yet). */
  selectedSubIndex: number | null;
  /** True once the user opens the custom-query bubble. */
  customQueryEnabled: boolean;
  /** Custom-query textarea contents. */
  customQueryValue: string;
  /** Click handlers — wired by the page to the workspace state setters. */
  onFindAngles: () => void;
  onSearchAsIs: () => void;
  onResetToBlank: () => void;
  onKeepCurrent: () => void;
  onPickDirection: (index: number) => void;
  onPickSubDirection: (index: number) => void;
  onCustomQueryEnable: () => void;
  onCustomQueryChange: (value: string) => void;
  onCustomQuerySubmit: () => void;
  /** Quick / Curated chat bubble click — replaces the legacy action-bar
   * mode toggle + Start button. Picks the mode and fires the search in
   * one step. */
  onStartSearch: (mode: "quick" | "curated") => void;
  /** Hover-help wiring — call with a string when the user enters the
   * element, with empty string when they leave. Sprite voice line
   * displays it in priority. */
  onHoverHelp?: (text: string) => void;
};

/**
 * Sprite — encapsulated voice + bubble UI for the workspace landing.
 *
 * All sprite STATE lives in the parent (page.tsx) for now: the parent owns
 * the query, the introStage, the assess result, etc. This component is a
 * controlled view + thin event surface. To extend the sprite (new bubble
 * type, alternate verdict, animation polish) edit this file alone — the
 * parent only needs new props.
 *
 * Extracted out of academic-ats-frontend/src/app/page.tsx (originally an
 * inline IIFE) so the sprite can be reused, tested, and themed without
 * digging through the workspace's 5k-line component.
 */
export const Sprite = forwardRef<SpriteHandle, SpriteProps>(function Sprite(props, ref) {
  const {
    query, committedQuery, introStage, hasRunSearch, isUnderstanding,
    message, verdict, assessing, instantReaction, spriteChoiceMade,
    directionData, lastAssessedText, newContentPrompt, bubblesRequested,
    understandStatus, understandDecompose, understandExpand,
    hoverHelp,
    selectedDirIndex, selectedSubIndex,
    customQueryEnabled, customQueryValue,
    onResetToBlank, onKeepCurrent, onPickDirection,
    onPickSubDirection, onCustomQueryEnable, onCustomQueryChange, onCustomQuerySubmit,
    onStartSearch, onHoverHelp,
  } = props;
  const hh = (msg: string) => ({
    onMouseEnter: () => onHoverHelp?.(msg),
    onMouseLeave: () => onHoverHelp?.(""),
    onFocus:      () => onHoverHelp?.(msg),
    onBlur:       () => onHoverHelp?.(""),
  });
  // Defensive: keep prop names in scope (some callers may still pass
  // them; the linter doesn't yell when they're unused either way).
  void props.onFindAngles; void props.onSearchAsIs;

  // The sprite VOICE line is now always present — even mid-search and
  // post-completion the sprite stays in conversation with the user
  // ("running your search…", "results in!"). Earlier we early-returned
  // when introStage === "full" + hasRunSearch but that left a dead
  // patch on screen at the most critical moment.

  // Display logic for the sprite voice slot:
  //   1. Fresh AI verdict (and the textarea hasn't drifted) → show it.
  //   2. Instant reaction after the 400 ms thinking pause → show that.
  //   3. User typed something but no line yet → pulsing thinking dot.
  //   4. Box empty → default invite + Enter cue.
  //   5. Search running / done → fallback voice line (see fallbackVoice
  //      below) so the slot never goes blank.
  const trimmedQuery     = query.trim();
  const queryHasDrifted  = trimmedQuery !== lastAssessedText && lastAssessedText.length > 0;
  const freshMessage     = !!message && !queryHasDrifted;
  const activeInstant    = !freshMessage && !!instantReaction && trimmedQuery.length > 0;
  const showThinking     = !freshMessage && !activeInstant && trimmedQuery.length > 0 && !hasRunSearch;
  const showMessage      = freshMessage || activeInstant;
  const currentMessage   = freshMessage ? message : instantReaction;
  // Fallback line for the post-Run / post-results states — keeps the
  // sprite "in conversation" with the user the whole time.
  const fallbackVoice    = hasRunSearch
    ? (introStage === "full" ? "running your search… (˙ᵕ˙)" : "ready when you are (◕‿◕)")
    : "";
  const showDefault      = !showThinking && !showMessage && trimmedQuery.length === 0;
  // The choice bubbles surface either:
  //   - because the AI verdict has arrived (any verdict — even "detailed"
  //     — gets bubbles so the user always has a tappable follow-up), OR
  //   - because the user pressed Enter (bubblesRequested) and we want
  //     them on screen immediately, even before the verdict catches up.
  const needsAngles      = !!verdict || bubblesRequested;
  // New-content confirmation: the user has advanced past blank and is now
  // typing materially different text → ask before discarding the session.
  const askNewContent =
    introStage !== "blank" &&
    committedQuery.length > 0 &&
    trimmedQuery.length > 0 &&
    looksLikeNewContent(committedQuery, trimmedQuery);
  // Quick / Curated bubbles ARE the search trigger now. They render as
  // soon as the user has typed something + pressed Enter (Find Angles
  // auto-fires on Enter so isUnderstanding flips true). Hidden once the
  // search itself starts. Available throughout the directions stream so
  // the user can either pick a direction first OR jump straight to a
  // mode and search the raw query.
  const showSearchModeBubbles =
    !hasRunSearch &&
    trimmedQuery.length > 0 &&
    (isUnderstanding || (directionData?.directions?.length ?? 0) > 0);
  // Old "Find angles for me" / "Just search it" choice bubbles are gone —
  // Enter auto-fires Find Angles + the Quick/Curated bubbles take over
  // as the explicit commit surface.
  const showChoiceBubbles = false;
  void needsAngles; void bubblesRequested; void showMessage; void spriteChoiceMade;
  const directions = directionData?.directions ?? [];
  // Direction bubbles disappear once a real search kicks off — at that
  // point the user has committed to a path and the angle list is no
  // longer interactive. They reappear if the user starts over.
  const showDirectionBubbles  = directions.length > 0 && !hasRunSearch;
  const showFindingAngles     = isUnderstanding;
  // Once a direction is picked, surface its sub-options as a second row of
  // bubbles. Skip when the picked direction has no sub-options.
  const pickedDirection       = selectedDirIndex !== null ? directions[selectedDirIndex] : null;
  const subOptions            = pickedDirection?.sub_options ?? [];
  const showSubBubbles        = !!pickedDirection && subOptions.length > 0 && !hasRunSearch;
  // The "use my own wording" bubble appears alongside the direction bubbles
  // so the user can always escape to a custom-query path. Hidden once
  // already opened (the input takes its place).
  // Custom-query escape hatch removed — the user can pick a direction
  // bubble or hit Quick / Curated to search the raw query as-is.
  const showCustomQueryBubble = false;
  const showCustomQueryInput  = false;
  void customQueryEnabled; void customQueryValue;
  void onCustomQueryEnable; void onCustomQueryChange; void onCustomQuerySubmit;

  // ── Focusable-bubble flat list ─────────────────────────────────────────
  // Order is the visual reading order so ArrowRight from the textarea
  // walks the same sequence the user sees. Each entry stores a stable
  // key (so React diffs don't randomly shift focus when a direction
  // streams in mid-typing), the click handler, and a kind-tag for
  // future styling decisions.
  type Actionable = { key: string; kind: "dir" | "sub" | "custom" | "mode"; onClick: () => void };
  const actionables = useMemo<Actionable[]>(() => {
    const list: Actionable[] = [];
    if (showDirectionBubbles) {
      directions.slice(0, 6).forEach((d, i) => {
        list.push({ key: `dir-${i}-${d.label}`, kind: "dir", onClick: () => onPickDirection(i) });
      });
    }
    if (showSubBubbles) {
      subOptions.slice(0, 8).forEach((s, i) => {
        list.push({ key: `sub-${i}-${s.label}`, kind: "sub", onClick: () => onPickSubDirection(i) });
      });
    }
    if (showSearchModeBubbles) {
      list.push({ key: "mode-quick",   kind: "mode", onClick: () => onStartSearch("quick") });
      list.push({ key: "mode-curated", kind: "mode", onClick: () => onStartSearch("curated") });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showDirectionBubbles, directions, showCustomQueryBubble, showSubBubbles,
    subOptions, showSearchModeBubbles, selectedDirIndex,
  ]);

  // Focused-bubble tracker. Default focus = recommended direction when
  // directions exist, else first action. Persists across stream events so
  // the focused item stays put as new directions trickle in.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  useEffect(() => {
    if (actionables.length === 0) {
      setFocusedKey(null);
      return;
    }
    // Default focus is ALWAYS the Quick Search mode bubble when it's
    // available — Enter from the textarea should immediately fire a
    // search via the default mode, not pick a direction. The user can
    // arrow over to a direction or to Curated if they want to refine.
    const quickKey = "mode-quick";
    const quickAvailable = actionables.some(a => a.key === quickKey);
    const focusInvalid   = focusedKey === null || !actionables.some(a => a.key === focusedKey);
    if (focusInvalid) {
      setFocusedKey(quickAvailable ? quickKey : actionables[0].key);
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

  // Always-visible: with the always-on fallback voice (`fallbackVoice`)
  // the sprite slot never collapses — the early-return is gone. The
  // user always sees a line from the sprite, even after results land.

  return (
    <div className="stage-reveal mt-3 flex flex-col items-center gap-2.5">
      {askNewContent ? (
        // New-content confirmation takes priority — pause every other sprite
        // output and ask explicitly before blowing the session away.
        <div className="flex flex-col items-center gap-2.5">
          <p
            key={`ask-new-${newContentPrompt}`}
            className="sprite-voice stage-reveal inline-flex items-center gap-2 italic leading-snug"
            style={{ color: "var(--ats-fg-secondary)" }}
          >
            <span
              className="sprite-dot-idle inline-block h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: "var(--ats-fg-accent)" }}
              aria-hidden
            />
            <span>{newContentPrompt}</span>
          </p>
          <div className="stage-reveal flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={onResetToBlank}
              className="sprite-bubble inline-flex items-center gap-1.5 rounded-full border px-4 py-2 font-semibold transition-all hover:brightness-105"
              style={{
                borderColor:     "var(--ats-border-accent)",
                backgroundColor: "var(--ats-bg-accent-soft)",
                color:           "var(--ats-fg-accent)",
              }}
            >
              <span>Yes, start over</span>
            </button>
            <button
              onClick={onKeepCurrent}
              className="sprite-bubble inline-flex items-center gap-1.5 rounded-full border px-4 py-2 font-semibold transition-all hover:brightness-105"
              style={{
                borderColor:     "var(--ats-border-subtle)",
                backgroundColor: "var(--ats-bg-panel)",
                color:           "var(--ats-fg-secondary)",
              }}
            >
              <span>Nope, just tweaking</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2.5 w-full">
          {/* Hover-help takes top priority — when the user is hovering
              any UI element wired with `helpProps`, the sprite voice
              line shows that element's explanation instead of the
              regular running line. The directions / bubbles below
              continue to render so the user doesn't lose their place
              while reading the help. */}
          {/* Sprite VOICE SLOT — fixed-height reservation so this row's
              vertical position never shifts. The streaming-thinking
              panel (READING / EXPANDING / FOUND) lives BELOW this slot,
              not inside it, so the voice line stays at the same y as
              the user expects. */}
          <div className="w-full min-h-[2.4rem] flex items-center justify-center">
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
          {!hoverHelp && showThinking && (
            <p
              className="sprite-voice inline-flex items-center gap-2 italic"
              style={{ color: "var(--ats-fg-muted)" }}
            >
              <span
                className="sprite-dot-think inline-block h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: "var(--ats-fg-accent)" }}
                aria-hidden
              />
              thinking…
            </p>
          )}
          {!hoverHelp && showFindingAngles && (
            // Sprite-voice streaming line — folds the old READING /
            // EXPANDING / FOUND panel into the voice slot so the layout
            // below (Quick / Curated buttons) never gets pushed by a
            // separate streaming card. PRIORITISED over `showMessage`:
            // when the user presses Enter, page.tsx fires both
            // `setAssessmentMessage("looking for angles…")` AND flips
            // isUnderstanding=true. Without this priority, both branches
            // would gate each other off (`showFindingAngles && !showMessage`
            // vs `showMessage && !showFindingAngles`) and the slot would
            // collapse to nothing — making the sprite feel like it had
            // disappeared. The composed line surfaces the most recent
            // decompose / expand / direction-count payloads in sprite
            // tone, then truncates to a single line with an ellipsis.
            <p
              className="sprite-voice stage-reveal inline-flex items-center gap-2 italic max-w-full"
              style={{ color: "var(--ats-fg-muted)" }}
            >
              <span
                className="sprite-dot-think inline-block h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: "var(--ats-fg-accent)" }}
                aria-hidden
              />
              <span
                style={{
                  whiteSpace:   "nowrap",
                  overflow:     "hidden",
                  textOverflow: "ellipsis",
                  maxWidth:     "min(48rem, calc(100vw - 4rem))",
                  display:      "inline-block",
                }}
              >
                {(() => {
                  const parts: string[] = [];
                  const decTerms = understandDecompose
                    ? ((understandDecompose.core_terms as string[] | undefined) ?? []).slice(0, 3)
                    : [];
                  if (decTerms.length) parts.push(`peeking at ${decTerms.join(", ")}…`);
                  const expClusters = understandExpand
                    ? ((understandExpand.clusters as Array<Record<string, unknown>> | undefined) ?? [])
                    : [];
                  const expTerms: string[] = [];
                  for (const c of expClusters.slice(0, 1)) {
                    const ts = (c?.terms as string[] | undefined) ?? [];
                    expTerms.push(...ts.slice(0, 2));
                  }
                  if (expTerms.length) parts.push(`pulling in ${expTerms.join(", ")}…`);
                  const dirCount = directionData?.directions?.length ?? 0;
                  if (dirCount > 0) parts.push(`found ${dirCount} angles so far (◕‿◕)`);
                  if (parts.length === 0) {
                    return understandStatus
                      ? `${understandStatus} (˙ᵕ˙)`
                      : "scouting angles for you… (˙ᵕ˙)";
                  }
                  return parts.join(" · ");
                })()}
              </span>
              {/* Tiny Esc-to-cancel hint pinned to the streaming line so
                  users have a non-mouse escape from a long find-angles
                  call without abandoning their typed query. */}
              <span
                aria-hidden
                className="ml-1 inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10px] not-italic font-medium tracking-wide"
                style={{
                  borderColor:     "var(--ats-border-subtle)",
                  color:           "var(--ats-fg-muted)",
                  backgroundColor: "var(--ats-bg-panel)",
                  opacity:         0.85,
                }}
              >
                <kbd className="font-mono">Esc</kbd>
                <span>to cancel</span>
              </span>
            </p>
          )}
          {!hoverHelp && showMessage && !showFindingAngles && (
            <p
              key={currentMessage}
              className="sprite-voice stage-reveal inline-flex items-center gap-2 italic leading-snug"
              style={{ color: "var(--ats-fg-secondary)" }}
            >
              <span
                className={`${(activeInstant || assessing) ? "sprite-dot-think" : "sprite-dot-idle"} inline-block h-2.5 w-2.5 rounded-full shrink-0`}
                style={{ backgroundColor: "var(--ats-fg-accent)" }}
                aria-hidden
              />
              <span>{currentMessage}</span>
              {freshMessage && introStage === "blank" && !showChoiceBubbles && !showDirectionBubbles && (
                <span
                  aria-hidden
                  className="sprite-badge ml-1 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-semibold not-italic tracking-wide"
                  style={{
                    borderColor:     "var(--ats-border-accent)",
                    backgroundColor: "var(--ats-bg-accent-soft)",
                    color:           "var(--ats-fg-accent)",
                  }}
                >
                  Press <kbd className="font-mono">⏎ Enter</kbd>
                </span>
              )}
            </p>
          )}
          {!hoverHelp && !showThinking && !showMessage && !showDefault && !showFindingAngles && fallbackVoice && (
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
          {!hoverHelp && showDefault && (
            <p
              className="sprite-voice inline-flex items-center gap-2 leading-snug"
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
          {/* Quick / Curated bubbles — pinned in their OWN row, fully
              decoupled from the directions list below. Their y is now
              determined only by the workspace + voice slot (both fixed
              height) so they never shift when angles arrive / depart or
              when the streaming line updates. The streaming progress
              has been folded into the voice slot above (single line
              with ellipsis), so no separate streaming panel pushes
              this row down. */}
          {showSearchModeBubbles && (
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

          {/* Directions row — rendered BELOW the buttons so the buttons'
              y stays fixed regardless of whether angles are present.
              Layout: [left-sub-slot | left-flank | right-flank | right-sub-slot].
              The two sub-slots are ALWAYS rendered with a fixed width so
              picking a direction never shifts the flanks horizontally
              (issue: layout was jumping when subs appeared). Subs render
              into the LEFT slot when an even-index direction (0/2/4 on
              the left flank) is picked, and into the RIGHT slot when an
              odd-index direction (1/3/5 on the right flank) is picked —
              so the sub column always appears on the same side as its
              parent direction (issue: subs always going to the right). */}
          {showDirectionBubbles && !showFindingAngles && (() => {
            const SUB_SLOT_WIDTH = "12rem";
            const picked = selectedDirIndex !== null ? directions[selectedDirIndex] : null;
            const pickedSubs = picked?.sub_options ?? [];
            const subsOnLeft  = selectedDirIndex !== null && selectedDirIndex % 2 === 0 && pickedSubs.length > 0;
            const subsOnRight = selectedDirIndex !== null && selectedDirIndex % 2 === 1 && pickedSubs.length > 0;
            // Aesthetic pyramid ordering — within a flank, place the
            // SHORTEST labels at the top + bottom and the LONGEST in the
            // middle. Reads as a soft diamond shape, much easier on the
            // eye than a ragged left/right edge. Only reorders the visual
            // slots; the underlying direction index passed to onClick is
            // preserved so picks still resolve to the right entry.
            const arrangeFlank = (slotIndices: number[]): number[] => {
              const valid = slotIndices.filter(i => directions[i]);
              if (valid.length < 3) return valid;
              const labelLen = (i: number) => directions[i]?.label?.length ?? 0;
              const sorted = [...valid].sort((a, b) => labelLen(a) - labelLen(b));
              // For 3 items [shortest, medium, longest]: render as
              //   [shortest, longest, medium]
              // → top: shortest, middle: longest, bottom: medium.
              if (sorted.length === 3) return [sorted[0], sorted[2], sorted[1]];
              // General case (more than 3 items per flank — not used today
              // but future-proof): place the longest in the centre and
              // alternate shorter items outward.
              const result: number[] = new Array(sorted.length);
              const mid = Math.floor((sorted.length - 1) / 2);
              const slots: number[] = [];
              let off = 0;
              while (slots.length < sorted.length) {
                if (off === 0) slots.push(mid);
                else {
                  const up = mid - off;
                  const down = mid + off;
                  if (up >= 0) slots.push(up);
                  if (down < sorted.length) slots.push(down);
                }
                off += 1;
              }
              for (let i = 0; i < sorted.length; i += 1) {
                result[slots[i]] = sorted[sorted.length - 1 - i];
              }
              return result;
            };
            const leftFlankOrder  = arrangeFlank([0, 2, 4]);
            const rightFlankOrder = arrangeFlank([1, 3, 5]);
            const renderSubButton = (sub: SpriteSubOption, si: number, align: "start" | "end") => {
              const isPickedSub = si === selectedSubIndex;
              const isRecSub    = si === (directionData?.recommended_sub ?? -1);
              return (
                // Sub buttons now share the EXACT same className /
                // padding / typography as the parent direction buttons
                // (sprite-bubble-soft + px-2 py-1) so they read at the
                // same visible size — they only differ in colour + a
                // softer default opacity so the hierarchy is "directions
                // primary, subs secondary". The full hover surface (bg
                // tint + accent text + opacity bump) matches direction
                // hover so every option has the same affordance.
                <button
                  key={`sub-${si}-${sub.label}`}
                  onClick={() => onPickSubDirection(si)}
                  title={sub.reason || sub.label}
                  data-focused={isFocused(`sub-${si}-${sub.label}`) || undefined}
                  className="sprite-bubble-soft inline-flex items-baseline gap-1.5 rounded-md px-2 py-1 transition-all hover:brightness-110 hover:bg-[var(--ats-bg-accent-soft)] hover:text-[var(--ats-fg-accent)] hover:opacity-100 data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-1 data-[focused]:ring-offset-[var(--ats-bg-section)]"
                  style={{
                    backgroundColor: isPickedSub ? "var(--ats-bg-accent-soft)" : "transparent",
                    color:           isPickedSub
                      ? "var(--ats-fg-accent)"
                      : (isRecSub ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)"),
                    fontWeight:      500,
                    // Lighter default than directions so the visual
                    // hierarchy still reads "main angles primary, subs
                    // secondary". Hover snaps to full opacity (see
                    // hover:opacity-100 above) so the option lights up
                    // when the cursor lands on it.
                    opacity:         isPickedSub ? 1 : 0.65,
                    animationDelay:  `${si * 60}ms`,
                    // Keep sub labels on a single line — wrapping was
                    // visually noisy. The slot width is fixed (12rem) but
                    // the button itself can extend beyond it; subs sit on
                    // the OUTER edge of the row so any overflow goes into
                    // empty page margin, not into the flank columns.
                    whiteSpace:      "nowrap",
                    textAlign:       align === "end" ? "right" : "left",
                  }}
                >
                  {isRecSub && (
                    <Star
                      size={11}
                      className="shrink-0"
                      fill="currentColor"
                      style={{ color: "var(--ats-fg-accent)" }}
                      aria-label="recommended"
                    />
                  )}
                  <span>{sub.label}</span>
                </button>
              );
            };
            return (
              <div className="stage-reveal w-full flex items-start justify-center gap-4 px-2">
                {/* LEFT sub-slot — fixed width so the flanks never shift
                    horizontally when subs appear. Filled only when an
                    even-index (left-flank) direction is picked. */}
                <div
                  className="shrink-0 flex flex-col items-end gap-0.5"
                  style={{
                    width:        SUB_SLOT_WIDTH,
                    paddingRight: subsOnLeft ? "0.75rem" : 0,
                    borderRight:  subsOnLeft ? "2px solid var(--ats-border-accent)" : "none",
                  }}
                >
                  {subsOnLeft && (
                    <>
                      {pickedSubs.slice(0, 5).map((sub, si) => renderSubButton(sub, si, "end"))}
                      {pickedSubs.length > 5 && (
                        <span
                          className="self-end px-1.5 italic"
                          style={{ fontSize: "11px", color: "var(--ats-fg-muted)", opacity: 0.7 }}
                          aria-hidden
                        >
                          + {pickedSubs.length - 5} more
                        </span>
                      )}
                    </>
                  )}
                </div>
                {/* Left flank — directions 0, 2, 4 in pyramid order. */}
                <div className="shrink-0 flex flex-col items-end gap-0.5">
                  {leftFlankOrder.map(di => renderDirection({
                    di, dir: directions[di], align: "end",
                    directionData, selectedDirIndex, selectedSubIndex,
                    onPickDirection, onPickSubDirection, isFocused,
                  }))}
                </div>
                {/* Right flank — directions 1, 3, 5 in pyramid order. */}
                <div className="shrink-0 flex flex-col items-start gap-0.5">
                  {rightFlankOrder.map(di => renderDirection({
                    di, dir: directions[di], align: "start",
                    directionData, selectedDirIndex, selectedSubIndex,
                    onPickDirection, onPickSubDirection, isFocused,
                  }))}
                </div>
                {/* RIGHT sub-slot — mirror of the left sub-slot. Filled
                    only when an odd-index (right-flank) direction is
                    picked. */}
                <div
                  className="shrink-0 flex flex-col items-start gap-0.5"
                  style={{
                    width:       SUB_SLOT_WIDTH,
                    paddingLeft: subsOnRight ? "0.75rem" : 0,
                    borderLeft:  subsOnRight ? "2px solid var(--ats-border-accent)" : "none",
                  }}
                >
                  {subsOnRight && (
                    <>
                      {pickedSubs.slice(0, 5).map((sub, si) => renderSubButton(sub, si, "start"))}
                      {pickedSubs.length > 5 && (
                        <span
                          className="self-start px-1.5 italic"
                          style={{ fontSize: "11px", color: "var(--ats-fg-muted)", opacity: 0.7 }}
                          aria-hidden
                        >
                          + {pickedSubs.length - 5} more
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Custom-query input — appears in place of the "type my own…"
              bubble once the user opens it. Submit-on-Enter so the user
              never has to mouse-aim a button. */}
          {showCustomQueryInput && (
            <div className="stage-reveal flex flex-col items-center gap-1.5 w-full max-w-xl">
              <p className="sprite-bubble italic" style={{ color: "var(--ats-fg-muted)" }}>
                type your refined search and hit Enter ⏎
              </p>
              <input
                autoFocus
                value={customQueryValue}
                onChange={(e) => onCustomQueryChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && customQueryValue.trim()) {
                    e.preventDefault();
                    onCustomQuerySubmit();
                  }
                }}
                placeholder="e.g. longitudinal cohort, post-pandemic, US undergrads…"
                className="sprite-bubble w-full rounded-full border px-4 py-2 outline-none transition-all"
                style={{
                  borderColor:     "var(--ats-border-accent)",
                  backgroundColor: "var(--ats-bg-base)",
                  color:           "var(--ats-fg-primary)",
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
});
Sprite.displayName = "Sprite";

/**
 * renderDirection — one big-direction button + its inline sub-options.
 * Lives outside the Sprite body so the same JSX can be reused for the
 * left-flank and right-flank columns of the action+directions row.
 * `align` controls whether the button hugs the column's right ("end")
 * or left ("start") edge — the sub-option strip nests on the same side.
 */
function renderDirection(args: {
  di: number;
  dir: SpriteDirection | undefined;
  align: "start" | "end";
  directionData: SpriteDirectionData;
  selectedDirIndex: number | null;
  selectedSubIndex: number | null;
  onPickDirection: (i: number) => void;
  onPickSubDirection: (i: number) => void;
  isFocused: (key: string) => boolean;
}) {
  const { di, dir, align, directionData, selectedDirIndex,
          onPickDirection, isFocused } = args;
  if (!dir) return null;
  const isRecommended = di === (directionData?.recommended_direction ?? -1);
  const isPicked      = di === selectedDirIndex;
  const dirSubs       = dir.sub_options ?? [];
  const selfClass     = align === "end" ? "self-end" : "self-start";
  // selectedSubIndex / onPickSubDirection live on args.* — they're
  // consumed by the inlined sub-options strip (rendered below the
  // directions row inside the Sprite body) instead of here. Kept on
  // the args type so both callsites can pass through without branching.
  void args.selectedSubIndex; void args.onPickSubDirection;
  return (
    <div
      key={`dir-${di}-${dir.label}`}
      className={`stage-reveal flex flex-col w-full ${align === "end" ? "items-end" : "items-start"}`}
      style={{ animationDelay: `${di * 80}ms` }}
    >
      <button
        onClick={() => onPickDirection(di)}
        title={isRecommended
          ? `${dir.description || dir.label} — recommended for your query`
          : (dir.description || dir.label)}
        data-focused={isFocused(`dir-${di}-${dir.label}`) || undefined}
        className={`sprite-bubble-soft ${selfClass} inline-flex items-baseline gap-1.5 rounded-md px-2 py-1 transition-all hover:brightness-110 hover:bg-[var(--ats-bg-accent-soft)] hover:text-[var(--ats-fg-accent)] data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-1 data-[focused]:ring-offset-[var(--ats-bg-section)]`}
        style={{
          // Recommended direction now gets a soft accent-tinted background
          // EVEN WHEN UNPICKED, plus a brighter star, so users don't have
          // to scan for the small icon to figure out where the AI suggests
          // they start. Picked still wins visually via full accent fill.
          backgroundColor: isPicked
            ? "var(--ats-bg-accent-soft)"
            : (isRecommended ? "var(--ats-bg-card-muted)" : "transparent"),
          color: isPicked
            ? "var(--ats-fg-accent)"
            : (isRecommended ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)"),
          // Constant font-weight across picked/unpicked states. Switching
          // between 400 and 600 made the label render slightly wider when
          // selected, which visibly nudged sibling directions in the same
          // flank — the "shake" the user reported when picking a direction.
          // Visual emphasis still comes from the background + colour swap.
          fontWeight:      500,
          opacity:         isPicked ? 1 : (isRecommended ? 1 : 0.78),
          textAlign:       align === "end" ? "right" : "left",
          // Keep direction labels on a single line so the angle list reads
          // as a clean horizontal arrangement. Wrapping made the columns
          // look ragged and uneven; users prefer everything inline even
          // if the row gets a bit wider.
          whiteSpace:      "nowrap",
        }}
      >
        {isRecommended && (
          <Star
            size={12}
            className="shrink-0"
            fill="currentColor"
            style={{ color: "var(--ats-fg-accent)" }}
            aria-label="recommended"
          />
        )}
        <span>{dir.label}</span>
        {/* Tiny "rec" badge for the recommended angle — the star icon
            alone was easy to miss in scanning, especially on dense
            flanks. The label keeps the badge compact, the muted styling
            keeps it from competing with the direction text. */}
        {isRecommended && !isPicked && (
          <span
            className="ml-1 text-[10px] uppercase tracking-wider font-semibold rounded-full px-1.5 py-px"
            style={{
              color:           "var(--ats-fg-accent)",
              backgroundColor: "var(--ats-bg-accent-soft)",
              opacity:         0.85,
            }}
            aria-hidden
          >
            rec
          </span>
        )}
        {dirSubs.length > 0 && (
          <span
            className="ml-1 text-[10px]"
            style={{ color: "var(--ats-fg-muted)" }}
            aria-hidden
          >
            {isPicked ? "▾" : "▸"}
          </span>
        )}
      </button>
    </div>
  );
}

