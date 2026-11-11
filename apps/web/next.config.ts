import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  transpilePackages: ["@lcc/shared", "@lcc/scheduler", "@lcc/db"],
  serverExternalPackages: ["better-sqlite3"],
  turbopack: { root: path.join(import.meta.dirname, "..", "..") },
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  experimental: {
    serverActions: { bodySizeLimit: "25mb", allowedOrigins: ["127.0.0.1:4317", "localhost:4317"] },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;
