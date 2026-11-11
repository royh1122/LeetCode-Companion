import { NextResponse, type NextRequest } from "next/server";

/**
 * Local-only security boundary.
 *  1. Host header must be loopback → blocks DNS-rebinding attacks.
 *  2. /api/ext/*: only the browser extension (chrome-extension:// origin, or no
 *     Origin) — plus a bearer token checked in the route. No CORS headers are
 *     ever sent, so ordinary websites can neither read responses nor pass a
 *     preflight for the Authorization header.
 *  3. Other /api/*: same-origin dashboard requests only.
 * Server actions are separately origin-checked by Next.js.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (!LOOPBACK.has(hostname)) return new NextResponse("Forbidden host", { status: 403 });

  const path = req.nextUrl.pathname;
  const origin = req.headers.get("origin");
  if (path.startsWith("/api/ext/")) {
    if (req.method === "OPTIONS") return new NextResponse(null, { status: 403 });
    if (origin && !origin.startsWith("chrome-extension://")) return new NextResponse("Forbidden origin", { status: 403 });
    return NextResponse.next();
  }
  if (path.startsWith("/api/")) {
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return new NextResponse("Cross-site request blocked", { status: 403 });
    if (origin) {
      try {
        if (new URL(origin).host !== host) return new NextResponse("Forbidden origin", { status: 403 });
      } catch {
        return new NextResponse("Forbidden origin", { status: 403 });
      }
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
