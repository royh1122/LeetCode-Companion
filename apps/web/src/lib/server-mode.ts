import { parseServerConfig, type ServerConfig } from "@lcc/shared";

let cached: ServerConfig | undefined;

/**
 * Server mode settings for this process, from LCC_ALLOWED_HOSTS / LCC_LISTEN (set by `npm run up`
 * from data/server.json, or by Docker). next.config.ts parses the same env at start, so invalid
 * values stop the server before any request reaches this.
 */
export function serverConfig(): ServerConfig {
  cached ??= parseServerConfig(null, { LCC_ALLOWED_HOSTS: process.env.LCC_ALLOWED_HOSTS, LCC_LISTEN: process.env.LCC_LISTEN });
  return cached;
}
