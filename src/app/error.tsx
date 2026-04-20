"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Root error boundary for the App Router.
//
// Next.js renders this component when an unhandled exception bubbles up from
// anywhere inside `app/`. Without it, React 19 + Next 16 falls back to a blank
// white page which is the single worst failure mode for a paid product — the
// user has no idea whether their work is lost, whether to reload, or whether
// to contact support.
//
// Our version:
//   1. Shows a themed, calm error card that matches the app's palette.
//   2. Exposes a "Reload" button that calls the Next-provided `reset()` —
//      Next re-mounts the route segment, so transient errors recover without
//      losing the auth session or server cache.
//   3. Ships the error to Sentry when a DSN is configured. Works without
//      Sentry too — the import is guarded so missing SDK is not fatal.
//   4. Shows the digest/message only in dev; users see a generic apology.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";

type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function GlobalError({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    // Send the error to Sentry via our lazy-loaded wrapper — a missing DSN or
    // a project without the SDK installed is a silent no-op, never a crash.
    (async () => {
      try {
        const { captureSentryException } = await import("@/lib/sentry");
        await captureSentryException(error, { digest: error.digest, boundary: "app-root" });
      } catch {
        /* Sentry wrapper itself failed — nothing further to do. */
      }
      // Also echo to the browser console in case the user is a developer.
      // eslint-disable-next-line no-console
      console.error("[GlobalError]", error);
    })();
  }, [error]);

  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6 py-12 text-[var(--ats-fg-primary)]"
      style={{
        background: "var(--ats-bg-page, #040b19)",
      }}
    >
      <div className="ats-panel max-w-xl w-full rounded-2xl border border-[var(--ats-border-subtle)] bg-[var(--ats-bg-panel)] p-6 shadow-[var(--ats-shadow-panel)]">
        <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-[var(--ats-fg-accent)]">
          <span aria-hidden>●</span> Something went sideways
        </div>
        <h1 className="mt-2 text-2xl font-bold leading-tight">
          The page hit an unexpected error.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--ats-fg-secondary)]">
          Your work is safe — the error has been reported to our team. You can
          try again right now, or reload the whole page. If it keeps happening,
          email <a href="mailto:jy1529098645@gmail.com" className="underline decoration-[var(--ats-border-accent)]">jy1529098645@gmail.com</a> and include the reference below.
        </p>

        {error.digest && (
          <div className="mt-4 rounded-lg border border-[var(--ats-border-subtle)] bg-[var(--ats-bg-card)] px-3 py-2 text-xs font-mono text-[var(--ats-fg-muted)]">
            Reference: <span className="text-[var(--ats-fg-secondary)]">{error.digest}</span>
          </div>
        )}

        {isDev && error.message && (
          <details className="mt-4 rounded-lg border border-[var(--ats-border-subtle)] bg-[var(--ats-bg-card)] px-3 py-2 text-xs">
            <summary className="cursor-pointer font-semibold text-[var(--ats-fg-secondary)]">
              Developer details
            </summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-[var(--ats-fg-muted)]">
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ""}
            </pre>
          </details>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <button
            onClick={() => reset()}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 transition-colors"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.assign("/")}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--ats-border-subtle)] px-4 py-2 text-sm font-semibold text-[var(--ats-fg-secondary)] hover:border-[var(--ats-border-accent)] transition-colors"
          >
            Reload the home page
          </button>
        </div>
      </div>
    </div>
  );
}
