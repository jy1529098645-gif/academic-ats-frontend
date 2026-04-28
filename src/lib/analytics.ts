// ─────────────────────────────────────────────────────────────────────────────
// analytics.ts — funnel-event surface, currently no-op.
//
// History: previously a thin wrapper over PostHog; the PostHog SaaS was
// dropped 2026-04-29 to reduce the number of dashboards a solo
// maintainer has to babysit. The 12 call sites scattered through
// page.tsx, MobileApp.tsx, and PaperReviewPanel.tsx were left
// untouched — they still call `track("search_submitted", { ... })` —
// but the implementation is now a no-op.
//
// Why keep the interface alive instead of deleting the calls:
//   - The events themselves are useful product telemetry.
//   - When we later wire them to a Supabase `events` table (or any
//     other sink), only THIS file changes; we don't have to re-find
//     and re-add 12 call sites.
//   - posthog-js is removed from package.json so the no-op carries
//     zero bundle weight.
//
// To reactivate:
//   1. Build a backend endpoint that writes (user_id, event, props,
//      created_at) to a Supabase events table.
//   2. Replace the body of `track()` below with a fire-and-forget
//      `fetch(POST /api/events, { body: JSON.stringify({...}) })`.
//   3. (optional) restore identify() to set a session-cookie or
//      similar so anonymous events can be later joined to a user_id.
// ─────────────────────────────────────────────────────────────────────────────

/** No-op. Preserved as an init point so callers don't have to be
 *  edited when we wire a real sink later. */
export async function initAnalytics(): Promise<void> {
  return;
}

/** Track a product event. Currently no-op (see file header). The
 *  signature stays compatible with the 12 existing call sites
 *  (`track("search_submitted", { mode, paper_count_target, ... })`)
 *  so flipping this back on is a one-file change.
 *
 *  Args are intentionally typed loosely — exact prop shapes vary
 *  between events and we don't want to enforce a schema until the
 *  events table is real. */
export async function track(_event: string, _props?: Record<string, unknown>): Promise<void> {
  return;
}

/** No-op. */
export async function identify(_userId: string, _traits?: Record<string, unknown>): Promise<void> {
  return;
}

/** No-op. */
export async function resetAnalytics(): Promise<void> {
  return;
}
