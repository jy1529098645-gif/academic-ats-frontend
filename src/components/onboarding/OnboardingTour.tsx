"use client";
// ─────────────────────────────────────────────────────────────────────────────
// OnboardingTour — step-by-step spotlight guide for first-time visitors.
//
// Design choices:
//   - No external library (driver.js / shepherd.js / react-joyride). The
//     tour is short and the surface area is modest, so a custom component
//     beats adding 12-45KB of dependency.
//
//   - Targets are looked up by `data-tour="..."` attribute, NOT by id.
//     IDs already mean something elsewhere in this codebase; data-tour
//     keeps the tour wiring out of the way of the rest of the app.
//
//   - Spotlight is a SINGLE element using the CSS box-shadow donut
//     technique: one absolutely-positioned div sized to the target's
//     bounding rect, with a giant `box-shadow: 0 0 0 9999px rgba(...)`
//     that paints everything outside the rect dark. Scales to any
//     viewport, has zero edge-alignment bugs, survives layout shifts.
//
//   - Centred (no-target) steps use translate(-50%,-50%) for centring,
//     not viewport-math offsets. Independent of measured viewport
//     dimensions and the card's actual rendered height — survives
//     window resizes mid-step and any padding/font changes that affect
//     the card's height.
//
//   - State machine for the spotlight rect:
//        · A ref tracks the last step index we processed. When the
//          parent re-renders and passes a new `steps` array reference
//          (which happens every render in JSX-inline configs), we do
//          NOT re-fire onEnter / re-clear rect — only on real step
//          transitions (stepIdx changed) or on first open.
//        · On a real step transition we IMMEDIATELY clear `rect` to
//          null so the prior step's spotlight cannot leak into a
//          centred (no-target) step. (Fixes the bug where the final
//          "You're set" card showed the previous step's blue ring.)
//        · A continuous `requestAnimationFrame` loop polls
//          getBoundingClientRect() on the current target and updates
//          rect state when it changes. This catches scroll, resize,
//          CSS transitions, animations, React re-renders, and DOM
//          additions (target appears mid-step) without listeners.
//
//   - The component does NOT decide whether to open — the parent
//     controls `open` and persistence. Two trigger paths today:
//     auth-listener SIGNED_IN and the user-menu Help item, both
//     in src/app/page.tsx.
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
  /** Optional side-effect fired exactly once when this step becomes
   *  the active one (and again if the user navigates back to it).
   *  Use to put the page into the visual state that makes the step's
   *  body copy actually true — e.g. opening the user menu so step 5's
   *  "Profile, history, help" callout points at an open dropdown,
   *  or expanding the right panel so step 4's "Draft & Review live
   *  here" highlights an actually-visible region rather than the
   *  collapsed sliver.
   *
   *  Idempotent: also fires when the user navigates BACK to a step,
   *  so each step's onEnter must restore its desired state from
   *  whatever the previous/next step did. The parent should snapshot
   *  pre-tour state and restore on close so the tour leaves no trace. */
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

/** The page applies `html { zoom: 0.66 }` (and similar) at smaller
 *  viewports — see globals.css media queries. With zoom in effect:
 *    · getBoundingClientRect() returns VISUAL (post-zoom) pixels
 *    · inline style `top: Xpx` is interpreted as CSS (pre-zoom) pixels,
 *      and the browser renders it at X * zoom on screen
 *  Mixing the two would put the spotlight at zoom × the target's
 *  visual position (i.e. visually wrong by the zoom factor). To paint
 *  the spotlight on top of the target visually, we read rects in
 *  visual pixels and divide by zoom before feeding them into inline
 *  styles — that way the browser's own × zoom multiplication brings
 *  us back to the target's visual position. */
