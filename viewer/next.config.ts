import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Bundle Shiki: the portable npm runtime relocates external dependencies.
  transpilePackages: ["shiki"],
  outputFileTracingRoot: path.join(__dirname, ".."),
  experimental: { externalDir: true },
  webpack(config) {
    config.resolve.alias["@harness/local-result-store"] = path.join(
      __dirname,
      "../harness/lib/local-result-store-reader.mjs",
    );
    config.resolve.alias["@harness/postgres-result-store-reader"] = path.join(
      __dirname,
      "../harness/postgres-result-store-reader.mjs",
    );
    return config;
  },
  turbopack: {
    root: path.join(__dirname, ".."),
    resolveAlias: {
      "@harness/local-result-store": "../harness/lib/local-result-store-reader.mjs",
      "@harness/postgres-result-store-reader": "../harness/postgres-result-store-reader.mjs",
    },
  },
};
export default nextConfig;
