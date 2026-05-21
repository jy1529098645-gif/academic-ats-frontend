"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EChartsHost — shared lifecycle wrapper for every echarts-rendered chart in
// the app (chart-builder, trend-chart's three built-in charts, keyword-cloud's
// word cloud, and any future custom-chart preset).
//
// Why one component instead of letting each mod hand-roll the echarts dance:
//   · Identical init / dispose / resize / setOption sequence everywhere.
//     Bugs in one copy (zero-size init, missing ResizeObserver disconnect,
//     stale series after notMerge=false swap) tend to land in only ONE
//     of the copies and the others silently look fine.
//   · echarts is browser-only — it touches `window` and `document` at
//     init time. Centralising the SSR guard means a mod author can't
//     accidentally skip it.
//   · The same `notMerge: true` semantic is correct for every dynamic
//     chart in this app (data shape changes when the user swaps preset
//     types, year ranges, etc.). Surface this as the default.
//
// v2 — fixes hit-test misalignment + actual canvas scaling:
//
//   The previous version passed explicit `{ width, height }` to
//   `echarts.init(host, undefined, opts)` and called `inst.resize()`
//   (no args) from the ResizeObserver. That combination produced two
//   visible bugs in production:
//
//     1. Click / hover coordinates were offset (~"slightly left") when
//        the chart's internal pixel size didn't match its CSS-displayed
//        size — a DPR / scaling mismatch the browser papered over by
//        stretching the canvas image, but the click hit-tester does its
//        math in canvas-internal coords.
//
//     2. The wrapper frame grew with the zone (aspect-ratio / flex did
//        their job) but the chart canvas itself stayed at the size it
//        had at init, just CSS-scaled. So tooltips, clickable bars, and
//        labels were all rendered at the OLD size and stretched.
//
//   v2 fixes both:
//     · `echarts.init(host)` with NO explicit dimensions — echarts
//       reads the host's bounding box directly. If that's 0×0 (still
//       laying out), we defer until the ResizeObserver fires.
//     · `inst.resize({ width, height })` with EXPLICIT dimensions from
//       the ResizeObserver's contentRect — guarantees the internal
//       canvas state matches the visible DOM size every time.
//     · `useDirtyRect: true` + `pixelRatio: devicePixelRatio` for
//       crisp rendering on high-DPI displays without paint thrash.
//
// Contract:
//   · Caller owns the option object. Pass it as a prop; rebuild it in a
//     useMemo on the data inputs you care about. The host calls
//     setOption(opt, { notMerge: true }) whenever the prop reference
//     changes.
//   · Caller may pass an optional `onClick(params)` to handle datum
//     clicks. We attach it once on init and re-bind via a ref-mirror
//     so renders don't churn the listener registration.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useImperativeHandle, forwardRef } from "react";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsType, ECElementEvent } from "echarts/core";

// Register the SVG renderer globally so every echarts.init in the app
// uses it. Idempotent — calling use() with the same module twice is a
// no-op. SVG was chosen over canvas to fix a hit-test misalignment
// reported under the workspace's html { zoom: 0.74 } rule (see
// globals.css:21–28). Under CSS zoom, canvas-internal pixel
// coordinates diverge from the pointer-event coordinates the browser
// reports — the chart RENDERED correctly but tooltips and click
// targets sat a few pixels off the cursor. SVG bypasses this entirely
// because the browser hit-tests SVG elements in DOM space, which
// already accounts for CSS zoom and any ancestor transforms.
echarts.use([SVGRenderer]);

export type EChartsHostProps = {
  /** echarts option object. The host calls setOption with notMerge:true
   *  whenever this reference changes — pass a useMemo'd value so the
   *  setOption fires on intent (data changed) rather than on every
   *  render. */
  option:    Record<string, unknown>;
  /** Optional click handler — receives the echarts ECElementEvent.
   *  Attached once at init; uses a ref-mirror so prop changes don't
   *  reregister. */
  onClick?:  (params: ECElementEvent) => void;
  /** ClassName / style passed through to the host div. The chart's
   *  canvas is sized to fill this element, so give it a definite
   *  height (`h-full` inside a flex parent, `h-[14rem]`, etc.). */
  className?: string;
  style?:     React.CSSProperties;
  /** Forces re-init when this string changes — useful if the caller
   *  knows it has an incompatible option (different chart family) and
   *  wants a clean canvas rather than relying on notMerge:true. Most
   *  callers can ignore this. */
  resetKey?:  string;
};

