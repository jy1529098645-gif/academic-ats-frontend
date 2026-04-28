// ─────────────────────────────────────────────────────────────────────────────
// Client-side instrumentation. Next.js executes this once per page load,
// before the React tree mounts, so Sentry catches early-boot errors too.
// Sentry init is a no-op when NEXT_PUBLIC_SENTRY_DSN isn't set.
// `initAnalytics()` is currently a no-op stub left in for forward-
// compat with a future Supabase events sink (see lib/analytics.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { initSentryBrowser } from "./lib/sentry";
import { initAnalytics } from "./lib/analytics";

void initSentryBrowser();
void initAnalytics();
