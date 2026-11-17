import type { NextConfig } from "next";
import path from "node:path";
import { parseServerConfig } from "../../packages/shared/src/server-config";

const dev = process.env.NODE_ENV !== "production";

// Server mode (LCC_ALLOWED_HOSTS / LCC_LISTEN, set by `npm run up` from data/server.json or by
// Docker). Parsing here means invalid values stop the server at start.
const server = parseServerConfig(null, { LCC_ALLOWED_HOSTS: process.env.LCC_ALLOWED_HOSTS, LCC_LISTEN: process.env.LCC_LISTEN });

/**
 * Content-Security-Policy. Next.js inlines its own scripts and there is no nonce set-up, so
 * scripts allow 'unsafe-inline'; the real gain is elsewhere: nothing is loaded from or sent to
 * another host (connect-src 'self' stops a script from shipping notes or code anywhere), no
 * plugins, no foreign forms or <base>, and no framing. Dev mode also needs eval and the HMR socket.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  transpilePackages: ["@lcc/shared", "@lcc/scheduler", "@lcc/db"],
  serverExternalPackages: ["better-sqlite3"],
  turbopack: { root: path.join(import.meta.dirname, "..", "..") },
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  experimental: {
    // Server mode hosts are added at start (next start reads this file), so a proxy that rewrites
    // Host (Tailscale Serve, Caddy) still passes Next's own server-action origin check.
    serverActions: { bodySizeLimit: "25mb", allowedOrigins: ["127.0.0.1:4317", "localhost:4317", ...server.hosts] },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default config;
