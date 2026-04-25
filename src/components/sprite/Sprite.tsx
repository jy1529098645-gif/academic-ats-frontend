"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { FlaskConical, PenLine, Star, Zap } from "lucide-react";
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
    // Reset focus to a sensible default when the bubble set changes shape.
    if (actionables.length === 0) {
      setFocusedKey(null);
      return;
    }
    const recIdx = directionData?.recommended_direction;
    const recKey = (typeof recIdx === "number" && recIdx >= 0 && recIdx < directions.length)
      ? `dir-${recIdx}-${directions[recIdx]?.label}`
      : null;
    const recAvailable = recKey !== null && actionables.some(a => a.key === recKey);
    // Two cases shift focus automatically:
    //   1. No focus yet, or stale focus that no longer matches any bubble.
    //   2. Focus is currently parked on a "mode-*" bubble because mode
    //      bubbles arrived FIRST (Find Angles streaming) — once a real
    //      direction appears (recommended one preferred), shift to it
    //      so the user's first ArrowRight/Enter targets that direction.
    const focusInvalid    = focusedKey === null || !actionables.some(a => a.key === focusedKey);
    const focusOnModeOnly = focusedKey?.startsWith("mode-") && recAvailable;
    if (focusInvalid || focusOnModeOnly) {
      setFocusedKey(recAvailable ? recKey : actionables[0].key);
    }
  }, [actionables, directionData?.recommended_direction, directions, focusedKey]);

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
          {!hoverHelp && showFindingAngles && !showMessage && (
            // Streamed progress message (e.g. "scanning literature…",
            // "narrowing direction…") replaces the canned line so the user
            // sees real motion. Falls back to the original wording when the
            // stream hasn't yielded a status yet.
            <p
              key={understandStatus || "looking-for-angles"}
              className="sprite-voice stage-reveal inline-flex items-center gap-2 italic"
              style={{ color: "var(--ats-fg-muted)" }}
            >
              <span
                className="sprite-dot-think inline-block h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: "var(--ats-fg-accent)" }}
                aria-hidden
              />
              {understandStatus || "looking for angles…"}
            </p>
          )}
          {/* Streaming "what I'm seeing" panel — always rendered while
              find-angles is in flight. Each row keeps its label even
              when its data hasn't arrived yet, showing a pulsing dot in
              place of tags so the user sees the SCAFFOLD of what's
              about to happen ("reading", "expanding", "found") instead
              of a blank slot followed by a sudden pop. */}
          {showFindingAngles && (
            <div
              className="stage-reveal w-full max-w-lg flex flex-col gap-1.5 rounded-xl px-3 py-2"
              style={{ backgroundColor: "var(--ats-bg-card-muted)" }}
            >
              <SpriteThinkingRow
                label="reading"
                items={understandDecompose ? [
                  ...((understandDecompose.core_terms as string[] | undefined) ?? []).slice(0, 6),
                  ...((understandDecompose.contexts as string[] | undefined) ?? []).slice(0, 3),
                ] : []}
                placeholder="scanning your query…"
              />
              <SpriteThinkingRow
                label="expanding"
                items={understandExpand ? (() => {
                  const clusters = understandExpand.clusters as Array<Record<string, unknown>> | undefined;
                  const out: string[] = [];
                  if (Array.isArray(clusters)) {
                    for (const c of clusters.slice(0, 3)) {
                      const terms = (c?.terms as string[] | undefined) ?? [];
                      out.push(...terms.slice(0, 3));
                    }
                  }
                  return out.slice(0, 9);
                })() : []}
                placeholder={understandDecompose ? "pulling in related terms…" : "waiting on stage 1…"}
              />
              <SpriteThinkingRow
                label="found"
                items={(directionData?.directions ?? []).map(d => d.label).slice(0, 6)}
                placeholder={understandExpand ? "building direction tree…" : "waiting on stage 2…"}
                emphasis
              />
            </div>
          )}
          {!hoverHelp && showMessage && !showFindingAngles && (
            // key on the message text so a fresh verdict re-fires the
            // stage-reveal fade — feels like the sprite is "saying" each new
            // line rather than silently swapping the text.
            <p
              key={currentMessage}
              className="sprite-voice stage-reveal inline-flex items-center gap-2 italic leading-snug"
              style={{ color: "var(--ats-fg-secondary)" }}
            >
              {/* THINK tempo while waiting on instant-reaction fade or AI verdict;
                  IDLE once a settled verdict is on screen. Subtle breathing
                  cue separates "sprite is working" from "sprite is resting". */}
              <span
                className={`${(activeInstant || assessing) ? "sprite-dot-think" : "sprite-dot-idle"} inline-block h-2.5 w-2.5 rounded-full shrink-0`}
                style={{ backgroundColor: "var(--ats-fg-accent)" }}
                aria-hidden
              />
              <span>{currentMessage}</span>
              {/* Enter badge only with a fresh AI verdict — during the instant-
                  reaction layer the sprite hasn't actually judged yet. */}
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
          {/* Fallback voice — kicks in for the post-Run / post-results
              states where the regular thinking / message / default
              voices don't apply. Keeps the sprite slot live so the
              user always feels in conversation, even mid-search. */}
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

          {/* Quick / Curated bubbles — the actual SEARCH trigger. Replaces
              the legacy in-action-bar mode toggle + "Start" button.
              Quick = fast smart-ranked retrieval; Curated = multi-agent
              deep dive. Either commits the user's current direction
              picks (or raw query if no direction picked) and fires the
              search in one click. Visible throughout the directions
              stream so the user can either pick a direction first or
              jump straight to a mode. */}
          {showSearchModeBubbles && (
            <div className="stage-reveal flex flex-wrap items-center justify-center gap-2">
              {/* Both action bubbles share IDENTICAL neutral styling so
                  neither one looks like the recommended default — the
                  user picks based on intent, not visual nudging. The
                  only contextual feedback is hover (brightness bump) +
                  keyboard focus ring (data-[focused]). */}
              <button
                onClick={() => onStartSearch("quick")}
                title="Fast smart-ranked search — seconds to results"
                {...hh("Quick Search — fast smart-ranked retrieval, results in seconds")}
                data-focused={isFocused("mode-quick") || undefined}
                className="sprite-bubble inline-flex items-center gap-1.5 rounded-full border px-4 py-2 font-semibold transition-all hover:brightness-110 hover:border-[var(--ats-border-accent)] data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-2 data-[focused]:ring-offset-[var(--ats-bg-section)]"
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
                {...hh("Curated Analysis — multi-agent deep dive (3-5 min), much more careful evidence chains")}
                data-focused={isFocused("mode-curated") || undefined}
                className="sprite-bubble inline-flex items-center gap-1.5 rounded-full border px-4 py-2 font-semibold transition-all hover:brightness-110 hover:border-[var(--ats-border-accent)] data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-2 data-[focused]:ring-offset-[var(--ats-bg-section)]"
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

          {/* Direction bubbles — once the directions stream completes, the
              big-direction options surface as a TIDY 2-column grid so they
              never overflow the workspace column. Each bubble fades in
              with a staggered delay (~90 ms apart) so the user perceives
              the result as "streamed" even though the SSE result event is
              a single payload. The currently-picked / recommended bubble
              gets accent styling so the choice stays visible. */}
          {showDirectionBubbles && !showFindingAngles && (
            // Direction tree, two-column layout: 6 big directions split
            // into a left column (0,2,4) and a right column (1,3,5) so
            // they stay above the fold even on shorter viewports. Each
            // direction's sub-options nest UNDER it (border-l indent)
            // when picked, so the parent-child relationship stays
            // visually grouped INSIDE its column.
            <div className="stage-reveal w-full max-w-3xl grid grid-cols-2 gap-x-4 gap-y-0.5 px-1">
              {directions.slice(0, 6).map((dir, di) => {
                const isRecommended = di === (directionData?.recommended_direction ?? -1);
                const isPicked      = di === selectedDirIndex;
                const dirSubs       = dir.sub_options ?? [];
                return (
                  <div
                    key={`dir-${di}-${dir.label}`}
                    className="stage-reveal flex flex-col"
                    style={{ animationDelay: `${di * 80}ms` }}
                  >
                    <button
                      onClick={() => onPickDirection(di)}
                      title={dir.description || dir.label}
                      data-focused={isFocused(`dir-${di}-${dir.label}`) || undefined}
                      className="sprite-bubble-soft self-start inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-all hover:brightness-110 hover:bg-[var(--ats-bg-accent-soft)] hover:text-[var(--ats-fg-accent)] data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-1 data-[focused]:ring-offset-[var(--ats-bg-section)]"
                      style={{
                        backgroundColor: isPicked ? "var(--ats-bg-accent-soft)" : "transparent",
                        color:           isPicked ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
                        fontWeight:      isPicked ? 600 : 400,
                        opacity:         isPicked ? 1 : (isRecommended ? 0.95 : 0.78),
                      }}
                    >
                      {isRecommended && <Star size={11} className="shrink-0 opacity-70" />}
                      <span className="text-left">{dir.label}</span>
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
                    {/* Inline sub-options — only render when THIS row is
                        picked. The left border + indent visually anchor
                        the children to the parent row above so the user
                        can't confuse which sub-option came from which
                        direction. */}
                    {isPicked && dirSubs.length > 0 && (
                      <div
                        className="stage-reveal ml-3 mt-0.5 flex flex-wrap items-center gap-1 pl-2 py-0.5"
                        style={{ borderLeft: "2px solid var(--ats-border-accent)" }}
                      >
                        {dirSubs.slice(0, 8).map((sub, si) => {
                          const isPickedSub  = si === selectedSubIndex;
                          const isRecSub     = si === (directionData?.recommended_sub ?? -1);
                          return (
                            <button
                              key={`sub-${si}-${sub.label}`}
                              onClick={() => onPickSubDirection(si)}
                              title={sub.reason || sub.label}
                              data-focused={isFocused(`sub-${si}-${sub.label}`) || undefined}
                              className="sprite-bubble-soft inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-all hover:brightness-110 hover:bg-[var(--ats-bg-accent-soft)] hover:text-[var(--ats-fg-accent)] data-[focused]:ring-2 data-[focused]:ring-[var(--ats-fg-accent)] data-[focused]:ring-offset-1 data-[focused]:ring-offset-[var(--ats-bg-section)]"
                              style={{
                                backgroundColor: isPickedSub ? "var(--ats-bg-accent-soft)" : "transparent",
                                color:           isPickedSub ? "var(--ats-fg-accent)" : (isRecSub ? "var(--ats-fg-accent)" : "var(--ats-fg-secondary)"),
                                fontWeight:      isPickedSub ? 600 : 400,
                                opacity:         isPickedSub ? 1 : 0.85,
                                animationDelay:  `${si * 60}ms`,
                              }}
                            >
                              {isRecSub && <Star size={9} className="shrink-0 opacity-70" />}
                              <span className="text-left">{sub.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

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
 * SpriteThinkingRow — single labelled row of "what the AI is currently
 * looking at" tags. Used by the streaming-thinking panel to surface
 * decompose / expand / found payloads with a uniform shape so the user
 * can read them at a glance during the directions stream.
 */
function SpriteThinkingRow({
  label,
  items,
  placeholder,
  emphasis,
}: {
  label: string;
  items: string[];
  placeholder?: string;
  emphasis?: boolean;
}) {
  const hasItems = items && items.length > 0;
  return (
    <div className="stage-reveal flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span
        className="sprite-bubble-soft uppercase tracking-wider shrink-0"
        style={{ color: "var(--ats-fg-muted)", fontSize: "calc(11px * var(--sprite-zoom-comp))" }}
      >
        {label}
      </span>
      {hasItems ? items.map((it, i) => (
        <span
          key={`${label}-${i}-${it}`}
          className="sprite-bubble-soft stage-reveal"
          style={{
            color:           emphasis ? "var(--ats-fg-accent)" : "var(--ats-fg-secondary)",
            fontWeight:      emphasis ? 600 : 400,
            animationDelay:  `${i * 40}ms`,
          }}
        >
          {it}{i < items.length - 1 ? "," : ""}
        </span>
      )) : (
        <span
          className="sprite-bubble-soft inline-flex items-center gap-1.5 italic"
          style={{ color: "var(--ats-fg-muted)" }}
        >
          <span
            className="sprite-dot-think inline-block h-2 w-2 rounded-full shrink-0"
            style={{ backgroundColor: "var(--ats-fg-muted)" }}
            aria-hidden
          />
          {placeholder ?? "thinking…"}
        </span>
      )}
    </div>
  );
}
