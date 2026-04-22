// ─────────────────────────────────────────────────────────────────────────────
// ErrorBoundary — scoped React Error Boundary that catches rendering errors
// inside a single region of the UI (Search / Synthesis / Lab) instead of
// letting them propagate to /app/error.tsx (the PAGE-level boundary, which
// blanks the entire app). The goal: if the Lab Editor crashes, the user's
// search results panel + feedback button + settings modal keep working.
//
// Usage:
//   <ErrorBoundary label="Synthesis Lab">
//     <SynthesisLab ... />
//   </ErrorBoundary>
//
// When caught, we render a compact apology panel with:
//   - The region name (so the user + dev can see WHICH subtree crashed)
//   - A short error-type string (never the full message — may contain PII)
//   - A "Reload this panel" button that resets the boundary's error state
//     (re-mounts the children). This usually fixes transient React errors
//     (stale refs, race-conditioned state) without a full page refresh.
//   - A link to the feedback modal for reporting the crash.
//
// The error is also forwarded to window.onerror so the global error logger
// in page.tsx ships it to /api/errors for the /admin dashboard — that way
// a caught boundary error is STILL visible to ops, just not user-facing.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import React from "react";

interface Props {
  /** Human-readable region name shown in the fallback UI (e.g. "Search
   *  workspace", "Synthesis Lab"). Also forwarded to the global error
   *  logger as a tag so /admin can see WHICH boundary caught it. */
  label: string;
  /** Optional compact variant — smaller padding + single-line message.
   *  Use for boundary-wrapping inline components (a paper card, a chart)
   *  where the normal panel would look disproportionate. */
  compact?: boolean;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to the browser console + fire window.onerror so the existing
    // global handler in page.tsx ships it to /api/errors. We don't call
    // fetchWithAuth directly here to avoid import cycles / auth races
    // inside a render-error path.
    try {
      console.error(`[ErrorBoundary:${this.props.label}]`, error, info);
      window.dispatchEvent(new ErrorEvent("error", {
        message: `[Boundary:${this.props.label}] ${error.message}`,
        error,
        filename: "error-boundary",
      }));
    } catch { /* never let error-reporting itself throw */ }
  }

  reset = () => { this.setState({ error: null }); };

  render() {
    if (!this.state.error) return this.props.children;

    // Keep the fallback visually small + unalarming. Red is intentional
    // but subdued — a slamming red-on-white page would make a transient
    // glitch feel like a catastrophe.
    const errorType = this.state.error.name || "Error";
    if (this.props.compact) {
      return (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 flex items-center gap-2"
        >
          <span aria-hidden>⚠</span>
          <span className="flex-1 truncate">
            {this.props.label} failed to render ({errorType}).
          </span>
          <button
            type="button"
            onClick={this.reset}
            className="text-[11px] font-semibold underline underline-offset-2 hover:text-rose-200"
          >
            Retry
          </button>
        </div>
      );
    }

    return (
      <div
        role="alert"
        className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6 m-4"
      >
        <div className="flex items-start gap-3">
          <span aria-hidden className="text-2xl">⚠️</span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-rose-300 mb-1">
              {this.props.label} ran into a problem
            </h3>
            <p className="text-xs text-rose-200/80 leading-relaxed mb-3">
              This section crashed ({errorType}). The rest of the app keeps working —
              try the button below to re-mount just this panel. If the problem persists,
              use the feedback button (bottom-right) to let us know.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={this.reset}
                className="rounded-lg border border-rose-400/50 bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-rose-500/30 transition-colors"
              >
                ↻ Reload this panel
              </button>
              <button
                type="button"
                onClick={() => { try { window.location.reload(); } catch { /* ignore */ } }}
                className="text-[11px] text-rose-400 hover:text-rose-200 transition-colors"
              >
                Or: full page refresh
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
