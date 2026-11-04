import { resolve } from "node:path";
import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security-headers";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@carnet/domain", "@carnet/db", "@carnet/airwallex", "@carnet/agent"],
  poweredByHeader: false,
  // Fixed security headers on every path (M1-10); the CSP with its nonce comes from src/proxy.ts.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: staticSecurityHeaders({ production: process.env.NODE_ENV === "production" }),
      },
    ];
  },
};

export default config;