/** Imperative handle exposed via React.forwardRef. Lets a caller reach
 *  in for `getDataURL()` (chart → image insert flow) and `dispose()`
 *  without having to re-implement the lifecycle.
 *
 *  toImageDataURL is async because the host renders with the SVG
 *  engine (the only renderer registered globally — see
 *  `echarts.use([SVGRenderer])` below; it's intentional, canvas
 *  hit-tests drift under the workspace's html { zoom: 0.74 } rule).
 *  Calling `inst.getDataURL({ type: "png" })` on an SVG-rendered
 *  instance returns an SVG dataURL with `image/svg+xml` MIME — saving
 *  that with a `.png` extension produces a file the OS image viewer
 *  refuses to open. We rasterise the SVG to a real PNG client-side
 *  via `<img>` → `<canvas>` so the download bytes are actually PNG. */
export type EChartsHostHandle = {
  getInstance: () => EChartsType | null;
  /** Render the chart to a base64 PNG. Used by:
   *    · the "insert chart as image" flow in the Custom Data feature
   *    · the per-chart hover Download chip in TrendChart
   *  Resolves with `null` if the chart isn't initialised yet OR the
   *  rasterisation step fails. */
  toImageDataURL: (opts?: { backgroundColor?: string; pixelRatio?: number }) => Promise<string | null>;
};

/** Decode the SVG body out of an `inst.getDataURL({ type: "svg" })`
 *  result. ECharts URI-encodes the SVG payload by default; some
 *  versions base64-encode it. Try both. */
