// ─────────────────────────────────────────────────────────────────────────────
// MaintenanceGate — full-screen overlay shown to every user when the backend's
// singleton maintenance flag is ON.
//
// Lifecycle:
//   - Client component (uses polling + state), mounted once in the root
//     layout so every page is gated uniformly. Paths that should stay
//     reachable even during maintenance (/admin, /login) opt out via the
//     BYPASS_PATH_PREFIXES list below — admins need /admin to toggle the
//     flag OFF, users need /login to authenticate before being blocked.
//   - Polls GET /api/maintenance every POLL_MS. The endpoint is public
//     (no JWT required) and fail-open: if Supabase is down, it returns
//     enabled=false so we don't lock users out of a healthy product due
//     to an unrelated infra blip.
//   - When `enabled` is true, renders a full-viewport overlay that covers
//     all app content (absolute positioning + high z-index). When false,
//     renders children unchanged.
//   - If `eta_at` is set, a live countdown ticks every 1s until it hits
//     zero, at which point the countdown swaps to "finishing up…" so the
//     user doesn't see "-00:00:47" drift while we finalise.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { buildApiUrl } from "@/lib/api";

// Poll every 20s — enough that a toggle shows up quickly but not so often
// that we DoS the backend or waste battery on idle tabs. The next tick also
// fires on window `focus` so returning to a tab after a long pause gets a
// fresh state without waiting out the interval.
const POLL_MS = 20_000;

// Paths that should NOT be gated. Admins need /admin to unblock, users
// need /login to sign in, and the API routes obviously mustn't be
// shadowed. Anything else (root /, /app, /search, etc.) is gated.
const BYPASS_PATH_PREFIXES = ["/admin", "/login", "/api"];

type MaintenanceState = {
  enabled: boolean;
  message: string;
  eta_at: string | null;
};

export default function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  // Opt-out rules evaluated BEFORE any network work — no point polling
  // /api/maintenance when the admin is specifically trying to reach /admin.
  const bypass = BYPASS_PATH_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));

  const [state, setState] = useState<MaintenanceState>({ enabled: false, message: "", eta_at: null });
  const [hydrated, setHydrated] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (bypass) { setHydrated(true); return; }

    let active = true;

    const fetchState = async () => {
      try {
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const res = await fetch(buildApiUrl("/api/maintenance"), {
          method: "GET",
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json() as Partial<MaintenanceState>;
        if (!active) return;
        setState({
          enabled: Boolean(data.enabled),
          message: String(data.message || ""),
          eta_at:  data.eta_at ? String(data.eta_at) : null,
        });
      } catch {
        // Fail-open: any transport error leaves the previous state in
        // place (first load → enabled=false from useState default). We
        // don't want a flaky network to black out the app.
      } finally {
        if (active) setHydrated(true);
      }
    };

    fetchState();
    const interval = window.setInterval(fetchState, POLL_MS);
    const onFocus = () => fetchState();
    window.addEventListener("focus", onFocus);

    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      abortRef.current?.abort();
    };
  }, [bypass]);

  // Render children directly on bypass routes or while still hydrating
  // (avoid a flash of the overlay on first paint before we know the state).
  if (bypass || !hydrated) return <>{children}</>;
  if (!state.enabled) return <>{children}</>;

  return <MaintenanceOverlay message={state.message} etaAt={state.eta_at} />;
}

// ── Full-screen overlay ─────────────────────────────────────────────────────

function MaintenanceOverlay({ message, etaAt }: { message: string; etaAt: string | null }) {
  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-slate-950 text-slate-100">
      {/* Subtle animated backdrop — same style as the existing splash screen
          so the overlay feels native instead of a generic "site is down" page. */}
      <div className="pointer-events-none absolute inset-0 opacity-30">
        <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-purple-500/20 blur-3xl" />
      </div>

      <div className="relative max-w-md mx-auto px-8 py-10 text-center">
        {/* Cat mascot emoji instead of a generic gear. Keeps the brand
            voice — users have been trained by the rest of the product to
            see the cat as a friendly surface. */}
        <div className="text-6xl mb-4 select-none" aria-hidden>🐱</div>

        <h1 className="text-2xl font-bold mb-2 tracking-tight">
          We&apos;re fixing a few things
        </h1>

        <p className="text-sm text-slate-300 leading-relaxed mb-6 whitespace-pre-line">
          {message || "AcademiCats is undergoing scheduled maintenance. We'll be back shortly."}
        </p>

        {etaAt && <CountdownPill etaAt={etaAt} />}

        <p className="mt-6 text-[11px] text-slate-500">
          Thank you for your patience. This page refreshes automatically every 20 seconds —
          the app will come back on its own once service resumes.
        </p>
      </div>
    </div>
  );
}

// ── Countdown pill (live, ticks every second) ──────────────────────────────

function CountdownPill({ etaAt }: { etaAt: string }) {
  const etaMs = useMemo(() => {
    const t = Date.parse(etaAt);
    return Number.isFinite(t) ? t : 0;
  }, [etaAt]);

  // Tick state — just a monotonic counter that forces re-render each second.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(x => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (etaMs <= 0) return null;

  const remainingMs = etaMs - Date.now();
  if (remainingMs <= 0) {
    // ETA has passed — the admin may be finishing a slow step. Avoid
    // showing "-00:00:47" (confusing). Swap to a neutral "finishing up…"
    // state and keep ticking; the parent poll will flip enabled=false
    // the moment the admin clicks "Go live now".
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        Finishing up… back any moment.
      </div>
    );
  }

  const totalSec = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins  = Math.floor((totalSec % 3600) / 60);
  const secs  = totalSec % 60;

  const pad = (n: number) => n.toString().padStart(2, "0");
  const label = hours > 0
    ? `${pad(hours)}:${pad(mins)}:${pad(secs)}`
    : `${pad(mins)}:${pad(secs)}`;

  return (
    <div className="inline-flex flex-col items-center gap-1">
      <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
        Estimated back online in
      </span>
      <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/40 bg-blue-500/10 px-5 py-2 text-xl font-bold text-blue-300 tabular-nums tracking-wider">
        <span className="inline-block h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
        {label}
      </div>
    </div>
  );
}
