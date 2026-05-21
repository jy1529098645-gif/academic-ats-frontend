// Public read-only view of a brief whose owner has minted a share
// token. SSR'd so crawlers + social previews (Twitter, Slack, iMessage)
// can index real content + render dynamic OG cards, AND so a recipient
// who opens the link without JS still sees the brief.
//
// Lives under /share/[token] — the token is a 32-char hex uuid4 minted
// by POST /api/history/{id}/share. The backend enforces "token must be
// non-null" via row-level security; this page just hits the public
// GET endpoint and renders whatever comes back, with notFound() on 404.
//
// generateMetadata is the conversion hook: every shared link gets its
// own og:title (the search query) + og:description (the brief's
// summary) so the social preview is informative, not generic. Without
// this, every shared link rendered the same "AcademiCats" card.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { API_BASE_URL } from "@/lib/api";
import ShareView, { type SharedBrief } from "./ShareView";

// SSR data fetch — invoked by both generateMetadata and the page
// itself.  Cached by Next per (route, params) within the same request
// pass, so we don't double-hit the backend.  Cached for 60s at the
// fetch layer because shared briefs are immutable from the public
// reader's perspective (revoke = 404, content edits round-trip through
// the owner's auth'd UI).
async function loadShared(token: string): Promise<SharedBrief | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/share/${encodeURIComponent(token)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SharedBrief;
    if (!data || !data.id) return null;
    return data;
  } catch {
    return null;
  }
}

type Params = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  // Next 15+ ships `params` as a Promise; awaiting is the canonical
  // shape per the framework migration guide.
  const { token } = await params;
  const data = await loadShared(token);
  if (!data) {
    return {
      title:       "Shared brief not found · AcademiCats",
      description: "This shared brief is no longer available.",
      robots:      { index: false, follow: false },
    };
  }
  // Take the first paragraph (or the first ~180 chars) of the brief as
  // the description.  Strips markdown headings and lone hashes so the
  // social preview reads as prose, not as raw md.
  const firstPara = (data.brief || "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "").trim())
    .find((p) => p.length > 0) || data.original_query || "Shared academic brief";
  const desc = firstPara.length > 180 ? firstPara.slice(0, 177) + "…" : firstPara;
  const title = data.title || data.final_search_query || data.original_query || "Shared brief";
  return {
    title,
    description: desc,
    openGraph: {
      title,
      description: desc,
      type: "article",
      siteName: "AcademiCats",
    },
    twitter: {
      card:        "summary_large_image",
      title,
      description: desc,
    },
  };
}

export default async function Page({ params }: Params) {
  const { token } = await params;
  const data = await loadShared(token);
  if (!data) notFound();
  return <ShareView data={data} />;
}
