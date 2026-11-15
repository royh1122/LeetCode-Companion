import { NextResponse, type NextRequest } from "next/server";

/**
 * Local-only security boundary.
 *  1. Host header must be loopback → blocks DNS-rebinding attacks.
 *  2. /api/ext/*: only the browser extension (chrome-extension:// origin, or no
 *     Origin) — plus a bearer token checked in the route. No CORS headers are
 *     ever sent, so ordinary websites can neither read responses nor pass a
 *     preflight for the Authorization header.
 *  3. Other /api/*: same-origin dashboard requests only.
 *  4. Pages: from another site, only top-level navigations (a link), never subresources
 *     (images, scripts, frames), since rendering a page can change state.
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
  const site = req.headers.get("sec-fetch-site");
  const foreign = !!site && site !== "same-origin" && site !== "none";
  if (!path.startsWith("/api/")) {
    // Pages: another site may link to the dashboard (a top-level navigation), but not load a page
    // as an image, script or frame. Rendering a page can change things (opening Today plans the day).
    const navigation = req.headers.get("sec-fetch-mode") === "navigate" && (req.headers.get("sec-fetch-dest") ?? "document") === "document";
    if (foreign && !navigation) return new NextResponse("Cross-site request blocked", { status: 403 });
    return NextResponse.next();
  }
  // Other API routes: this dashboard's own pages only.
  if (foreign) return new NextResponse("Cross-site request blocked", { status: 403 });
  if (origin) {
    try {
      if (new URL(origin).host !== host) return new NextResponse("Forbidden origin", { status: 403 });
    } catch {
      return new NextResponse("Forbidden origin", { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
