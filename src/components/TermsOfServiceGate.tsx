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
import { buildApiUrl, fetchWithAuth } from "@/lib/api";

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

const TOS_SECTIONS: Array<{ title: string; body: string }> = [
  {
    title: "1. What AcademiCats is",
    body:
      "AcademiCats is an AI-assisted academic research assistant. It helps you discover relevant papers from open-access databases (Semantic Scholar, OpenAlex, Crossref, arXiv, PubMed, and others), synthesises those papers into research briefs, and offers deep-read / translation tools for individual PDFs. The service is provided as-is during the Alpha testing period; features and limits may change without notice.",
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
        className="fixed inset-0 z-[9500] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tos-title"
      >
        <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-800">
            <div className="flex items-center gap-2 mb-1">
              <span aria-hidden className="text-xl">📜</span>
              <h2 id="tos-title" className="text-lg font-bold text-slate-100">
                {isReAcceptance ? "Terms of Service updated" : "Welcome — a quick agreement"}
              </h2>
            </div>
            <p className="text-[11px] text-slate-400">
              {isReAcceptance
                ? `We've updated our terms since you last accepted (v${status.accepted_version} → v${status.current_version}). Please review the changes and agree to continue using AcademiCats.`
                : `Before you start, please read and agree to our Terms of Service. Version ${status.current_version} · takes about 90 seconds.`}
            </p>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
            {TOS_SECTIONS.map(s => (
              <section key={s.title}>
                <h3 className="text-sm font-bold text-slate-200 mb-1">{s.title}</h3>
                <p className="text-xs text-slate-300 leading-relaxed">{s.body}</p>
              </section>
            ))}
            <p className="text-[10px] text-slate-500 italic pt-2 border-t border-slate-800">
              By clicking <span className="font-semibold">Accept and continue</span> below, you confirm you are at least 13 years old and agree to these terms. If you do not agree, please close this tab — we will not record any further activity for your account.
            </p>
          </div>

          {/* Footer with checkbox + CTAs */}
          <div className="px-6 py-4 border-t border-slate-800 space-y-3">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-blue-500"
              />
              <span className="text-xs text-slate-200 leading-snug">
                I have read and agree to the Terms of Service (version {status.current_version}) and the data practices described above.
              </span>
            </label>
            {error && (
              <p className="text-[11px] text-rose-400">
                {error}. Please check your connection and try again.
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <a
                href="/login"
                className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
                onClick={(e) => {
                  // Sign out path — if the user doesn't agree, let them
                  // leave cleanly. We don't record anything server-side
                  // about the decline itself.
                  e.preventDefault();
                  if (confirm("Exit without agreeing? You'll be signed out.")) {
                    try { window.location.href = "/login"; } catch { /* ignore */ }
                  }
                }}
              >
                I don&apos;t agree
              </a>
              <button
                type="button"
                onClick={() => void handleAccept()}
                disabled={!agreed || submitting}
                className="rounded-lg px-4 py-2 text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: agreed ? "#3b82f6" : "#475569" }}
              >
                {submitting ? "Saving…" : "Accept and continue"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
