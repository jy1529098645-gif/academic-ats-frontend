// Dynamic 1200×630 social-share banner.
//
// Why this exists: the previous OG image was the 1:1 mascot at
// public/Cats_01.png. Modern social previews (iMessage, Slack, Twitter)
// render `summary_large_image` cards — a tiny 1:1 thumbnail next to the
// title gets ~2-3x lower CTR than a proper 1200×630 banner with brand
// + tagline visible. Since this is the traffic-acquisition tier, every
// shared link matters.
//
// ImageResponse from next/og rasterises a small JSX subtree to PNG at
// build time (or on demand for dynamic routes). The cost is one extra
// build step; the payoff is a real social card without committing a
// design asset to the repo. Iterating on copy / colours is a code edit,
// not a Figma round-trip.
//
// File convention: a default-exported function in app/opengraph-image.tsx
// auto-injects <meta property="og:image"> on every route. See
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/opengraph-image.md
//
// CSS notes:
//   ImageResponse supports a tight subset of CSS. Flexbox works; grid
//   doesn't. Always set explicit `display: 'flex'` on any container
//   with multiple children (the renderer throws "expected display:flex"
//   otherwise — common footgun). Avoid `gap` on items; pad manually.

import { ImageResponse } from "next/og";

export const alt         = "AcademiCats — research, brief, and writing in minutes";
export const size        = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width:           "100%",
          height:          "100%",
          display:         "flex",
          flexDirection:   "column",
          justifyContent:  "space-between",
          padding:         "80px 100px",
          // Brand-leaning dark gradient — matches the night-mode palette
          // most of the app uses, so a recipient seeing the card and
          // then opening the site feels visual continuity.
          background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 60%, #4c1d95 100%)",
          color: "#f8fafc",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        }}
      >
        {/* Header row — wordmark + small mascot-equivalent dot.  No external
            asset (deliberate: keeping the OG generator dependency-free so
            it can't break the build on a missing file). */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              background: "linear-gradient(135deg, #a78bfa, #60a5fa)",
              marginRight: 28,
              display: "flex",
            }}
          />
          <div
            style={{
              fontSize: 44,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              display: "flex",
            }}
          >
            AcademiCats
          </div>
        </div>

        {/* Tagline — the single line a cold recipient will actually
            read.  Matches the metadata.description. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.08,
              letterSpacing: "-0.025em",
              maxWidth: 920,
              display: "flex",
            }}
          >
            From research to writing — in minutes, not days.
          </div>
          <div
            style={{
              marginTop: 36,
              fontSize: 28,
              color: "#cbd5e1",
              display: "flex",
            }}
          >
            Multi-agent academic search, brief generation, and peer-review-style critique.
          </div>
        </div>

        {/* Footer row — URL hint, no link click happens from the image
            itself but it gives the recipient a recognisable destination. */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 22,
            color: "#94a3b8",
          }}
        >
          <div style={{ display: "flex" }}>academicats.com</div>
          <div style={{ display: "flex" }}>Free public beta</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
