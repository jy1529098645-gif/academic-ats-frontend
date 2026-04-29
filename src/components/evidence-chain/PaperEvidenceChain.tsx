// ─────────────────────────────────────────────────────────────────────────────
// PaperEvidenceChain — per-paper claim breakdown shown under the abstract
//
// What this is:
//   Per-paper claim breakdown: "what is THIS paper specifically
//   claiming, with what strength of evidence?" — shown under the
//   abstract as a collapsible section.
//
// Data source:
//   paper.claims is populated server-side by claim_extraction (Curated only).
//   Streamed in via the `claim_batch` SSE event as each paper finishes.
//   Quick mode never populates this; the component returns null and the
//   paper card looks identical to the pre-feature UI.
//
// UX:
//   • Default collapsed — the abstract should still be the dominant
//     surface. A user opening the section is a deliberate "tell me more"
//     gesture, not noise.
//   • Each claim row carries the support-level chip (strong / moderate /
//     weak), the claim text, and a small evidence-basis line below.
//   • Strong claims float to the top so the most-citable findings are
//     immediately visible when expanded.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PaperClaim } from "@/lib/types";

const SUPPORT_RANK: Record<string, number> = {
  strong:   0,
  moderate: 1,
  weak:     2,
};

const SUPPORT_BG: Record<string, string> = {
  strong:   "rgba(34, 197, 94, 0.20)",
  moderate: "rgba(245, 158, 11, 0.20)",
  weak:     "rgba(148, 163, 184, 0.18)",
};

const SUPPORT_FG: Record<string, string> = {
  strong:   "rgb(22, 163, 74)",
  moderate: "rgb(217, 119, 6)",
  weak:     "rgb(100, 116, 139)",
};

const TYPE_LABELS: Record<string, string> = {
  finding:    "Finding",
  method:     "Method",
  framing:    "Framing",
  limitation: "Limitation",
};

type Props = {
  claims:           PaperClaim[] | undefined;
  /** Optional default-open. Useful if the parent wants a per-card sticky
   *  expanded state later — for MVP we don't pass this in. */
  defaultExpanded?: boolean;
};

export default function PaperEvidenceChain({ claims, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // No claims yet → render nothing. Curated mode papers get them
  // streamed in via the claim_batch SSE event a few seconds after
  // the paper card first appears, so the section will pop in once
  // the data lands. Quick mode never populates this.
  if (!claims || claims.length === 0) return null;

  // Sort by support level (strong → moderate → weak), keeping
  // original order within the same level. Lets the most-citable
  // claims surface first when the user expands the section.
  const sorted = [...claims].sort((a, b) => {
    const ra = SUPPORT_RANK[(a.support_level || "weak").toLowerCase()] ?? 9;
    const rb = SUPPORT_RANK[(b.support_level || "weak").toLowerCase()] ?? 9;
    return ra - rb;
  });

  return (
    <div
      className="mt-2 rounded-lg border"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-input)",
      }}
    >
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--ats-bg-section)] rounded-lg transition-colors"
        type="button"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold"
              style={{ color: "var(--ats-fg-secondary)" }}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>Evidence Chain</span>
          <span style={{ color: "var(--ats-fg-muted)" }}>
            · {claims.length} claim{claims.length !== 1 ? "s" : ""}
          </span>
        </span>
        {/* Strength badge summary (e.g. "2 strong · 1 moderate"). Gives
            the user a one-glance signal of the paper's claim strength
            BEFORE they expand. */}
        <StrengthSummary claims={claims} />
      </button>

      {expanded ? (
        <ul className="px-3 pb-3 pt-1 space-y-2.5">
          {sorted.map((claim, idx) => (
            <ClaimRow key={idx} claim={claim} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────────

function StrengthSummary({ claims }: { claims: PaperClaim[] }) {
  let strong = 0, moderate = 0, weak = 0;
  for (const c of claims) {
    const s = (c.support_level || "weak").toLowerCase();
    if      (s === "strong")   strong   += 1;
    else if (s === "moderate") moderate += 1;
    else                       weak     += 1;
  }

  const parts: string[] = [];
  if (strong   > 0) parts.push(`${strong} strong`);
  if (moderate > 0) parts.push(`${moderate} mod`);
  if (weak     > 0) parts.push(`${weak} weak`);

  return (
    <span
      className="text-[10px]"
      style={{ color: "var(--ats-fg-muted)" }}
    >
      {parts.join(" · ")}
    </span>
  );
}


function ClaimRow({ claim }: { claim: PaperClaim }) {
  const supportLevel = (claim.support_level || "weak").toLowerCase();
  const claimType    = (claim.claim_type    || "finding").toLowerCase();

  return (
    <li
      className="border-l-2 pl-3"
      style={{ borderColor: SUPPORT_FG[supportLevel] ?? SUPPORT_FG.weak }}
    >
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span
          className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: SUPPORT_BG[supportLevel] ?? SUPPORT_BG.weak,
            color:           SUPPORT_FG[supportLevel] ?? SUPPORT_FG.weak,
          }}
        >{supportLevel}</span>
        {TYPE_LABELS[claimType] ? (
          <span
            className="text-[9px] uppercase tracking-wider"
            style={{ color: "var(--ats-fg-muted)" }}
          >{TYPE_LABELS[claimType]}</span>
        ) : null}
      </div>

      <div
        className="text-[11px] leading-relaxed mb-1"
        style={{ color: "var(--ats-fg-primary)" }}
      >
        {claim.claim_text}
      </div>

      {claim.evidence_basis ? (
        <div
          className="text-[10px] leading-relaxed"
          style={{ color: "var(--ats-fg-secondary)" }}
        >
          <span className="font-semibold">Basis:</span> {claim.evidence_basis}
        </div>
      ) : null}

      {claim.scope_note ? (
        <div
          className="text-[10px] leading-relaxed mt-0.5 italic"
          style={{ color: "var(--ats-fg-muted)" }}
        >
          {claim.scope_note}
        </div>
      ) : null}
    </li>
  );
}
