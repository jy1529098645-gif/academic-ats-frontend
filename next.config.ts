import type { NextConfig } from "next";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withBundleAnalyzer = require("@next/bundle-analyzer")({
  // Gated on env var so normal dev + prod builds are unchanged. Run
  // `ANALYZE=true npm run build` to produce HTML reports in `.next/analyze/`.
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  // Next.js 16 uses Turbopack by default — empty config silences the webpack warning
  turbopack: {},
};

export default withBundleAnalyzer(nextConfig);
