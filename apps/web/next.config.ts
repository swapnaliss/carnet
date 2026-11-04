import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@carnet/domain", "@carnet/db", "@carnet/airwallex", "@carnet/agent"],
  poweredByHeader: false,
  // `forbidden()` answers 403 from a page (a viewer on /ops, M1-09).
  experimental: { authInterrupts: true },
};

export default config;
