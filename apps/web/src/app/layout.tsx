import "./globals.css";
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { getPageMode } from "@/lib/page-session";
import { t } from "@/strings";

// Self-hosted at build time by next/font (no third-party request at runtime); latin-ext covers German
// counterparty names. `adjustFontFallback` sizes the fallback to match, so the swap causes no CLS.
const sans = IBM_Plex_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-plex-sans",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-mono",
});

// M4-05: a replay session's page titles say it is a recording ("Queue · Recording · Carnet").
export async function generateMetadata(): Promise<Metadata> {
  const mode = await getPageMode();
  const suffix = mode?.mode === "replay" ? ` · ${t.replay.titleSuffix}` : "";
  return {
    title: { default: `${t.app.name}${suffix}`, template: `%s${suffix} · ${t.app.name}` },
    description: t.app.description,
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1e24" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request: Next.js puts the proxy's CSP nonce on its scripts only during a
  // request-time render (M1-10, lib/security-headers.ts). A prerendered page would have none.
  await connection();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
