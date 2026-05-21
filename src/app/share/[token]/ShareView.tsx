"use client";

// Client component that renders the actual shared-brief UI. Separated
// from page.tsx because react-markdown is a client lib (uses internal
// state via hooks), and the page-level component is async for the SSR
// fetch / metadata flow. Pure presentation here — every piece of data
// arrives as a prop.
//
// Visual goal: looks like a published article, not the in-app editing
// surface. No textareas, no quota chips, no save buttons — just the
// brief + the paper list + a single "Try AcademiCats" CTA at the
// bottom so recipients who like what they see have a clear next step.

import Link from "next/link";
import ReactMarkdown from "react-markdown";

export type SharedPaper = {
  title?:                 string;
  authors?:               string[] | string;
  year?:                  number | string;
  doi?:                   string;
  url?:                   string;
  summary?:               string;
  recommendation_reason?: string;
  venue?:                 string;
};

export type SharedBrief = {
  id:                  string;
  title:               string;
  original_query:      string;
  final_search_query:  string;
  brief:               string;
  papers:              SharedPaper[];
  created_at?:         string;
};

export default function ShareView({ data }: { data: SharedBrief }) {
  const created = data.created_at ? new Date(data.created_at) : null;
  // The root layout (app/layout.tsx) sets `body { overflow: hidden; flex
  // flex-col; h-full }` to give the desktop workspace a fixed-viewport
  // SPA shell with its own internal scroll panes. That's wrong for
  // the share page, which is a long-form static article that needs
  // normal document scroll. The fix: take the parent's full height as
  // a flex child (h-full inside the flex-col body) and own our own
  // overflow-y so the article scrolls inside this element instead of
  // requiring the body to scroll. We DON'T mutate document.body style
  // — that would leak into a back-navigation to the workspace.
  return (
    <main className="h-full overflow-y-auto bg-slate-50 text-slate-900">
      {/* Header ribbon — minimal brand pill + "Shared brief" badge so
          the recipient knows this is a curated artefact, not the
          interactive app.  The Try-the-app link sits in the corner so
          it's visible without competing with the content. */}
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-3 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 group">
            <span className="inline-block h-7 w-7 rounded-full bg-gradient-to-br from-violet-400 to-blue-400" />
            <span className="font-bold tracking-tight text-slate-900 group-hover:text-violet-700 transition-colors">
              AcademiCats
            </span>
          </Link>
          <span className="ml-2 text-[10px] uppercase tracking-wider font-semibold rounded-full bg-violet-100 text-violet-700 px-2 py-0.5">
            Shared brief
          </span>
          <Link
            href="/"
            className="ml-auto text-xs font-semibold text-violet-700 hover:text-violet-900 transition-colors"
          >
            Try AcademiCats →
          </Link>
        </div>
      </header>

      <article className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-bold leading-tight mb-2 text-slate-900">
          {data.title}
        </h1>
        {data.original_query && data.original_query !== data.title && (
          <p className="text-sm text-slate-500 mb-1">
            Original query: <span className="italic">{data.original_query}</span>
          </p>
        )}
        {created && (
          <p className="text-xs text-slate-400 mb-6">
            Brief generated {created.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
          </p>
        )}

        {/* Brief body — uses the same minimal markdown subset the
            in-app brief renders (headings, paragraphs, lists, bold /
            italic). prose-styled for comfortable reading at the
            visitor's first impression. */}
        <div className="prose prose-slate max-w-none prose-headings:font-bold prose-p:leading-7">
          <ReactMarkdown>{data.brief || "_(This brief has no body content.)_"}</ReactMarkdown>
        </div>

        {/* Paper list — slim cards so the reader can scan citations
            without scrolling forever.  Each card links to the paper's
            URL/DOI when present so the brief stays useful even if
            the brief markdown didn't inline the link. */}
        {data.papers.length > 0 && (
          <section className="mt-12 pt-8 border-t border-slate-200">
            <h2 className="text-lg font-bold mb-4 text-slate-900">
              Cited papers ({data.papers.length})
            </h2>
            <ul className="space-y-3">
              {data.papers.slice(0, 30).map((p, i) => {
                const href = p.url || (p.doi ? `https://doi.org/${p.doi}` : "");
                const authors = Array.isArray(p.authors) ? p.authors.join(", ") : (p.authors || "");
                return (
                  <li key={i} className="rounded-lg border border-slate-200 bg-white p-4">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-slate-900 hover:text-violet-700">
                        {p.title || "(untitled paper)"}
                      </a>
                    ) : (
                      <span className="text-sm font-semibold text-slate-900">{p.title || "(untitled paper)"}</span>
                    )}
                    <p className="text-xs text-slate-500 mt-0.5">
                      {[authors, p.venue, p.year].filter(Boolean).join(" · ")}
                    </p>
                    {(p.recommendation_reason || p.summary) && (
                      <p className="text-sm text-slate-700 mt-2 leading-relaxed">
                        {p.recommendation_reason || p.summary}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {data.papers.length > 30 && (
              <p className="text-xs text-slate-400 mt-3 italic">
                Showing the first 30 of {data.papers.length} cited papers.
              </p>
            )}
          </section>
        )}

        {/* Footer CTA — only call-to-action on the page so it doesn't
            compete with the brief for attention.  Same gradient the
            OG card uses so a visitor arriving from a social preview
            feels visual continuity. */}
        <footer className="mt-16 rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-violet-900 text-slate-100 p-8 text-center">
          <h2 className="text-xl font-bold mb-1">Want a brief like this on your topic?</h2>
          <p className="text-sm text-slate-300 mb-4">
            From research to writing — in minutes, not days.
          </p>
          <Link
            href="/"
            className="inline-block rounded-lg bg-violet-500 hover:bg-violet-400 transition-colors px-5 py-2.5 text-sm font-bold text-white"
          >
            Try AcademiCats free
          </Link>
        </footer>
      </article>
    </main>
  );
}
