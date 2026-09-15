import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  experimental: { externalDir: true },
  turbopack: {
    root: path.join(__dirname, ".."),
    resolveAlias: {
      "@harness/local-result-store": "../harness/lib/local-result-store-reader.mjs",
      "@harness/postgres-result-store-reader": "../harness/postgres-result-store-reader.mjs",
    },
  },
};
export default nextConfig;
