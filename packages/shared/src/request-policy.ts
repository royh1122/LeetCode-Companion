/**
 * The dashboard's request boundary, as a pure function (apps/web/src/proxy.ts is a thin wrapper).
 *  1. Host must be loopback, or one of the server-mode hosts → blocks DNS rebinding. An
 *     X-Forwarded-Host (from a local reverse proxy such as Tailscale Serve or Caddy) must pass the
 *     same test; it then counts as the address the browser used.
 *  2. /api/ext/*: only the browser extension (chrome-extension:// origin, or no Origin), plus a
 *     bearer token checked in the route. No CORS headers are ever sent, so ordinary websites can
 *     neither read responses nor pass a preflight for the Authorization header.
 *  3. Other /api/*: the dashboard's own pages only.
 *  4. Pages: from another site, only top-level navigations (a link), never subresources (images,
 *     scripts, frames), since rendering a page can change state.
 * Server actions are separately origin-checked by Next.js (serverActions.allowedOrigins).
 */
import { isAllowedHost, isConfiguredHost, type ServerConfig } from "./server-config";

export interface RequestFacts {
  host: string;
  path: string;
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  secFetchMode: string | null;
  secFetchDest: string | null;
  forwardedHost: string | null;
}

export type RequestVerdict = { allow: true } | { allow: false; status: 403; reason: string };

const deny = (reason: string): RequestVerdict => ({ allow: false, status: 403, reason });
const ALLOW: RequestVerdict = { allow: true };

/** First value of a possibly comma-separated forwarded header. */
const firstForwarded = (v: string | null | undefined): string | null => v?.split(",")[0]?.trim() || null;

export function decideRequest(req: RequestFacts, config: ServerConfig): RequestVerdict {
  if (!isAllowedHost(req.host, config)) return deny("Forbidden host");
  const forwarded = firstForwarded(req.forwardedHost);
  if (forwarded && !isAllowedHost(forwarded, config)) return deny("Forbidden host");
  // The address the browser used: the forwarded one behind a local proxy, else Host.
  const effectiveHost = (forwarded ?? req.host).toLowerCase();

  const origin = req.origin;
  if (req.path.startsWith("/api/ext/")) {
    if (req.method === "OPTIONS") return deny("Forbidden");
    if (origin && !origin.startsWith("chrome-extension://")) return deny("Forbidden origin");
    return ALLOW;
  }
  const site = req.secFetchSite;
  const foreign = !!site && site !== "same-origin" && site !== "none";
  if (!req.path.startsWith("/api/")) {
    const navigation = req.secFetchMode === "navigate" && (req.secFetchDest ?? "document") === "document";
    if (foreign && !navigation) return deny("Cross-site request blocked");
    return ALLOW;
  }
  // Other API routes: this dashboard's own pages only.
  if (foreign) return deny("Cross-site request blocked");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return deny("Forbidden origin");
    }
    // Same origin, or a server-mode address (a proxy may rewrite Host to 127.0.0.1:port).
    if (originHost !== effectiveHost && !isConfiguredHost(originHost, config)) return deny("Forbidden origin");
  }
  return ALLOW;
}

/**
 * The dashboard's own base URL as the browser sees it (for hints shown to the extension and the
 * pairing dialog). Forwarded proto/host are used only if the request passed decideRequest.
 */
export function effectiveBaseUrl(host: string, forwardedHost: string | null, forwardedProto: string | null, config: ServerConfig): string {
  const fh = firstForwarded(forwardedHost);
  const h = fh && isAllowedHost(fh, config) ? fh : host || "127.0.0.1:4317";
  const fp = firstForwarded(forwardedProto);
  const proto = fp === "https" || fp === "http" ? fp : "http";
  return `${proto}://${h}`;
}
