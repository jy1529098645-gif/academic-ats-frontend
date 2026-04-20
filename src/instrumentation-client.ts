// ─────────────────────────────────────────────────────────────────────────────
// Client-side instrumentation. Next.js executes this once per page load,
// before the React tree mounts, so Sentry catches early-boot errors too.
// No-op when the DSN isn't configured.
// ─────────────────────────────────────────────────────────────────────────────

import { initSentryBrowser } from "./lib/sentry";

void initSentryBrowser();