function decodeSvgDataURL(svgDataURL: string): string | null {
  const m = /^data:image\/svg\+xml(?:;[^,]*)?,(.*)$/i.exec(svgDataURL);
  if (!m) return null;
  const payload = m[1];
  try {
    return svgDataURL.toLowerCase().includes(";base64,")
      ? atob(payload)
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/** Pull width / height attributes off the <svg> root so the canvas can
 *  size itself correctly. ECharts always emits explicit width/height,
 *  so this should hit the first match path. Fallback to the chart-card
 *  preset (460×240) if the regex misses, which keeps the export usable
 *  rather than 0×0. */
function readSvgIntrinsicSize(svgText: string): { w: number; h: number } {
  const wm = svgText.match(/<svg[^>]*\swidth="([0-9.]+)/i);
  const hm = svgText.match(/<svg[^>]*\sheight="([0-9.]+)/i);
  const w = wm ? parseFloat(wm[1])  : 460;
  const h = hm ? parseFloat(hm[1]) : 240;
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

/** Rasterise an SVG dataURL into a PNG dataURL via `<img>` + `<canvas>`.
 *  Resolves null on error so callers can fail closed without throwing.
 *  pixelRatio caps at 2 to keep the canvas memory bounded; even on
 *  high-DPR displays a 460×240 chart at 2× is only ~440 KB. */
function rasterizeSvgToPng(
  svgDataURL: string,
  pixelRatio: number,
  backgroundColor: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") { resolve(null); return; }
    const svgText = decodeSvgDataURL(svgDataURL);
    if (!svgText) { resolve(null); return; }
    const { w, h } = readSvgIntrinsicSize(svgText);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width  = Math.max(1, Math.round(w * pixelRatio));
        canvas.height = Math.max(1, Math.round(h * pixelRatio));
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }
        if (backgroundColor) {
          ctx.fillStyle = backgroundColor;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    // data: URLs are same-origin, so no crossOrigin / CORS dance needed.
    img.src = svgDataURL;
  });
}

/** Shared host. Thin wrapper around `echarts.init` that handles every
 *  lifecycle concern the mods used to copy-paste. */
export const EChartsHost = forwardRef<EChartsHostHandle, EChartsHostProps>(function EChartsHost({
  option,
  onClick,
  className,
  style,
  resetKey,
}, ref) {
  const hostRef     = useRef<HTMLDivElement | null>(null);
  const instRef     = useRef<EChartsType | null>(null);
  // Ref-mirror for onClick — captures the latest handler without
  // forcing the init effect to re-run on every parent render.
  const onClickRef  = useRef<typeof onClick>(onClick);
  useEffect(() => { onClickRef.current = onClick; }, [onClick]);

  // Hold the latest option in a ref so the lazy first-resize path can
  // call setOption synchronously when the chart finally has a real
  // size, without waiting for a separate effect tick.
  const optionRef = useRef(option);
  useEffect(() => { optionRef.current = option; }, [option]);

  // Imperative API for callers that need to reach in (e.g. exporting
  // the chart as an image for the "insert into editor" flow + the
  // per-chart download chip).
  useImperativeHandle(ref, () => ({
    getInstance: () => instRef.current,
    toImageDataURL: async (opts) => {
      const inst = instRef.current;
      if (!inst) return null;
      const backgroundColor = opts?.backgroundColor ?? "#0f1115";
      const pixelRatio = opts?.pixelRatio ?? (typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1);
      // Step 1 — pull the SVG out of the ECharts SVG renderer. We ask
      // for { type: "svg" } explicitly because asking for "png" on an
      // SVG-rendered instance silently returns SVG bytes anyway, just
      // mis-typed.
      let svgDataURL: string;
      try {
        svgDataURL = inst.getDataURL({
          type:            "svg",
          backgroundColor,
        });
      } catch {
        return null;
      }
      if (!svgDataURL) return null;
      // Step 2 — rasterise that SVG into a real PNG dataURL via a
      // hidden canvas. `await` is mandatory; the <img> onload happens
      // on a microtask so a sync return would race the load.
      return await rasterizeSvgToPng(svgDataURL, pixelRatio, backgroundColor);
    },
  }), []);

  // ── Init / dispose ─────────────────────────────────────────────────
  // useLayoutEffect (not useEffect): the host element is in the DOM
  // synchronously after the first commit, so init runs before paint —
  // this avoids the flash-of-empty-canvas you get when init is deferred
  // to the next tick.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof window === "undefined") return;

    // NO explicit width/height here. echarts reads the host element's
    // bounding box directly, which is the only way to keep the canvas's
    // INTERNAL pixel size in sync with its CSS display size. Passing
    // explicit dims fossilises the canvas at init-time geometry, which
    // is the root cause of the "click is slightly off-target" bug.
    //
    // pixelRatio matches the device DPR so retina displays render at
    // physical resolution without the browser having to upscale a
    // low-DPI bitmap — additionally fixes the hit-test offset because
    // canvas-internal coords now sit on whole-pixel boundaries.
    // SVG renderer (registered above) — DPR no longer matters because
    // SVG renders at vector resolution. We drop the canvas-only
    // `useDirtyRect` flag since SVG has no dirty-rect optimization.
    const inst = echarts.init(host, undefined, {
      renderer: "svg",
    });
    instRef.current = inst;

    // ── CSS-zoom hit-test compensation ────────────────────────────────
    // The workspace scales itself via `html { zoom: X }` (see
    // globals.css media-query block). Under that rule both
    // `getBoundingClientRect()` AND `event.clientX/Y` come back in
    // ZOOMED coords (verified empirically: an element declared at
    // `left: 200px` reports `rect.left = 200 * zoom`). zrender
    // computes `e.zrX = event.clientX - rect.left`, so `zrX` is in
    // ZOOMED units — but the chart's internal coord system is sized
    // by `inst.resize(...)` which we feed LOGICAL px. The mismatch
    // factor is exactly `zoom`, which is why hit-tests land
    // ~(1 - zoom) of the chart width to the LEFT of the cursor.
    //
    // Fix: wrap `handler.dispatch` so every normalised event has
    // its zrX/zrY rescaled by `1/zoom` before the chart's core runs
    // hit-test. The zoom factor is re-read on every event so a
    // mid-session window resize that hits a different breakpoint
    // (e.g. drag-resize across 1920 → 1680) self-corrects without
    // re-mounting the chart.
    {
      const handler = (inst.getZr() as unknown as { handler?: { dispatch?: (...args: unknown[]) => unknown } }).handler;
      const origDispatch = handler?.dispatch?.bind(handler);
      if (handler && origDispatch) {
        handler.dispatch = function(...args: unknown[]): unknown {
          const ev = args[1] as { zrX?: number; zrY?: number } | undefined;
          if (ev && typeof ev.zrX === "number" && typeof ev.zrY === "number") {
            const z = parseFloat(
              (typeof document !== "undefined"
                ? getComputedStyle(document.documentElement).zoom
                : "1") || "1"
            );
            if (Number.isFinite(z) && z > 0 && z !== 1) {
              ev.zrX = ev.zrX / z;
              ev.zrY = ev.zrY / z;
            }
          }
          return origDispatch(...args);
        };
      }
    }

    // Click forwarding via ref-mirror so onClick prop updates don't
    // re-register the listener.
    inst.on("click", (params: ECElementEvent) => {
      onClickRef.current?.(params);
    });

    // ResizeObserver — this is what KEEPS the canvas's pixel size in
    // sync with the CSS box as the user drags the zone divider, the
    // window resizes, an ancestor's flex layout reflows, etc. We pass
    // EXPLICIT width/height to inst.resize() so echarts doesn't fall
    // back to its internal cached dimensions when getBoundingClientRect
    // hasn't propagated yet (which was the v1 bug).
    let firstSizeApplied = false;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const cr = e.contentRect;
      const w = Math.max(0, Math.round(cr.width));
      const h = Math.max(0, Math.round(cr.height));
      if (w === 0 || h === 0) return;
      inst.resize({ width: w, height: h });
      // First-paint path: if init happened against a 0×0 host, we
      // skipped the initial setOption — apply it now that we have a
      // real size, otherwise the chart paints empty.
      if (!firstSizeApplied) {
        firstSizeApplied = true;
        inst.setOption(optionRef.current, { notMerge: true });
      }
    });
    ro.observe(host);

    // If the host already has dimensions at init time (the common case
    // when the parent has settled layout), apply the option immediately
    // so we don't wait for the next ResizeObserver tick.
    //
    // Use `offsetWidth/Height` rather than `getBoundingClientRect()`:
    // under the workspace's `html { zoom: X }` rule, getBoundingClientRect
    // returns POST-zoom dimensions (e.g. 135 for a 300 px declared
    // element under zoom 0.45). Passing those to `inst.resize` would
    // size the SVG at the zoomed value, then html-zoom would shrink
    // it AGAIN, producing a chart at zoom² of the container — half-
    // sized during the brief window before the ResizeObserver fires
    // with the correct (logical) `contentRect.width`. `offsetWidth`
    // returns the LOGICAL value consistently across browsers.
    {
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      if (w > 0 && h > 0) {
        inst.resize({ width: w, height: h });
        inst.setOption(optionRef.current, { notMerge: true });
        firstSizeApplied = true;
      }
    }

    return () => {
      ro.disconnect();
      inst.dispose();
      instRef.current = null;
    };
    // resetKey forces a teardown+rebuild — useful when the option's
    // shape changes incompatibly (e.g. heatmap → pie). The default
    // notMerge:true in setOption already handles most cases without
    // a full reset.
  }, [resetKey]);

  // ── Option update ─────────────────────────────────────────────────
  // Fires whenever the option reference changes. notMerge:true ensures
  // stale series (visualMap from a previous heatmap, polar from a
  // previous radar) don't bleed through.
  //
  // Also re-applies dimensions: echarts won't auto-resize to the
  // current host bounds on setOption, so if the host's size changed
  // between the previous setOption and this one (e.g. ResizeObserver
  // fired during a transition), explicitly syncing keeps the canvas
  // pixel-perfect against the CSS box.
  useEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    const host = hostRef.current;
    if (host) {
      // Same offsetWidth/Height story as the init path — under CSS
      // zoom, getBoundingClientRect returns post-zoom values which
      // double-shrink the SVG. offsetWidth stays in logical CSS px.
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      if (w > 0 && h > 0) {
        inst.resize({ width: w, height: h });
      }
    }
    inst.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={hostRef} className={className} style={style} />;
});
