// ─────────────────────────────────────────────────────────────────────────────
// TermsOfServiceGate — full-screen modal that blocks app use until the user
// accepts the Terms of Service. Mounted once inside the main app shell
// (page.tsx), not in layout.tsx, because we only want it to gate AUTHED
// users — logged-out visitors + /login + /admin routes shouldn't see it.
//
// Flow:
//   1. On mount (if signed in), GET /api/me/tos-status.
//   2. If `up_to_date` is false → render the overlay; app behind it.
//   3. User ticks "I agree" checkbox; clicks "Accept and continue".
//   4. POST /api/me/accept-tos → 200 → overlay fades out.
//
// Re-acceptance: the backend maintains `CURRENT_TOS_VERSION`. When the
// TOS text materially changes (privacy policy update, new data-use
// disclosure), bump that constant server-side and every returning user
// sees this gate again. The stored `tos_version` on profiles lets us
// prove compliance for any given user at any given time.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useEffect, useState } from "react";
import { ScrollText, AlertCircle, Check, X } from "lucide-react";
import { buildApiUrl, fetchWithAuth } from "@/lib/api";
import { useThemeStore } from "@/lib/stores/theme-store";

type TOSStatus = {
  accepted_at:      string | null;
  accepted_version: string | null;
  current_version:  string;
  up_to_date:       boolean;
};

// Current TOS copy — kept in-file so git history tracks every wording
// change. Bump the CURRENT_TOS_VERSION constant on the backend (main.py)
// AND the version key here in lockstep when the text changes materially,
// so returning users are re-prompted + the stored tos_version marks
// exactly what they agreed to.
const TOS_VERSION = "1.0";

// Product version — shown in the TOS header + Section 1 so users know
// exactly which build of the product they're agreeing to. Kept in sync
// with the tagline in page.tsx; bump both when you bump the app.
const APP_VERSION = "v1.7.0-Alpha";

const TOS_SECTIONS: Array<{ title: string; body: string }> = [
  {
    title: "1. What AcademiCats is",
    body:
      `AcademiCats is an AI-assisted academic research assistant (currently ${APP_VERSION}). It helps you discover relevant papers from open-access databases (Semantic Scholar, OpenAlex, Crossref, arXiv, PubMed, and others), synthesises those papers into research briefs, and offers Evidence Chain (per-claim source tracing) plus PDF translation tools for individual papers. The service is provided as-is during the Alpha testing period; features and limits may change without notice.`,
  },
  {
    title: "2. What data we collect and why",
    body:
      "To operate the service we collect: (a) your account email and sign-in metadata provided by our auth provider (Supabase Auth); (b) the queries you submit and the results that are returned, so we can show you your search history and improve the quality of search/ranking/brief generation; (c) anonymised usage counts (per feature, per day) to enforce fair-use quotas and to understand which features matter most; (d) anonymised error traces when something breaks, so we can fix bugs. We never sell this data, we do not share it with third parties for marketing, and we retain only what is necessary to run the service.",
  },
  {
    title: "3. How your queries and papers are processed",
    body:
      "Your queries are sent to large-language-model providers (currently OpenAI) for interpretation and for generating research briefs. The third-party provider processes your query text under its own privacy policy. We do not send your email or other identifying account information to the LLM provider alongside your query. Paper metadata returned by the academic databases is cached briefly to improve performance; we don't store full paper PDFs on our servers long-term.",
  },
  {
    title: "4. Your rights",
    body:
      "You can export every piece of data we hold about you (Article 15, GDPR right of access) or permanently delete your account and all associated records (Article 17, right to erasure) from the user menu at any time. Both actions are immediate and irreversible. If you have questions about your data, email the project team — contact is listed in the in-app announcement banner.",
  },
  {
    title: "5. Alpha caveats",
    body:
      "During Alpha testing, the service may be temporarily unavailable for maintenance, the feature set may change, and stored data may be migrated or reset if we hit a major architectural issue. We will give advance notice in the announcement banner for planned interruptions. Your usage quota, tier, and bonus balances are best-effort during Alpha and may be reset if we discover a bug in the quota system.",
  },
  {
    title: "6. Acceptable use",
    body:
      "You agree not to use AcademiCats to generate defamatory or harmful content, to scrape data at a rate that disrupts service for other users, or to circumvent the rate limits applied to your account tier. Accounts that violate these rules may be suspended without notice; suspension reasons are communicated on the next sign-in attempt.",
  },
  {
    title: "7. Changes to these terms",
    body:
      "We may update these terms; when we do, the version number below changes and you will be asked to accept again on your next session. Your previous acceptance remains on record for compliance purposes. The exact timestamp + version of each acceptance is stored on your profile row so we can always show you which version was in effect for any specific action.",
  },
];


