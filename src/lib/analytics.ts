// ─────────────────────────────────────────────────────────────────────────────
// analytics.ts — thin wrapper over PostHog for product telemetry.
//
// Why the wrapper instead of using posthog-js directly:
//   - Every call is a no-op unless NEXT_PUBLIC_POSTHOG_KEY is set, so a repo
//     without a PostHog account still ships identical behaviour.
//   - We lazy-import the SDK so the bundle cost is zero until the first
//     analytics.track() is made.
//   - A single `track("event_name", { props })` pattern means swapping to
//     Mixpanel / Segment / Snowplow later is one file change, not grep-and-
//     replace across the codebase.
//
// Call from anywhere:
//   import { track, identify, initAnalytics } from "@/lib/analytics";
//   track("search_submitted", { mode: "deep", paper_count: 42 });
//   identify(user.id, { email: user.email });
// ─────────────────────────────────────────────────────────────────────────────

type PostHogLike = typeof import("posthog-js").default;

let _ph: PostHogLike | null = null;
let _initialized = false;
let _disabled = false;

function _env(name: string): string {
  return (typeof process !== "undefined" && process.env ? process.env[name] : "") || "";
}

function _key(): string {
  return _env("NEXT_PUBLIC_POSTHOG_KEY");
}

function _host(): string {
  return _env("NEXT_PUBLIC_POSTHOG_HOST") || "https://us.i.posthog.com";
}

async function _load(): Promise<PostHogLike | null> {
  if (_ph) return _ph;
  try {
    const mod = await import("posthog-js");
    _ph = mod.default;
    return _ph;
  } catch {
    return null;
  }
}

/** Initialise PostHog on the client. No-op server-side and without a key. */
export async function initAnalytics(): Promise<void> {
  if (_initialized || _disabled) return;
  if (typeof window === "undefined") return;
  const key = _key();
  if (!key) { _disabled = true; return; }
  const ph = await _load();
  if (!ph) { _disabled = true; return; }
  ph.init(key, {
    api_host:            _host(),
    capture_pageview:    true,
    capture_pageleave:   true,
    autocapture:         true,
    persistence:         "localStorage+cookie",
    // Never send user content without opt-in; default tracking is aggregated.
    mask_all_text:       false,
    disable_session_recording: true,
  });
  _initialized = true;
}

/** Track a product event. Named in snake_case to match PostHog conventions. */
export async function track(event: string, props?: Record<string, unknown>): Promise<void> {
  if (_disabled || !_key()) return;
  const ph = await _load();
  if (!ph) return;
  try { ph.capture(event, props); } catch { /* never break user flow */ }
}

/** Associate the current session with a user id. */
export async function identify(userId: string, traits?: Record<string, unknown>): Promise<void> {
  if (_disabled || !_key() || !userId) return;
  const ph = await _load();
  if (!ph) return;
  try { ph.identify(userId, traits); } catch { /* ignore */ }
}

/** Clear the identity when the user signs out. */
export async function resetAnalytics(): Promise<void> {
  if (_disabled || !_key()) return;
  const ph = await _load();
  if (!ph) return;
  try { ph.reset(); } catch { /* ignore */ }
}
