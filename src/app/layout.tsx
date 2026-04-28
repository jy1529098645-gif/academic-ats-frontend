import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import MaintenanceGate from "@/components/MaintenanceGate";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // `template` lets nested routes (e.g. /admin) override just the leaf
  // and still get the "AcademiCats · Admin" suffix shape. `default` is
  // what shows on the bare landing.
  title: {
    default:  "AcademiCats",
    template: "%s · AcademiCats",
  },
  description: "An academic assistant for structuring and verifying thought.",
  // OpenGraph / Twitter card meta so a link share to Slack, Twitter, or
  // iMessage renders with the mascot card instead of a generic Next.js
  // preview. Image is the existing landing mascot — it's the asset
  // every cold visitor already sees.
  openGraph: {
    title:       "AcademiCats",
    description: "An academic assistant for structuring and verifying thought.",
    type:        "website",
    siteName:    "AcademiCats",
    images: [{ url: "/Cats_01.png", alt: "AcademiCats mascot" }],
  },
  twitter: {
    card:        "summary",
    title:       "AcademiCats",
    description: "An academic assistant for structuring and verifying thought.",
    images:      ["/Cats_01.png"],
  },
  // Tells Next to honour the public/robots.txt we ship rather than the
  // framework default (no robots directive). The policy lives in
  // public/robots.txt — see comments there.
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Page-level translation is re-enabled — Google Translate can freely translate
  // the whole app, including the Research Brief (previously gated because we
  // worried the streaming markdown diff would collide with Google's DOM
  // rewrite, which turned out not to happen in practice). A few remaining
  // volatile regions (textarea overlay, Lab result, history timeline, agent
  // logs) still opt out individually via `translate="no"` + `notranslate`
  // because their mid-render DOM churn IS sensitive to external rewrites —
  // the in-app Translate button is the higher-quality path for those.
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden flex flex-col">
        {/* MaintenanceGate polls /api/maintenance and renders a full-screen
            overlay when the dev has flipped system_maintenance.enabled=true
            in Supabase. Paths starting with /admin, /login, /api are
            exempt so admins can still unblock the flag while in the
            maintenance window. */}
        <MaintenanceGate>{children}</MaintenanceGate>
      </body>
    </html>
  );
}
