import { resolve } from "node:path";
import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security-headers";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@carnet/domain", "@carnet/db", "@carnet/airwallex", "@carnet/agent"],
  poweredByHeader: false,
  // `forbidden()` answers 403 from a page (a viewer on /ops, M1-09).
  experimental: { authInterrupts: true },
  // Fixed security headers on every path (M1-10); the CSP with its nonce comes from src/proxy.ts.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: staticSecurityHeaders({ production: process.env.NODE_ENV === "production" }),
      },
      // The payee status page (M3-06) sends no referrer at all, so a token in the path cannot leak
      // to a third party. The route also sets this on every response it builds.
      {
        source: "/status/:token",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
