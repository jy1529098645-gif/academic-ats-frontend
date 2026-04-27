// ─────────────────────────────────────────────────────────────────────────────
// use-is-mobile — viewport detection that gates which UI tree the app renders.
//
// Returns:
//   `null`  — pre-hydration on the server / first client paint. Caller should
//             render nothing (or a tiny loading splash) until hydration
//             resolves the real value. This avoids the classic "flash desktop
//             then collapse to mobile" jank.
//   `true`  — viewport is below the mobile breakpoint (768 px). Render the
//             dedicated mobile UI tree.
//   `false` — viewport is at or above 768 px. Render the desktop UI tree.
//
// We track the boundary with a single `matchMedia` listener instead of a
// `resize` event hose — `matchMedia` only fires when the viewport actually
// crosses the breakpoint, not on every pixel of resize. Cheap.
//
// SSR safety: the initial state is `null`; the real value is computed
// AFTER the first useEffect, on the client, where `window` is real. That
// way the server-rendered HTML is identical for every client (no mobile/
// desktop divergence in the initial markup), and the client takes over
// after hydration with the correct branch.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

const MOBILE_MAX_WIDTH = 768; // px — matches Tailwind's `md` breakpoint

export function useIsMobile(): boolean | null {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH - 1}px)`);
    const apply = () => setIsMobile(mq.matches);
    apply();
    // matchMedia.addEventListener is the modern API; older Safari only has
    // .addListener. Both are supported via the same MediaQueryList object.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    } else {
      mq.addListener(apply);
      return () => mq.removeListener(apply);
    }
  }, []);

  return isMobile;
}
