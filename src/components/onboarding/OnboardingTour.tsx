"use client";
// ─────────────────────────────────────────────────────────────────────────────
// OnboardingTour — step-by-step spotlight guide for first-time visitors.
//
// Design choices:
//   - No external library (driver.js / shepherd.js / react-joyride). The
//     tour is short and the surface area is modest, so a custom ~250-line
//     component beats adding 12-45KB of dependency.
//
//   - Targets are looked up by `data-tour="..."` attribute, NOT by id.
//     IDs already mean something elsewhere in this codebase; data-tour
//     keeps the tour wiring out of the way of the rest of the app.
//
//   - Spotlight is a SINGLE element using the CSS box-shadow donut
//     technique: one absolutely-positioned div sized to the target's
//     bounding rect, with a giant `box-shadow: 0 0 0 9999px rgba(...)`
//     that paints everything outside the rect dark. This is what
//     Intro.js / Driver.js / Shepherd all do under the hood. It scales
//     to any viewport, has zero "edge-alignment" bugs (because there
//     are no four panels to keep in sync), and survives layout shifts.
//
//   - Position tracking uses a continuous `requestAnimationFrame` loop
//     while the tour is open — every frame we re-read
//     getBoundingClientRect() on the target and update state ONLY when
//     the rect changes (so React re-renders are minimal). This catches:
//        · scroll                 (no listener needed)
//        · window resize          (no listener needed)
//        · CSS transitions        (panels expanding / collapsing)
//        · animations             (Sprite reveal, fade-ins)
//        · React re-renders       (target gets bigger/smaller)
//        · DOM additions          (target appears mid-tour)
//     The 60fps cost is negligible; the spotlight stays glued to the
//     target on any device size, dynamic layout, or framework jitter.
//
//   - Steps without a `target` render as a centred modal (welcome /
//     done cards) with no spotlight cutout.
//
//   - The component does NOT decide whether to open — the parent
//     controls `open` and persistence. Two trigger paths today:
//     auth-listener SIGNED_IN and the user-menu Help item, both
//     in src/app/page.tsx.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type TourStep = {
  /** Stable id (used as the React key + telemetry hook). */
  id: string;
  /** `data-tour` attribute value of the element to spotlight. Omit for
   *  centred modal-style steps (welcome / done). */
  target?: string;
  title:    string;
  /** Plain text or short ReactNode. Keep under ~50 words per step. */
  body:     React.ReactNode;
  /** Where the floating card sits relative to the target. Defaults to
   *  "auto" — picks the side with the most room. Centred modal steps
   *  (no target) ignore this and always centre. */
  placement?: "top" | "bottom" | "left" | "right" | "auto";
  /** Optional side-effect fired when this step becomes the active
   *  one. Use to put the page into the visual state that makes the
   *  step's body copy actually true — e.g. opening the user menu so
   *  step 5's "Profile, history, help" callout points at an open
   *  dropdown rather than a closed avatar. Cleanup happens via the
   *  next step's onEnter or via the parent's tour-close handler.
   *
   *  Idempotent: also fires when the user navigates BACK to a step,
   *  so each step's onEnter must restore its desired state from
   *  whatever the previous/next step did. */
  onEnter?: () => void;
};

type Props = {
  open:    boolean;
  steps:   TourStep[];
  onClose: () => void;
  /** Optional — fires after the user completes the last step (vs. Skip
   *  / X). Lets the parent mark "tour finished" separately from
   *  "tour dismissed mid-way" if the analytics distinction matters. */
  onFinish?: () => void;
};

const PADDING = 8;     // px around the highlighted target
const GAP     = 12;    // px between target rect and card
const CARD_W  = 320;   // px — fixed so positioning math is stable
const Z_BASE  = 95;    // sits above guestExhausted modal (z-90), below sign-in (z-9400) + TOS gate (z-9500)

type Rect = { top: number; left: number; width: number; height: number };

