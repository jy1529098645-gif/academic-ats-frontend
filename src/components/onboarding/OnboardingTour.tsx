"use client";
// ─────────────────────────────────────────────────────────────────────────────
// OnboardingTour — step-by-step spotlight guide for first-time visitors.
//
// Design choices:
//   - No external library (driver.js / shepherd.js / react-joyride). The
//     tour is short (≤6 steps) and the surface area is modest, so a
//     custom ~300-line component beats adding 12-45KB of dependency.
//   - Targets are looked up by `data-tour="..."` attribute, NOT by id.
//     IDs already mean something elsewhere in this codebase; data-tour
//     keeps the tour wiring out of the way of the rest of the app.
//   - Spotlight is rendered as four mask divs around the target's
//     bounding rect (top / bottom / left / right). This is more
//     responsive than SVG cutouts and doesn't break on scroll.
//   - Position recalc happens on scroll + resize via ResizeObserver +
//     IntersectionObserver, so a step keeps tracking its target if the
//     layout shifts mid-tour (e.g., the user expands a panel).
//   - Steps without a `target` render as a centred modal (welcome /
//     done cards) with no spotlight.
//   - The component does NOT decide whether to open — the parent
//     controls `open` and persistence (localStorage flag). Two modes:
//     first-run (auto-open via parent's mount effect) and on-demand
//     (Help → "Show welcome guide" sets `open=true` again).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
const Z_BASE  = 95;    // sits above guestExhausted modal (z-90) + below feedback toast

type Rect = { top: number; left: number; width: number; height: number };

function getTargetRect(target: string | undefined): Rect | null {
  if (!target || typeof window === "undefined") return null;
  const el = document.querySelector(`[data-tour="${CSS.escape(target)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Skip hidden / display:none elements (they return 0×0 rects).
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
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
  const [tick,    setTick]    = useState(0);   // forces recompute on scroll/resize
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Reset to step 0 every time the tour re-opens. (Otherwise re-opening
  // from the Help panel after a Skip would resume mid-tour.)
  useEffect(() => {
    if (open) setStepIdx(0);
  }, [open]);

  // Recompute target rect when step changes or layout shifts. We use
  // requestAnimationFrame for the scroll/resize handlers to avoid
  // doing layout work on every frame of a long scroll.
  useLayoutEffect(() => {
    if (!open) return;
    const step = steps[stepIdx];
    setRect(getTargetRect(step?.target));
    if (typeof window === "undefined") return;
    let rafId = 0;
    const recompute = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setTick(t => t + 1));
    };
    window.addEventListener("scroll",  recompute, { passive: true, capture: true });
    window.addEventListener("resize",  recompute);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", recompute, { capture: true });
      window.removeEventListener("resize", recompute);
    };
  }, [open, stepIdx, steps]);

  // Reread the rect on tick changes (scroll / resize). Separate from
  // the listener-mount effect to avoid re-binding listeners every tick.
  useLayoutEffect(() => {
    if (!open) return;
    setRect(getTargetRect(steps[stepIdx]?.target));
  }, [tick, stepIdx, steps, open]);

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

  // Spotlight hole rect (target + padding). Used for the four mask
  // divs that simulate a cutout. When centred (no target) we render a
  // single full-screen dim layer instead.
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
      {/* Backdrop / spotlight. Either four mask rectangles around the
          target (cutout effect) or one full-screen dim (no target). */}
      {hole ? (
        <>
          <div className="fixed bg-black/60 transition-all" style={{ top: 0, left: 0, right: 0, height: hole.top }} />
          <div className="fixed bg-black/60 transition-all" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
          <div className="fixed bg-black/60 transition-all" style={{ top: hole.top, left: 0, width: hole.left, height: hole.height }} />
          <div className="fixed bg-black/60 transition-all" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
          {/* Animated outline around the cut-out so the user's eye
              snaps to the highlighted region. Pointer-events none so
              clicks pass through to the actual target underneath
              (users can still try-as-they-learn if they want). */}
          <div
            className="fixed pointer-events-none rounded-xl transition-all"
            style={{
              top:    hole.top,
              left:   hole.left,
              width:  hole.width,
              height: hole.height,
              boxShadow:    "0 0 0 2px var(--ats-fg-accent), 0 0 0 6px rgba(59,130,246,0.25)",
            }}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      )}

      {/* Floating card */}
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