function getDocumentZoom(): number {
  if (typeof document === "undefined") return 1;
  const raw = getComputedStyle(document.documentElement).zoom;
  const n = parseFloat(raw || "1");
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function readRect(target: string | undefined): Rect | null {
  if (!target || typeof window === "undefined") return null;
  const el = document.querySelector(`[data-tour="${CSS.escape(target)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Skip hidden / display:none elements (they return 0×0 rects).
  if (r.width === 0 && r.height === 0) return null;
  // Convert visual → CSS pixels (see comment on getDocumentZoom).
  const z = getDocumentZoom();
  return { top: r.top / z, left: r.left / z, width: r.width / z, height: r.height / z };
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

function cardPosition(rect: Rect, placement: Exclude<TourStep["placement"], "auto" | undefined>, vw: number, vh: number, cardH: number): { top: number; left: number } {
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
  // Measured card height in CSS pixels. Cards have variable height
  // depending on body-text length and viewport zoom; a hardcoded
  // estimate underestimated taller cards (e.g. "Send us feedback")
  // and let cardPosition's clamp leave the card hanging off the
  // viewport bottom. We measure post-render via cardRef and feed
  // the actual height back into cardPosition's clamp. Initial
  // value 280 is a reasonable first-paint guess; gets corrected on
  // the next frame. */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardH, setCardH] = useState(280);
  // Tracks the last step index we ran the "step changed" side-effects
  // for (rect-clear + onEnter). Without this, every parent re-render
  // would re-fire onEnter (because inline JSX `steps={[...]}` creates
  // a new array reference each render and the effect depends on
  // `steps`). We want exactly-once-per-transition semantics.
  const lastFiredRef = useRef<number>(-1);

  // Fade-cycle state. Each step transition runs:
  //   t=0    : `fading` flips to true → card + spotlight transition opacity to 0
  //   t=FADE : rect cleared, onEnter fires, `fading` flips back to false →
  //            card + spotlight transition opacity to 1 against the new state
  // The spotlight ALSO has CSS transitions on top/left/width/height so any
  // within-step rect drift (scroll, layout shift) follows smoothly without
  // the snap-jump that the old "no transition" implementation had.
  const FADE_MS = 180;
  const [fading, setFading] = useState(false);

  // Reset to step 0 every time the tour re-opens. (Otherwise re-opening
  // from the Help panel after a Skip would resume mid-tour.)
  useEffect(() => {
    if (open) {
      setStepIdx(0);
      setRect(null);
      lastFiredRef.current = -1;
      // Initial open enters the fade-cycle too so the card fades IN from
      // opacity 0 rather than popping into existence.
      setFading(true);
    }
  }, [open]);

  // Latest `steps` array, captured into a ref so the fade-cycle effect
  // below can read the current step's onEnter without listing `steps`
  // as a dep (parent re-renders pass a fresh inline `steps={[...]}`
  // every render — listing it would clear our pending fade timer mid-
  // cycle and leave the card stuck at opacity 0).
  const stepsRef = useRef(steps);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  // Fade-cycle effect — keyed ONLY on real step transitions (`open` and
  // `stepIdx`). Does NOT depend on `steps` because the parent re-creates
  // the steps array on every render; including it here would re-fire
  // cleanup mid-fade and prevent the fade-in setFading(false) from
  // landing.
  useEffect(() => {
    if (!open) return;
    setFading(true);
    const t = setTimeout(() => {
      const step = stepsRef.current[stepIdx];
      if (step?.onEnter) {
        try { step.onEnter(); } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[onboarding] step.onEnter threw:", err);
        }
      }
      lastFiredRef.current = stepIdx;
      setFading(false);
    }, FADE_MS);
    return () => clearTimeout(t);
  }, [open, stepIdx]);

  // Wipe rect on step transitions so the spotlight starts clean. The
  // RAF effect below will re-measure once the new step has rendered.
  // We do NOT clear rect inside the fade timeout because that would
  // race with the RAF effect's local-prev cache (which would then
  // refuse to re-set rect because its cached prev still matches the
  // post-clear DOM rect, leaving state stuck at null forever). Doing
  // the clear here, in a separate effect that fires on stepIdx change,
  // means React commits null → RAF cleanup runs → RAF re-arms with
  // fresh prev=null → next tick re-populates rect.
  useEffect(() => {
    if (!open) return;
    setRect(null);
  }, [open, stepIdx]);

  // RAF rect-tracking effect — keyed on `steps` so a parent re-render
  // that swaps the inline array reference re-arms the loop with the
  // fresh closure (the target is read from step.target each tick).
  // Independent from the fade-cycle effect above so its cleanup can
  // re-fire freely without disturbing in-flight fades.
  useEffect(() => {
    if (!open) return;
    const step = steps[stepIdx];
    if (!step?.target) return;

    let rafId = 0;
    let prev: Rect | null = null;
    const tick = () => {
      const next = readRect(step.target);
      if (!rectsEqual(prev, next)) {
        prev = next;
        setRect(next);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [open, stepIdx, steps]);

  // Measure the card's actual rendered height and feed it back into
  // cardPosition's viewport clamp. useLayoutEffect (not useEffect) so
  // we read the height in the same paint as the position commit, no
  // visual jump. Runs after every render so card body changes (each
  // step has different copy → different height) get re-measured.
  // getBoundingClientRect returns visual pixels under html { zoom }
  // — divide by zoom to keep the value in CSS pixels (which is the
  // unit cardPosition operates in).
  useLayoutEffect(() => {
    if (!open || !cardRef.current) return;
    const z = getDocumentZoom();
    const measured = cardRef.current.getBoundingClientRect().height / z;
    if (measured > 0 && Math.abs(measured - cardH) > 1) {
      setCardH(measured);
    }
  });

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

  // Viewport in CSS pixels (window.innerWidth/Height returns visual
  // pixels, and our rect math is in CSS pixels — see readRect comment).
  const z  = getDocumentZoom();
  const vw = typeof window !== "undefined" ? window.innerWidth  / z : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight / z :  768;

  // Centred = step has no target (welcome / done) OR target's rect
  // hasn't been read yet (target not in DOM). Either case: show the
  // card centred with a plain dim backdrop, NO spotlight.
  const isCentred = !step.target || !rect;
  const placement: Exclude<TourStep["placement"], "auto" | undefined> = (() => {
    if (isCentred || !rect) return "bottom"; // unused when centred
    if (step.placement && step.placement !== "auto") return step.placement;
    return pickPlacement(rect, vw, vh);
  })();

  // Spotlight cutout = target rect + padding. Only shown when both
  // a target is declared AND its rect has been measured. Anything
  // else falls through to the dim backdrop branch — no leaking
  // spotlight from a previous step.
  const showSpotlight = !!step.target && !!rect;
  const hole = showSpotlight && rect ? {
    top:    rect.top    - PADDING,
    left:   rect.left   - PADDING,
    width:  rect.width  + PADDING * 2,
    height: rect.height + PADDING * 2,
  } : null;

  const isLast  = stepIdx === steps.length - 1;
  const isFirst = stepIdx === 0;

  // Card positioning. Centred steps use translate(-50%,-50%) so the
  // card is perfectly centred regardless of its actual rendered
  // height — no reliance on a hardcoded cardH estimate or measured
  // viewport dimensions. Targeted steps use the cardPosition() math
  // (top/left in px) to anchor relative to the spotlight rect.
  const cardStyle: React.CSSProperties = isCentred
    ? {
        top:       "50%",
        left:      "50%",
        transform: "translate(-50%, -50%)",
        width:     CARD_W,
      }
    : (() => {
        const pos = cardPosition(rect!, placement, vw, vh, cardH);
        return { top: pos.top, left: pos.left, width: CARD_W };
      })();

  return createPortal(
    // Outer wrapper: pointer-events-none so the user can interact
    // with the spotlit area underneath (try-as-you-learn). The
    // children that NEED to capture clicks — the dim backdrop
    // (no-target steps) and the floating card (always) — re-enable
    // pointer-events:auto on themselves. The spotlight ring is
    // always pointer-events-none so it never blocks the target
    // beneath it. Without this, the wrapper's default
    // pointer-events:auto would intercept every click in the
    // viewport and the user could not e.g. click the feedback
    // button while the spotlight points at it.
    <div
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: Z_BASE }}
      aria-modal="true"
      role="dialog"
      aria-labelledby="onboarding-tour-title"
    >
      {hole ? (
        // Spotlight cutout — single donut element. The 9999px
        // box-shadow paints "everything outside this rect" dark,
        // giving us a perfectly aligned cutout with no edge-sync
        // problems. The accent ring is layered onto the same
        // element via the second box-shadow term so the outline
        // is automatically tied to the rect's geometry.
        // pointer-events-none lets the user click through to the
        // real target underneath (try-as-you-learn).
        // CSS transitions on top/left/width/height + opacity give
        // smooth motion when the rect changes mid-step (scroll /
        // layout shift) AND on step transitions (faded out → new
        // rect → faded back in).
        <div
          className="fixed pointer-events-none rounded-xl"
          style={{
            top:    hole.top,
            left:   hole.left,
            width:  hole.width,
            height: hole.height,
            opacity: fading ? 0 : 1,
            transition: "top 250ms cubic-bezier(0.4,0,0.2,1), left 250ms cubic-bezier(0.4,0,0.2,1), width 250ms cubic-bezier(0.4,0,0.2,1), height 250ms cubic-bezier(0.4,0,0.2,1), opacity 180ms ease-out",
            boxShadow: [
              "0 0 0 9999px rgba(0, 0, 0, 0.55)",
              "0 0 0 2px var(--ats-fg-accent)",
              "0 0 0 6px rgba(59, 130, 246, 0.25)",
            ].join(", "),
          }}
        />
      ) : (
        // No target (or rect not yet measured) → full-screen dim for
        // centred welcome / done cards. Plain dim, no spotlight ring.
        // pointer-events:auto re-enabled here (wrapper is none) so
        // the dim layer blocks page interaction during welcome /
        // done — there's nothing to interact with under those. Opacity
        // transition keeps the dim consistent with the spotlight fade.
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto"
          style={{ opacity: fading ? 0 : 1, transition: "opacity 180ms ease-out" }}
        />
      )}

      {/* Floating card. Uses translate-centring for centred steps and
          absolute top/left for targeted steps. CSS transitions on
          top/left + opacity smooth out the per-step jump and the
          per-frame RAF rect chases. The duration is short enough
          that the lag against fast-moving targets stays imperceptible
          (≤4 frames at 60fps).
          pointer-events:auto re-enabled (wrapper is none) so the
          Back / Next / Skip buttons remain clickable.
          cardRef feeds the post-render height measurement back into
          cardPosition's bottom-clamp — see useLayoutEffect below. */}
      <div
        ref={cardRef}
        className="fixed rounded-2xl border shadow-2xl p-5 pointer-events-auto"
        style={{
          ...cardStyle,
          opacity: fading ? 0 : 1,
          transition: "top 250ms cubic-bezier(0.4,0,0.2,1), left 250ms cubic-bezier(0.4,0,0.2,1), opacity 180ms ease-out",
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