export default function TermsOfServiceGate({ children }: { children: React.ReactNode }) {
  // `null` = still loading (don't render the overlay yet; avoids a flash
  // of the modal on every page load for users who've already accepted).
  const [status, setStatus]   = useState<TOSStatus | null>(null);
  const [agreed, setAgreed]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]     = useState<string>("");

  // Read the user's current theme so we can stamp data-theme / data-tone
  // on the modal's root element. Without this the fixed-positioned
  // overlay is a SIBLING of <main> (<main> carries the theme attrs),
  // and every --ats-* token inside the modal resolves to the :root
  // (dark) default — users on a day theme saw a dark modal on their
  // bright background. Reading from Zustand + painting the attrs on
  // the overlay means the modal picks up whatever theme is active,
  // including Morning Mint / Warm Paper / Daylight Blue / Night Prism
  // etc., without any coupling to the parent DOM hierarchy.
  const themeMode    = useThemeStore(s => s.mode);
  const dayThemeId   = useThemeStore(s => s.dayThemeId);
  const nightThemeId = useThemeStore(s => s.nightThemeId);
  const activeThemeId = themeMode === "day" ? dayThemeId : nightThemeId;

  // On mount, fetch the status. Uses fetchWithAuth so if the user isn't
  // signed in, the call 401s and we treat it as "up_to_date: true"
  // (no one to gate). The gate only exists for authenticated users.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(buildApiUrl("/api/me/tos-status"));
        if (!res.ok) {
          // 401 = not signed in → no gate needed; any other error → fail-open
          if (!cancelled) setStatus({ accepted_at: null, accepted_version: null, current_version: TOS_VERSION, up_to_date: true });
          return;
        }
        const data = await res.json() as TOSStatus;
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus({ accepted_at: null, accepted_version: null, current_version: TOS_VERSION, up_to_date: true });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleAccept = async () => {
    if (!agreed || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetchWithAuth(buildApiUrl("/api/me/accept-tos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`Accept failed: HTTP ${res.status}`);
      const data = await res.json();
      setStatus({
        accepted_at:      data.accepted_at,
        accepted_version: data.accepted_version,
        current_version:  data.current_version,
        up_to_date:       true,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Not signed in, or already up-to-date → just render children.
  if (!status || status.up_to_date) return <>{children}</>;

  const isReAcceptance = !!status.accepted_version && status.accepted_version !== status.current_version;

  return (
    <>
      {children}
      <div
        // Paint theme attrs directly on the overlay so the nested
        // --ats-* tokens resolve to the user's active theme. See the
        // themeMode / activeThemeId declarations above for why this
        // matters (overlay is a sibling, not a child, of <main>).
        data-theme={activeThemeId}
        data-tone={themeMode}
        className="fixed inset-0 z-[9500] flex items-center justify-center p-4 backdrop-blur-sm"
        style={{ backgroundColor: "rgba(0, 0, 0, 0.55)" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tos-title"
      >
        {/* Modal card — every surface/text/border uses --ats-* tokens so
            the TOS matches the user's active theme (Morning Mint /
            Warm Paper / Daylight Blue / Night etc). Previous version
            was hardcoded dark-slate which clashed with day themes. */}
        <div
          className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border shadow-2xl"
          style={{
            backgroundColor: "var(--ats-bg-panel)",
            borderColor:     "var(--ats-border-subtle)",
          }}
        >
          {/* Header */}
          <div
            className="px-6 py-4 border-b"
            style={{ borderColor: "var(--ats-border-subtle)" }}
          >
            <div className="flex items-center gap-2 mb-1">
              {/* Lucide ScrollText icon in accent colour, replacing the
                  📜 emoji which rendered in multi-colour and clashed
                  with every theme palette. */}
              <ScrollText size={18} style={{ color: "var(--ats-fg-accent)" }} />
              <h2
                id="tos-title"
                className="text-lg font-bold"
                style={{ color: "var(--ats-fg-primary)" }}
              >
                {isReAcceptance ? "Terms of Service updated" : "Welcome — a quick agreement"}
              </h2>
            </div>
            <p className="text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>
              {isReAcceptance
                ? `We've updated our terms since you last accepted (v${status.accepted_version} → v${status.current_version}). Please review the changes and agree to continue using AcademiCats.`
                : `Before you start, please read and agree to our Terms of Service. Version ${status.current_version} · takes about 90 seconds.`}
            </p>
          </div>

          {/* Scrollable body — uses .hairline-scrollbar (3px wide, theme-
              coloured thumb via --ats-scroll-thumb) so the scrollbar
              follows Morning Mint / Warm Paper / Night / etc without
              code changes. Without this class the browser falls back to
              its default chunky grey scrollbar which clashes with any
              theme and especially looks out of place against the panel
              tokens we use everywhere else. */}
          <div className="flex-1 min-h-0 overflow-y-auto hairline-scrollbar px-6 py-4 space-y-4">
            {TOS_SECTIONS.map(s => (
              <section key={s.title}>
                <h3
                  className="text-sm font-bold mb-1"
                  style={{ color: "var(--ats-fg-primary)" }}
                >
                  {s.title}
                </h3>
                <p
                  className="text-xs leading-relaxed"
                  style={{ color: "var(--ats-fg-secondary)" }}
                >
                  {s.body}
                </p>
              </section>
            ))}
            <p
              className="text-[10px] italic pt-2 border-t"
              style={{
                color:       "var(--ats-fg-muted)",
                borderColor: "var(--ats-border-subtle)",
              }}
            >
              By clicking{" "}
              <span className="font-semibold" style={{ color: "var(--ats-fg-accent)" }}>
                Accept and continue
              </span>{" "}
              below, you confirm you are at least 13 years old and agree to these terms. If you do not agree, please close this tab — we will not record any further activity for your account.
            </p>
          </div>

          {/* Footer with checkbox + CTAs */}
          <div
            className="px-6 py-4 border-t space-y-3"
            style={{ borderColor: "var(--ats-border-subtle)" }}
          >
            <label className="flex items-start gap-2 cursor-pointer">
              {/* Styled checkbox — uses accent token so the tick colour
                  follows the active theme. Hidden native box + custom
                  rendered square so we can paint it with var(--ats-*). */}
              <span
                className="relative mt-0.5 h-4 w-4 shrink-0 inline-flex items-center justify-center rounded border"
                style={{
                  backgroundColor: agreed ? "var(--ats-bg-accent-soft)" : "transparent",
                  borderColor:     agreed ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                  transition:      "all 120ms ease",
                }}
              >
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  aria-label="Agree to terms"
                />
                {agreed && <Check size={12} style={{ color: "var(--ats-fg-accent)" }} strokeWidth={3} />}
              </span>
              <span
                className="text-xs leading-snug"
                style={{ color: "var(--ats-fg-secondary)" }}
              >
                I have read and agree to the Terms of Service (version {status.current_version}) and the data practices described above.
              </span>
            </label>
            {error && (
              <p
                className="text-[11px] inline-flex items-center gap-1.5 rounded-md px-2 py-1 border"
                style={{
                  color:           "#ef4444",
                  backgroundColor: "rgba(239, 68, 68, 0.08)",
                  borderColor:     "rgba(239, 68, 68, 0.35)",
                }}
              >
                <AlertCircle size={12} />
                {error}. Please check your connection and try again.
              </p>
            )}
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  // Sign out path — if the user doesn't agree, let them
                  // leave cleanly. We don't record anything server-side
                  // about the decline itself.
                  if (confirm("Exit without agreeing? You'll be signed out.")) {
                    try { window.location.href = "/login"; } catch { /* ignore */ }
                  }
                }}
                className="inline-flex items-center gap-1 text-[11px] transition-colors hover:brightness-125"
                style={{ color: "var(--ats-fg-muted)" }}
              >
                <X size={12} />
                I don&apos;t agree
              </button>
              <button
                type="button"
                onClick={() => void handleAccept()}
                disabled={!agreed || submitting}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold transition-all border disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
                style={{
                  backgroundColor: agreed ? "var(--ats-bg-accent-soft)" : "var(--ats-bg-panel)",
                  color:           agreed ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
                  borderColor:     agreed ? "var(--ats-border-accent)" : "var(--ats-border-subtle)",
                }}
              >
                {submitting ? (
                  <>
                    <span
                      className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"
                      aria-hidden
                    />
                    Saving…
                  </>
                ) : (
                  <>
                    <Check size={14} strokeWidth={3} />
                    Accept and continue
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
