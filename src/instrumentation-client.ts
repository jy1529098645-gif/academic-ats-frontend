// ─────────────────────────────────────────────────────────────────────────────
// Client-side instrumentation. Next.js executes this once per page load,
// before the React tree mounts, so Sentry catches early-boot errors too
// and PostHog records the pageview. Both calls are no-ops when their
// respective env vars (NEXT_PUBLIC_SENTRY_DSN / NEXT_PUBLIC_POSTHOG_KEY)
// aren't configured.
// ─────────────────────────────────────────────────────────────────────────────

import { initSentryBrowser } from "./lib/sentry";
import { initAnalytics } from "./lib/analytics";

void initSentryBrowser();
void initAnalytics();
