// ─────────────────────────────────────────────────────────────────────────────
// tos-content.ts — SINGLE source of truth for the Terms of Service doc.
//
// The same 7-section body is rendered in three places:
//   1. TermsOfServiceGate   — post-login gate with an Accept checkbox
//   2. userPanel="legal"    — post-login read-only view from the user menu
//   3. Login page "Terms"   — pre-login read-only view from the sign-in card
//
// This mirrors what mainstream products do (GitHub, Discord, Notion, Stripe,
// etc.): ONE doc, three UI surroundings. The only difference between a
// read-only view and the gate is whether an Accept button is rendered.
//
// Version bumps (TOS_VERSION) force every returning user to re-accept via
// the gate, so every surface MUST import from this file — otherwise a
// legacy copy in another component silently drifts out of date.
// ─────────────────────────────────────────────────────────────────────────────

export const TOS_VERSION = "1.0";

// Product version — shown in the TOS header + Section 1 so users know
// exactly which build of the product they're agreeing to. Bump alongside
// TOS_VERSION when the product ships a materially different build.
export const APP_VERSION = "v1.7.1-Alpha";

export type TosSection = {
  title: string;
  body:  string;
};

export const TOS_SECTIONS: TosSection[] = [
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
