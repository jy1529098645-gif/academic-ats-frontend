import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AcademiCats",
  description: "Where every question finds its sources.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Page-level translation is re-enabled — Google Translate can freely translate
  // static copy (titles, labels, sidebar, Settings panels, etc.). The volatile
  // regions that React re-renders streaming tokens into (Research Brief, agent
  // logs, Lab output, textarea overlay, history timeline) opt out individually
  // via `translate="no"` + `notranslate` class to avoid the DOM-rewrite crash.
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden flex flex-col">{children}</body>
    </html>
  );
}