function readRect(target: string | undefined): Rect | null {
  if (!target || typeof window === "undefined") return null;
  const el = document.querySelector(`[data-tour="${CSS.escape(target)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Skip hidden / display:none elements (they return 0×0 rects).
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  // 0.5px threshold — sub-pixel jitter from CSS transforms or
  // device-pixel-ratio rounding shouldn't trigger re-renders.
  return Math.abs(a.top - b.top)       < 0.5
      && Math.abs(a.left - b.left)     < 0.5
      && Math.abs(a.width - b.width)   < 0.5
      && Math.abs(a.height - b.height) < 0.5;
}

/** Pick the side with the most room. Left/right preferred when the
 *  target is short (icon, button); top/bottom for tall things. */
function pickPlacement(rect: Rect, vw: number, vh: number): Exclude<TourStep["placement"], "auto" | undefined> {
  const spaceTop    = rect.top;
  const spaceBottom = vh - rect.top - rect.height;
  const spaceLeft   = rect.left;
  const spaceRight  = vw - rect.left - rect.width;
  const isShort = rect.height < 120;
  if (isShort) {
    if (spaceBottom >= 200) return "bottom";
    if (spaceTop    >= 200) return "top";
  }
  if (spaceRight >= CARD_W + GAP) return "right";
  if (spaceLeft  >= CARD_W + GAP) return "left";
  return spaceBottom >= spaceTop ? "bottom" : "top";
}

function cardPosition(rect: Rect, placement: Exclude<TourStep["placement"], "auto" | undefined>, vw: number, vh: number): { top: number; left: number } {
  const cardH = 200; // estimate; actual height varies but this only feeds clamping
  let top = 0, left = 0;
  switch (placement) {
    case "top":
      top  = rect.top - GAP - cardH;
      left = rect.left + rect.width / 2 - CARD_W / 2;
      break;
    case "bottom":
      top  = rect.top + rect.height + GAP;
      left = rect.left + rect.width / 2 - CARD_W / 2;
      break;
    case "left":
      top  = rect.top + rect.height / 2 - cardH / 2;
      left = rect.left - GAP - CARD_W;
      break;
    case "right":
      top  = rect.top + rect.height / 2 - cardH / 2;
      left = rect.left + rect.width + GAP;
      break;
  }
  // Clamp to viewport so the card never goes off-screen on small displays.
  top  = Math.max(GAP, Math.min(top,  vh - cardH - GAP));
  left = Math.max(GAP, Math.min(left, vw - CARD_W - GAP));
  return { top, left };
}

export default function OnboardingTour({ open, steps, onClose, onFinish }: Props) {
  const [stepIdx, setStepIdx] = useState(0);
  const [rect,    setRect]    = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Reset to step 0 every time the tour re-opens. (Otherwise re-opening
  // from the Help panel after a Skip would resume mid-tour.)
  useEffect(() => {
    if (open) setStepIdx(0);
  }, [open]);

  // Fire the active step's onEnter side-effect when the step changes
  // (or on first open). Lets the parent put the page into the visual
  // state that the step's spotlight + body copy assume — e.g. open
  // the user menu, expand a panel. Wrapped in try/catch so a bad
  // onEnter doesn't break tour navigation.
  useEffect(() => {
    if (!open) return;
    const step = steps[stepIdx];
    if (!step?.onEnter) return;
    try { step.onEnter(); } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[onboarding] step.onEnter threw:", err);
    }
  }, [open, stepIdx, steps]);

  // Continuous rect polling — every frame, re-read the target's
  // bounding rect and update state only if it changed. This is the
  // ONE mechanism that keeps the spotlight glued to the target across
  // every layout-shift case (scroll, resize, CSS transitions on
  // panels, React re-renders, animations). No scroll/resize listeners
  // needed; the RAF loop is the single source of truth.
  //
  // 60fps × one rect read × one cheap shallow compare per frame is
  // negligible — the loop runs only while `open` is true and stops
  // immediately on close.
  useEffect(() => {
    if (!open) return;
    const target = steps[stepIdx]?.target;
    let rafId = 0;
    let prev: Rect | null = null;
    const tick = () => {
      const next = readRect(target);
      if (!rectsEqual(prev, next)) {
        prev = next;
        setRect(next);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [open, stepIdx, steps]);

  // Keyboard: ESC to close, arrows to navigate.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") {
        if (stepIdx < steps.length - 1) setStepIdx(stepIdx + 1);
        else { onFinish?.(); onClose(); }
      }
      else if (e.key === "ArrowLeft" && stepIdx > 0) setStepIdx(stepIdx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, stepIdx, steps, onClose, onFinish]);

  if (!open || typeof document === "undefined") return null;
  const step = steps[stepIdx];
  if (!step) return null;

  const vw = typeof window !== "undefined" ? window.innerWidth  : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight :  768;

  const isCentred = !step.target || !rect;
  const placement: Exclude<TourStep["placement"], "auto" | undefined> = (() => {
    if (isCentred || !rect) return "bottom"; // unused when centred
    if (step.placement && step.placement !== "auto") return step.placement;
    return pickPlacement(rect, vw, vh);
  })();

  const card = (() => {
    if (isCentred || !rect) return { top: vh / 2 - 150, left: vw / 2 - CARD_W / 2 };
    return cardPosition(rect, placement, vw, vh);
  })();

  // Spotlight cutout = target rect + padding. We render this as a
  // SINGLE div with a gigantic box-shadow that paints everything
  // OUTSIDE the rect dark — far more reliable than four edge-aligned
  // mask divs (which were producing the off-by-N drift the user hit).
  const hole = rect ? {
    top:    rect.top    - PADDING,
    left:   rect.left   - PADDING,
    width:  rect.width  + PADDING * 2,
    height: rect.height + PADDING * 2,
  } : null;

  const isLast  = stepIdx === steps.length - 1;
  const isFirst = stepIdx === 0;

  return createPortal(
    <div
      className="fixed inset-0"
      style={{ zIndex: Z_BASE }}
      aria-modal="true"
      role="dialog"
      aria-labelledby="onboarding-tour-title"
    >
      {hole ? (
        <>
          {/* Spotlight cutout — single donut element. The 9999px
              box-shadow paints "everything outside this rect" dark,
              giving us a perfectly aligned cutout with no edge-sync
              problems. The accent ring is layered onto the same
              element via the second box-shadow term so the outline
              is automatically tied to the rect's geometry.
              pointer-events-none lets the user click through to the
              real target underneath (try-as-you-learn).

              No CSS transition: the RAF polling loop above updates
              `rect` every frame the target moves, and React commits
              a fresh top/left/width/height immediately. A
              `transition: 150ms` here would make the spotlight chase
              the target with visible lag — exactly the "跑偏"
              behaviour the user reported. Snap-to-rect each frame
              gives a stuck-to-the-target feel even during panel
              expansions, scrolls, and viewport resizes. */}
          <div
            className="fixed pointer-events-none rounded-xl"
            style={{
              top:    hole.top,
              left:   hole.left,
              width:  hole.width,
              height: hole.height,
              boxShadow: [
                "0 0 0 9999px rgba(0, 0, 0, 0.55)",
                "0 0 0 2px var(--ats-fg-accent)",
                "0 0 0 6px rgba(59, 130, 246, 0.25)",
              ].join(", "),
            }}
          />
        </>
      ) : (
        // No target → full-screen dim for centred welcome / done cards.
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      )}

      {/* Floating card. Same no-transition rationale as the
          spotlight: the card position is recomputed from the
          spotlight rect every RAF tick, so we want every commit to
          be the latest position. A CSS transition would make the
          card slide from old position to new with visible lag. */}
      <div
        ref={cardRef}
        className="fixed rounded-2xl border shadow-2xl p-5"
        style={{
          top:             card.top,
          left:            card.left,
          width:           CARD_W,
          borderColor:     "var(--ats-border-subtle)",
          backgroundColor: "var(--ats-bg-panel)",
          color:           "var(--ats-fg-primary)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Step counter pip + close button */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1">
            {steps.map((s, i) => (
              <span
                key={s.id}
                className="rounded-full transition-all"
                style={{
                  width:           i === stepIdx ? 18 : 6,
                  height:          6,
                  backgroundColor: i === stepIdx
                    ? "var(--ats-fg-accent)"
                    : i < stepIdx
                      ? "var(--ats-fg-secondary)"
                      : "var(--ats-border-subtle)",
                }}
              />
            ))}
          </div>
          <button
            onClick={onClose}
            aria-label="Close tour"
            className="text-xs hover:opacity-80 transition-opacity"
            style={{ color: "var(--ats-fg-muted)" }}
          >Skip</button>
        </div>

        <h3 id="onboarding-tour-title" className="text-base font-bold mb-1.5" style={{ color: "var(--ats-fg-primary)" }}>
          {step.title}
        </h3>
        <div className="text-xs leading-relaxed mb-4" style={{ color: "var(--ats-fg-secondary)" }}>
          {step.body}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setStepIdx(stepIdx - 1)}
            disabled={isFirst}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ color: "var(--ats-fg-secondary)" }}
          >← Back</button>
          <span className="text-[10px]" style={{ color: "var(--ats-fg-muted)" }}>
            {stepIdx + 1} / {steps.length}
          </span>
          <button
            onClick={() => {
              if (isLast) { onFinish?.(); onClose(); }
              else        { setStepIdx(stepIdx + 1); }
            }}
            className="text-xs px-4 py-1.5 rounded-lg font-semibold transition-all hover:brightness-110"
            style={{
              backgroundColor: "var(--ats-fg-accent)",
              color:           "#ffffff",
            }}
          >{isLast ? "Got it" : "Next →"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
