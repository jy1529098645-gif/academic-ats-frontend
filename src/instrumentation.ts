// ─────────────────────────────────────────────────────────────────────────────
// Next.js instrumentation hook — fires once per runtime (nodejs / edge / etc.)
// at server startup. We use it to boot Sentry on the server so unhandled
// exceptions in Route Handlers and React Server Components get reported.
//
// The call is no-op unless NEXT_PUBLIC_SENTRY_DSN (or SENTRY_DSN) is set.
// See src/lib/sentry.ts for the gating logic.
// ─────────────────────────────────────────────────────────────────────────────

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    const { initSentryServer } = await import("./lib/sentry");
    await initSentryServer();
  }
}
